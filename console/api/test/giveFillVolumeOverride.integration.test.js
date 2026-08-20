import test from "node:test";
import assert from "node:assert/strict";
import { giveItemToStorage } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Real PostgreSQL, not a mocked db. The unit tests in db.test.js prove
// volumeOverrideForInsert() returns JS `null` for an uncatalogued item and
// that the mocked query captures that value -- they cannot prove `null`
// actually survives node-postgres' parameterized `$N::real` cast to become
// real SQL NULL in the stored row, rather than silently coercing to 0 or
// NaN somewhere in the driver. DBA hat finding (post-merge review of PR
// #182, 2026-08-20): this repo already has the tooling
// (test-support/pgIntegrationDb.js) to close that gap; this file does.
test("real PostgreSQL: giving an uncatalogued item stores volume_override as SQL NULL, not 0", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_give_volume_override",
    unavailableLabel: "the give-item volume_override integration test",
    createFailLabel: "the give-item volume_override integration test"
  }, async (pool) => {
    await pool.query(`
      create schema dune;
      create table dune.inventories (
        id bigint primary key,
        actor_id bigint not null,
        max_item_count integer not null,
        max_item_volume real not null default 0
      );
      create table dune.items (
        id bigint generated always as identity primary key,
        inventory_id bigint not null references dune.inventories(id),
        template_id text not null,
        stack_size integer not null,
        quality_level integer not null,
        position_index integer not null,
        stats jsonb not null,
        volume_override real
      );
      insert into dune.inventories (id, actor_id, max_item_count) values (701, 5001, 10);
    `);

    const db = pgTransactionalDb(pool);
    const result = await giveItemToStorage(db, 5001, { templateId: "SomeUncatalogedWeapon", quantity: 1 });
    assert.equal(result.ok, true);

    const stored = await pool.query("select volume_override from dune.items where inventory_id = 701");
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].volume_override, null,
      "real Postgres must store volume_override as SQL NULL for an uncatalogued item, not 0");
  });
});

test("real PostgreSQL: giving an item WITH a declared volume stores that per-unit value, not NULL", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_give_volume_override",
    unavailableLabel: "the give-item volume_override integration test",
    createFailLabel: "the give-item volume_override integration test"
  }, async (pool) => {
    await pool.query(`
      create schema dune;
      create table dune.inventories (
        id bigint primary key,
        actor_id bigint not null,
        max_item_count integer not null,
        max_item_volume real not null default 0
      );
      create table dune.items (
        id bigint generated always as identity primary key,
        inventory_id bigint not null references dune.inventories(id),
        template_id text not null,
        stack_size integer not null,
        quality_level integer not null,
        position_index integer not null,
        stats jsonb not null,
        volume_override real
      );
      insert into dune.inventories (id, actor_id, max_item_count) values (701, 5001, 10);
    `);

    const db = pgTransactionalDb(pool);
    const result = await giveItemToStorage(db, 5001, { templateId: "AzuriteOre", quantity: 20, itemVolume: 0.2 });
    assert.equal(result.ok, true);

    const stored = await pool.query("select volume_override from dune.items where inventory_id = 701");
    assert.equal(stored.rows.length, 1);
    assert.equal(Number(stored.rows[0].volume_override), 0.2,
      "a real, declared per-unit volume must still be stored, not overridden to NULL");
  });
});
