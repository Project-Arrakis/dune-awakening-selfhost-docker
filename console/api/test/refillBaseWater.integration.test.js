import test from "node:test";
import assert from "node:assert/strict";
import { BASE_REFILL_BACKED_UP_MESSAGE, baseWater, refillBaseWater } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Mirrors generatorRefill.integration.test.js -- a throwaway real-Postgres
// database rather than a mock, because the behaviour under test (a guarded
// lateral join avoiding the ContainerInventory fan-out, and a jsonb_set that
// must touch water and never blood) is exactly the kind of thing a fake
// query layer would let pass silently wrong.

test("real PostgreSQL refillBaseWater tops water to capacity, leaves blood untouched, and avoids the ContainerInventory fan-out", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_water_refill",
    unavailableLabel: "the water refill test",
    createFailLabel: "the water refill test"
  }, async (pool) => {
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
      -- actor_fgl_entities columns are (entity_id, actor_id, slot_name):
      -- entity_id=9001 (the fgl_entities row above), actor_id=5001 (the placeable).
      insert into dune.actor_fgl_entities values (9001, 5001, 'Actor');
      -- Same placeable also carries a ContainerInventory-slot entity with no
      -- water component -- the exact fan-out shape confirmed live on dune2.
      -- An unguarded join must not double the container or overwrite the
      -- wrong entity.
      insert into dune.fgl_entities values (9002, '{}'::jsonb);
      insert into dune.actor_fgl_entities values (9002, 5001, 'ContainerInventory');

      -- A Blood Purifier (water capacity 1000, blood capacity 6000), with
      -- both water and blood partially filled.
      insert into dune.placeables values (5002, 100, 'BloodWaterExtractor_Placeable');
      insert into dune.actors values (5002, '{"BP_BloodWaterExtractor_C": {"m_CurrentAmount": 3114.6}}'::jsonb);
      insert into dune.fgl_entities values (9003, '{"FWaterStorageComponent": [0, {"m_WaterStored": 200}]}'::jsonb);
      insert into dune.actor_fgl_entities values (9003, 5002, 'Actor');
    `);

    const db = pgTransactionalDb(pool);

    const before = await baseWater(db, 482);
    const cisternBefore = before.containers.find((c) => c.type === "waterCistern");
    const bloodBefore = before.containers.find((c) => c.type === "bloodWaterExtractor");
    assert.equal(cisternBefore.stored, 1250);
    assert.equal(cisternBefore.count, 1);
    assert.equal(bloodBefore.stored, 200);
    assert.equal(bloodBefore.bloodStored, 3115); // rounded

    const result = await refillBaseWater(db, 482);
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
    const again = await refillBaseWater(db, 482);
    assert.equal(again.totalAdded, 0);
  });
});

// The pickup shape baseIsBackedUp keys on: no permission_actor row for the
// claim actor, and the claim actor registered in base_backup_linked_actors.
// The refill routes refuse such a base up front, but a queued refill reaches
// this write later, and a picked-up base resolves to partition 0, so the flush
// would apply it immediately. The refusal has to come from the write itself.
test("real PostgreSQL refillBaseWater refuses a base that was picked up into a backup", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_water_refill_backup",
    unavailableLabel: "the backed-up water refill test",
    createFailLabel: "the backed-up water refill test"
  }, async (pool) => {
    await pool.query(`
      create schema dune;
      create table dune.buildings (id bigint primary key);
      create table dune.building_instances (building_id bigint not null, owner_entity_id bigint not null);
      create table dune.actor_fgl_entities (entity_id bigint not null, actor_id bigint not null, slot_name text);
      create table dune.placeables (id bigint primary key, owner_entity_id bigint not null, building_type text not null);
      create table dune.actors (id bigint primary key, properties jsonb not null default '{}'::jsonb);
      create table dune.fgl_entities (entity_id bigint primary key, components jsonb not null default '{}'::jsonb);
      create table dune.permission_actor (actor_id bigint primary key);
      create table dune.base_backup_linked_actors (id bigint not null, actor_id bigint not null);

      insert into dune.buildings values (482);
      insert into dune.building_instances values (482, 100);
      insert into dune.actor_fgl_entities values (100, 200);
      insert into dune.actors values (200, '{}'::jsonb);
      insert into dune.base_backup_linked_actors values (1, 200);

      insert into dune.placeables values (5001, 100, 'WaterCistern_Placeable');
      insert into dune.actors values (5001, '{}'::jsonb);
      insert into dune.fgl_entities values (9001, '{"FWaterStorageComponent": [0, {"m_WaterStored": 1250}]}'::jsonb);
      insert into dune.actor_fgl_entities values (9001, 5001, 'Actor');
    `);

    const db = pgTransactionalDb(pool);
    await assert.rejects(() => refillBaseWater(db, 482), { message: BASE_REFILL_BACKED_UP_MESSAGE });
    const stored = await pool.query("select components->'FWaterStorageComponent'->1->>'m_WaterStored' as stored from dune.fgl_entities where entity_id = 9001");
    assert.equal(Number(stored.rows[0].stored), 1250);

    // Redeployed: the claim is back, so the same base refills normally.
    await pool.query("insert into dune.permission_actor values (200)");
    const result = await refillBaseWater(db, 482);
    assert.equal(result.totalAdded, 5000 - 1250);
  });
});
