import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { refillBaseGenerators } from "../src/duneDb.js";

const { Pool } = pg;

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

test("real PostgreSQL serializes concurrent refills of an empty generator inventory", async (t) => {
  const admin = new Pool(connectionConfig());
  const database = `dune_refill_${process.pid}_${randomBytes(4).toString("hex")}`;
  let pool;
  try {
    await admin.query("select 1");
  } catch (error) {
    await admin.end().catch(() => {});
    if (process.env.CI) throw new Error(`PostgreSQL is required for the refill concurrency test: ${error.message}`);
    t.skip(`PostgreSQL unavailable: ${error.message}`);
    return;
  }

  try {
    await admin.query(`create database "${database}"`);
  } catch (error) {
    await admin.end().catch(() => {});
    if (process.env.CI) throw new Error(`PostgreSQL must allow an isolated refill test database: ${error.message}`);
    t.skip(`PostgreSQL cannot create an isolated test database: ${error.message}`);
    return;
  }

  try {
    pool = new Pool({ ...connectionConfig(database), max: 4 });
    await pool.query(`
      create schema dune;
      create table dune.buildings (id bigint primary key);
      create table dune.building_instances (building_id bigint not null, owner_entity_id bigint not null);
      create table dune.actor_fgl_entities (entity_id bigint not null, actor_id bigint not null);
      create table dune.placeables (id bigint primary key, owner_entity_id bigint not null, building_type text not null);
      create table dune.inventories (
        id bigint primary key,
        actor_id bigint not null,
        max_item_count integer not null,
        max_item_volume integer not null default 0
      );
      create table dune.items (
        id bigint generated always as identity primary key,
        inventory_id bigint not null references dune.inventories(id),
        template_id text not null,
        stack_size integer not null,
        quality_level integer not null,
        position_index integer not null,
        stats jsonb not null
      );
      insert into dune.buildings values (482);
      insert into dune.building_instances values (482, 100);
      insert into dune.actor_fgl_entities values (100, 200);
      insert into dune.placeables values (5001, 100, 'generator_placeable');
      insert into dune.inventories (id, actor_id, max_item_count) values (701, 5001, 10);
    `);

    const db = transactionalDb(pool);
    const [first, second] = await Promise.all([
      refillBaseGenerators(db, "", 482),
      refillBaseGenerators(db, "", 482)
    ]);
    const stored = await pool.query(`
      select count(*)::int as rows, coalesce(sum(stack_size), 0)::int as units
      from dune.items
      where inventory_id = 701 and lower(template_id) = 'oil'`);

    assert.deepEqual(stored.rows[0], { rows: 1, units: 499 });
    assert.equal(first.totalAdded + second.totalAdded, 499);
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
