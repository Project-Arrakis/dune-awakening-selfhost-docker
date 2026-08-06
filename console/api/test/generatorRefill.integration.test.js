import test from "node:test";
import assert from "node:assert/strict";
import { refillBaseGenerators } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

test("real PostgreSQL serializes concurrent refills of an empty generator inventory", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_refill",
    unavailableLabel: "the refill concurrency test",
    createFailLabel: "the refill concurrency test"
  }, async (pool) => {
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

    const db = pgTransactionalDb(pool);
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
  });
});
