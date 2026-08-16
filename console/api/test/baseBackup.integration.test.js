import test from "node:test";
import assert from "node:assert/strict";
import { baseIsBackedUp } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Exercises real PostgreSQL rather than a mocked db, for the same reason
// baseDelete.integration.test.js does: the guarantee under test is a real
// join/exists shape, not a string-matched query.
//
// The claim actor (9001) and the base id a caller passes in (a
// dune.buildings.id, e.g. 9002) are deliberately different ids, mirroring
// production where they never match -- see baseDelete.integration.test.js's
// same note.
const CLAIM_ACTOR = 9001;
const BUILDING_ACTOR = 9002;
const ENTITY_ID = 501;

const SCHEMA = `
  create schema dune;

  create table dune.actors (id bigint primary key, map text, partition_id bigint);
  create table dune.buildings (id bigint primary key references dune.actors(id) on delete cascade);
  create table dune.building_instances (
    building_id bigint not null references dune.actors(id) on delete cascade,
    instance_id integer not null,
    owner_entity_id bigint
  );
  create table dune.actor_fgl_entities (
    entity_id bigint not null,
    actor_id bigint not null references dune.actors(id) on delete cascade
  );
  create table dune.permission_actor (
    actor_id bigint primary key references dune.actors(id) on delete cascade,
    actor_name text
  );
  create table dune.base_backup_linked_actors (id bigint not null, actor_id bigint not null);
`;

function seedBase() {
  return `
    insert into dune.actors (id, map, partition_id) values (${CLAIM_ACTOR}, 'HaggaBasin', 3);
    insert into dune.actor_fgl_entities (entity_id, actor_id) values (${ENTITY_ID}, ${CLAIM_ACTOR});
    insert into dune.actors (id, map, partition_id) values (${BUILDING_ACTOR}, 'HaggaBasin', 3);
    insert into dune.buildings (id) values (${BUILDING_ACTOR});
    insert into dune.building_instances (building_id, instance_id, owner_entity_id) values (${BUILDING_ACTOR}, 0, ${ENTITY_ID});
  `;
}

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_base_backup",
    unavailableLabel: "the base-backup integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(seedBase());
    return run(pool);
  });
}

test("real PostgreSQL: baseIsBackedUp is false for a normally claimed base", async (t) => {
  await withDatabase(t, async (pool) => {
    await pool.query("insert into dune.permission_actor (actor_id, actor_name) values ($1, 'Claimed Base')", [CLAIM_ACTOR]);
    const db = pgTransactionalDb(pool);
    assert.equal(await baseIsBackedUp(db, BUILDING_ACTOR), false);
  });
});

test("real PostgreSQL: baseIsBackedUp is false for an unclaimed base that was never backed up", async (t) => {
  await withDatabase(t, async (pool) => {
    // No permission_actor row and no base_backup_linked_actors row either --
    // "no owner" alone must not be read as "picked up".
    const db = pgTransactionalDb(pool);
    assert.equal(await baseIsBackedUp(db, BUILDING_ACTOR), false);
  });
});

test("real PostgreSQL: baseIsBackedUp is true only once both unclaimed and backup-linked", async (t) => {
  await withDatabase(t, async (pool) => {
    await pool.query("insert into dune.base_backup_linked_actors (id, actor_id) values (1, $1)", [CLAIM_ACTOR]);
    const db = pgTransactionalDb(pool);
    assert.equal(await baseIsBackedUp(db, BUILDING_ACTOR), true);
  });
});

test("real PostgreSQL: baseIsBackedUp is false once redeployed, even if old linked-actor rows are still present", async (t) => {
  await withDatabase(t, async (pool) => {
    // Simulates a redeploy: permission_actor comes back, but nothing has
    // necessarily cleaned up the earlier base_backup_linked_actors row yet.
    // Requiring both signals -- not "ever linked" alone -- is exactly what
    // keeps a redeployed base from being wrongly blocked in this case.
    await pool.query("insert into dune.base_backup_linked_actors (id, actor_id) values (1, $1)", [CLAIM_ACTOR]);
    await pool.query("insert into dune.permission_actor (actor_id, actor_name) values ($1, 'Redeployed Base')", [CLAIM_ACTOR]);
    const db = pgTransactionalDb(pool);
    assert.equal(await baseIsBackedUp(db, BUILDING_ACTOR), false);
  });
});

test("real PostgreSQL: baseIsBackedUp is false for a base id that does not exist", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    assert.equal(await baseIsBackedUp(db, 999999), false);
  });
});
