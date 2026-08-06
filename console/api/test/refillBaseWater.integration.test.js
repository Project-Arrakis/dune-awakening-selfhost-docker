import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { baseWater, refillBaseWater } from "../src/duneDb.js";

const { Pool } = pg;

// Mirrors generatorRefill.integration.test.js -- a throwaway real-Postgres
// database rather than a mock, because the behaviour under test (a guarded
// lateral join avoiding the ContainerInventory fan-out, and a jsonb_set that
// must touch water and never blood) is exactly the kind of thing a fake
// query layer would let pass silently wrong.

function connectionConfig(database = "dune") {
  if (process.env.ADMIN_DATABASE_URL) {
    const url = new URL(process.env.ADMIN_DATABASE_URL);
    url.pathname = `/${database}`;
    return { connectionString: url.toString() };
  }
  return {
    host: process.env.DUNE_DB_HOST || process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.DUNE_DB_PORT || process.env.PGPORT || process.env.POSTGRES_PORT || 15432),
    database,
    user: process.env.DUNE_DB_USER || process.env.PGUSER || "dune",
    password: process.env.DUNE_DB_PASSWORD || process.env.PGPASSWORD || "dune",
    connectionTimeoutMillis: 3000
  };
}

function transactionalDb(pool) {
  return {
    query: (text, values = []) => pool.query(text, values),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({ query: (text, values = []) => client.query(text, values) });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

test("real PostgreSQL refillBaseWater tops water to capacity, leaves blood untouched, and avoids the ContainerInventory fan-out", async (t) => {
  const admin = new Pool(connectionConfig());
  const database = `dune_water_refill_${process.pid}_${randomBytes(4).toString("hex")}`;
  let pool;
  try {
    await admin.query("select 1");
  } catch (error) {
    await admin.end().catch(() => {});
    if (process.env.CI) throw new Error(`PostgreSQL is required for the water refill test: ${error.message}`);
    t.skip(`PostgreSQL unavailable: ${error.message}`);
    return;
  }

  try {
    await admin.query(`create database "${database}"`);
  } catch (error) {
    await admin.end().catch(() => {});
    if (process.env.CI) throw new Error(`PostgreSQL must allow an isolated water refill test database: ${error.message}`);
    t.skip(`PostgreSQL cannot create an isolated test database: ${error.message}`);
    return;
  }

  try {
    pool = new Pool({ ...connectionConfig(database), max: 4 });
    await pool.query(`
      create schema dune;
      create table dune.buildings (id bigint primary key);
      create table dune.building_instances (building_id bigint not null, owner_entity_id bigint not null);
      create table dune.actor_fgl_entities (entity_id bigint not null, actor_id bigint not null, slot_name text);
      create table dune.placeables (id bigint primary key, owner_entity_id bigint not null, building_type text not null);
      create table dune.actors (id bigint primary key, properties jsonb not null default '{}'::jsonb);
      create table dune.fgl_entities (entity_id bigint primary key, components jsonb not null default '{}'::jsonb);

      insert into dune.buildings values (482);
      insert into dune.building_instances values (482, 100);
      insert into dune.actor_fgl_entities values (100, 200);

      -- A Water Cistern (capacity 5000), partially filled.
      insert into dune.placeables values (5001, 100, 'WaterCistern_Placeable');
      insert into dune.actors values (5001, '{}'::jsonb);
      insert into dune.fgl_entities values (9001, '{"FWaterStorageComponent": [0, {"m_WaterStored": 1250}]}'::jsonb);
      insert into dune.actor_fgl_entities values (5001, 9001, 'Actor');
      -- Same placeable also carries a ContainerInventory-slot entity with no
      -- water component -- the exact fan-out shape confirmed live on dune2.
      -- An unguarded join must not double the container or overwrite the
      -- wrong entity.
      insert into dune.fgl_entities values (9002, '{}'::jsonb);
      insert into dune.actor_fgl_entities values (5001, 9002, 'ContainerInventory');

      -- A Blood Purifier (water capacity 1000, blood capacity 6000), with
      -- both water and blood partially filled.
      insert into dune.placeables values (5002, 100, 'BloodWaterExtractor_Placeable');
      insert into dune.actors values (5002, '{"BP_BloodWaterExtractor_C": {"m_CurrentAmount": 3114.6}}'::jsonb);
      insert into dune.fgl_entities values (9003, '{"FWaterStorageComponent": [0, {"m_WaterStored": 200}]}'::jsonb);
      insert into dune.actor_fgl_entities values (5002, 9003, 'Actor');
    `);

    const db = transactionalDb(pool);

    const before = await baseWater(db, 482);
    const cisternBefore = before.containers.find((c) => c.type === "waterCistern");
    const bloodBefore = before.containers.find((c) => c.type === "bloodWaterExtractor");
    assert.equal(cisternBefore.stored, 1250);
    assert.equal(cisternBefore.count, 1);
    assert.equal(bloodBefore.stored, 200);
    assert.equal(bloodBefore.bloodStored, 3115); // rounded

    const result = await refillBaseWater(db, "", 482);
    assert.equal(result.ok, true);
    assert.equal(result.totalAdded, (5000 - 1250) + (1000 - 200));

    const after = await baseWater(db, 482);
    const cisternAfter = after.containers.find((c) => c.type === "waterCistern");
    const bloodAfter = after.containers.find((c) => c.type === "bloodWaterExtractor");
    assert.equal(cisternAfter.stored, 5000);
    // The fan-out guard means exactly one container, not two.
    assert.equal(cisternAfter.count, 1);
    assert.equal(bloodAfter.stored, 1000);
    // Blood is never touched by a refill -- only the water component.
    assert.equal(bloodAfter.bloodStored, 3115);

    const bloodProperty = await pool.query("select properties->'BP_BloodWaterExtractor_C'->>'m_CurrentAmount' as amount from dune.actors where id = 5002");
    assert.equal(Number(bloodProperty.rows[0].amount), 3114.6);

    // A second refill on an already-full base adds nothing.
    const again = await refillBaseWater(db, "", 482);
    assert.equal(again.totalAdded, 0);
  } finally {
    await pool?.end().catch(() => {});
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [database]
    ).catch(() => {});
    await admin.query(`drop database if exists "${database}"`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
