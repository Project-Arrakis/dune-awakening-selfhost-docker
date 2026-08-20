import test from "node:test";
import assert from "node:assert/strict";
import { addBaseContainerItem, deleteBaseContainerItem } from "../src/duneDb.js";
import { pgConnectionConfig, pgTransactionalDb } from "../test-support/pgIntegrationDb.js";
import pg from "pg";
import {
  BUILDING_ACTOR,
  CHEST,
  GENERATOR,
  ORPHAN_PLACEABLE,
  OTHER_CHEST,
  REFINERY,
  itemsIn,
  retryOnTransientDisconnect,
  waitUntilBlockedOnLock,
  withBaseContainerDatabase
} from "../test-support/baseContainerFixture.js";

// Real PostgreSQL rather than a mocked db. Three of the guarantees this feature
// rests on cannot be proved by string-matching SQL: that the ownership query
// actually isolates one base's containers from another's and from the fuel
// inventories the Power tab owns, that `for update of inv` actually serializes
// two adds onto distinct slots when the schema has no unique constraint to
// catch a collision, and that an add genuinely blocks on the lock a delete
// holds rather than racing past it.
//
// The schema and seed are shared with the delete suite; see
// test-support/baseContainerFixture.js.
const CHEST_INVENTORY = CHEST * 10;
const GENERATOR_INVENTORY = GENERATOR * 10;
const OTHER_CHEST_INVENTORY = OTHER_CHEST * 10;
const REFINERY_INVENTORY = REFINERY * 10;
const ORPHAN_INVENTORY = ORPHAN_PLACEABLE * 10;

function withDatabase(t, run) {
  return withBaseContainerDatabase(t, {
    namePrefix: "dune_container_item_add",
    unavailableLabel: "the base container item add integration test"
  }, run);
}

const SCRAP = { itemId: "ScrapMetal", quantity: 25 };

test("real PostgreSQL: an add lands in the next free slot and leaves every existing row untouched", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const before = await itemsIn(pool, CHEST_INVENTORY);
    assert.deepEqual(before.map((row) => Number(row.position_index)), [0, 1, 2]);

    const result = await addBaseContainerItem(db, BUILDING_ACTOR, CHEST, SCRAP);
    assert.equal(result.ok, true);
    assert.equal(result.added.positionIndex, 3);
    assert.equal(result.group, "storage");

    const after = await itemsIn(pool, CHEST_INVENTORY);
    assert.equal(after.length, 4);
    // The three pre-existing rows are byte-identical -- an add must not
    // renumber, reorder or restack anything already in the box.
    assert.deepEqual(after.slice(0, 3), before);
    assert.equal(Number(after[3].position_index), 3);
    assert.equal(Number(after[3].stack_size), 25);
  });
});

test("real PostgreSQL: an add to an empty container starts at slot zero", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    // The orphan chest has an inventory but no items -- coalesce(max(...), -1)+1
    // is the branch that has to produce 0 rather than NULL or 1.
    await pool.query("delete from dune.items where inventory_id = $1", [CHEST_INVENTORY]);
    const result = await addBaseContainerItem(db, BUILDING_ACTOR, CHEST, SCRAP);
    assert.equal(result.added.positionIndex, 0);
    const rows = await itemsIn(pool, CHEST_INVENTORY);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].position_index), 0);
  });
});

test("real PostgreSQL: another base's container cannot be reached through this base", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    // A real placeable with a real inventory -- just not one whose entity chain
    // resolves to BUILDING_ACTOR's claim.
    await assert.rejects(
      () => addBaseContainerItem(db, BUILDING_ACTOR, OTHER_CHEST, SCRAP),
      /not found at the selected base/
    );
    const rows = await itemsIn(pool, OTHER_CHEST_INVENTORY);
    assert.equal(rows.length, 1, "the other base's chest is unchanged");
    assert.equal(rows[0].template_id, "Spice");
  });
});

test("real PostgreSQL: a generator's fuel inventory cannot be reached", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    // Same base, same entity, real inventory -- excluded only by the
    // inventory_types allowlist join. This is the case that join buys, and the
    // Power tab owns this inventory.
    await assert.rejects(
      () => addBaseContainerItem(db, BUILDING_ACTOR, GENERATOR, SCRAP),
      /not found at the selected base/
    );
    const rows = await itemsIn(pool, GENERATOR_INVENTORY);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].template_id, "Oil");
    assert.equal(Number(rows[0].stack_size), 900);
  });
});

test("real PostgreSQL: a refinery at the same base is refused as a non-storage group", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    // On the allowlist, so the ownership query resolves it -- and then the
    // group check is what refuses it. A refining slot can be referenced by an
    // active job, so it stays read-only even with the map stopped.
    await assert.rejects(
      () => addBaseContainerItem(db, BUILDING_ACTOR, REFINERY, SCRAP),
      /only be added to Storage containers/
    );
    assert.equal((await itemsIn(pool, REFINERY_INVENTORY)).length, 0);
  });
});

test("real PostgreSQL: a placeable that belongs to no base is refused", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await assert.rejects(
      () => addBaseContainerItem(db, BUILDING_ACTOR, ORPHAN_PLACEABLE, SCRAP),
      /not found at the selected base/
    );
    assert.equal((await itemsIn(pool, ORPHAN_INVENTORY)).length, 0);
  });
});

test("real PostgreSQL: a full container refuses the add and inserts nothing", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    // Fill the 45-slot chest exactly. count(*) counts rows, so this is full at
    // 45 regardless of how large the stacks are.
    await pool.query(`
      insert into dune.items (inventory_id, template_id, stack_size, position_index, stats)
      select $1, 'Filler', 1, generate_series(3, 44), '{}'::jsonb`, [CHEST_INVENTORY]);
    assert.equal((await itemsIn(pool, CHEST_INVENTORY)).length, 45);

    await assert.rejects(
      () => addBaseContainerItem(db, BUILDING_ACTOR, CHEST, SCRAP),
      /full: 45 of 45/
    );
    assert.equal((await itemsIn(pool, CHEST_INVENTORY)).length, 45, "nothing was inserted");
  });
});

test("real PostgreSQL: an add never merges into an existing stack of the same template", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    // Slot 0 already holds 500 ScrapMetal. Adding more must be a new row, not a
    // top-up -- the add panel states this contract to the operator out loud.
    const result = await addBaseContainerItem(db, BUILDING_ACTOR, CHEST, { itemId: "ScrapMetal", quantity: 300 });
    assert.equal(result.added.positionIndex, 3);

    const rows = await itemsIn(pool, CHEST_INVENTORY);
    const scrap = rows.filter((row) => row.template_id === "ScrapMetal");
    assert.equal(scrap.length, 3, "three separate ScrapMetal rows, not two");
    assert.equal(Number(rows[0].stack_size), 500, "slot 0 is untouched");
    assert.deepEqual(scrap.map((row) => Number(row.stack_size)).sort((a, b) => a - b), [300, 400, 500]);
  });
});

// CORRECTED 2026-08-19 during upstream reconciliation (issue #366): this
// test's original last assertion (from upstream PR #172) asserted a
// resource stack gets a fully empty stats block. That's the opposite of
// this fork's own, earlier, evidence-based fix (be5081a5, 2026-07-30, see
// buildItemStats' own comment in duneDb.js): a real, engine-verified
// reference row for a plain resource in this world's actual live database
// DOES carry a DecayedMaxDurability key, and this fork's
// addBaseContainerItem (via buildItemStats) deliberately matches that real
// shape. Kept as a documented fork-specific divergence, not a silently
// dropped assertion -- the rest of this test (non-null stats column) is
// unchanged and still real upstream coverage.
test("real PostgreSQL: the inserted row always carries non-null stats", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    // dune.items.stats is NOT NULL with NO default in production, so an insert
    // that omitted it would raise rather than default -- this pins that the
    // column is always in the insert list.
    const result = await addBaseContainerItem(db, BUILDING_ACTOR, CHEST, SCRAP);
    const { rows } = await pool.query("select stats from dune.items where id = $1", [result.added.itemId]);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].stats, null);
    // A resource gets the same DecayedMaxDurability-only shape every real
    // resource row in this fork's live database carries -- not a fully
    // empty stat block (see this fork's own buildItemStats comment).
    assert.deepEqual(rows[0].stats.FItemStackAndDurabilityStats, [[], { DecayedMaxDurability: 0 }]);
  });
});

test("real PostgreSQL: an item id above Number.MAX_SAFE_INTEGER survives as a string", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await pool.query("select setval('dune.items_id_seq', 9007199254740993)");
    const result = await addBaseContainerItem(db, BUILDING_ACTOR, CHEST, SCRAP);
    assert.equal(typeof result.added.itemId, "string");
    // Round-trips exactly: a Number cast anywhere in the path would have
    // rounded this to an id that does not exist.
    const { rows } = await pool.query("select id::text as id from dune.items where id = $1", [result.added.itemId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, result.added.itemId);
    assert.ok(Number(result.added.itemId) > Number.MAX_SAFE_INTEGER);
  });
});

// The two locking tests below open a second connection deliberately, so they
// cannot use the shared pool's transactional wrapper for both sides.
async function withSecondConnection(database, run) {
  const client = new pg.Client(pgConnectionConfig(database));
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end().catch(() => {});
  }
}

test("real PostgreSQL: two concurrent adds serialize onto distinct slots", async (t) => {
  await retryOnTransientDisconnect(() => withDatabase(t, async (pool) => {
    return withSecondConnection(await currentDatabase(pool), async (client) => {
      // A holds the inventory row. B's ownership query must block on it rather
      // than racing ahead to read the same max(position_index).
      await client.query("begin");
      await client.query("select id from dune.inventories where id = $1 for update", [CHEST_INVENTORY]);

      const db = pgTransactionalDb(pool);
      const pending = addBaseContainerItem(db, BUILDING_ACTOR, CHEST, SCRAP);
      assert.equal(await waitUntilBlockedOnLock(pool), true, "the add must block on the held row lock");

      // A inserts at slot 3 and commits. B then re-evaluates under READ
      // COMMITTED, sees the committed row, and must compute 4 -- not 3.
      await client.query(`
        insert into dune.items (inventory_id, template_id, stack_size, position_index, stats)
        values ($1, 'Water', 10, 3, '{}'::jsonb)`, [CHEST_INVENTORY]);
      await client.query("commit");

      const result = await pending;
      assert.equal(result.added.positionIndex, 4, "the waiter must not reuse the slot taken while it blocked");

      const rows = await itemsIn(pool, CHEST_INVENTORY);
      const indices = rows.map((row) => Number(row.position_index));
      assert.deepEqual(indices, [0, 1, 2, 3, 4]);
      assert.equal(new Set(indices).size, indices.length, "no two rows share a slot");
    });
  }));
});

test("real PostgreSQL: an add blocks while a delete holds its item and inventory lock", async (t) => {
  await retryOnTransientDisconnect(() => withDatabase(t, async (pool) => {
    return withSecondConnection(await currentDatabase(pool), async (client) => {
      // What this proves, precisely: WHEN a transaction holds the lock
      // deleteBaseContainerItem takes, an add blocks on it and then reads
      // max(position_index) fresh. That is a statement about the ADD's
      // locking, and it was verified by mutation -- removing the add's
      // `for update of inv` makes this test fail.
      //
      // What it does NOT prove: that the delete still takes `inv` in its lock
      // list. The lock below is this test's own SQL, so trimming production's
      // to `for update of i` leaves this green -- also confirmed by mutation.
      // The guard for that is the unit assertion in db.test.js, "container
      // item delete locks the item and its inventory rather than the CTE".
      // Both are needed; neither covers the other.
      const target = (await itemsIn(pool, CHEST_INVENTORY)).find((row) => Number(row.position_index) === 2);
      await client.query("begin");
      await client.query(
        "select i.id from dune.items i join dune.inventories inv on inv.id = i.inventory_id where i.id = $1 for update of i, inv",
        [target.id]);

      const db = pgTransactionalDb(pool);
      const pending = addBaseContainerItem(db, BUILDING_ACTOR, CHEST, SCRAP);
      assert.equal(await waitUntilBlockedOnLock(pool), true, "the add must block on the delete's inventory lock");

      // Release by deleting the top slot, exactly as the real delete would.
      await client.query("delete from dune.items where id = $1", [target.id]);
      await client.query("commit");

      const result = await pending;
      // Slot 2 is free again, so the next free index is 2, not 3 -- the add
      // read max(position_index) AFTER the delete committed, which is the
      // whole point of having waited.
      assert.equal(result.added.positionIndex, 2);
      const indices = (await itemsIn(pool, CHEST_INVENTORY)).map((row) => Number(row.position_index));
      assert.deepEqual(indices, [0, 1, 2]);
      assert.equal(new Set(indices).size, indices.length);
    });
  }));
});

// The delete is imported so the suite fails to load if the two functions ever
// drift apart in signature; it is exercised for real by its own suite.
assert.equal(typeof deleteBaseContainerItem, "function");

async function currentDatabase(pool) {
  const { rows } = await pool.query("select current_database() as name");
  return rows[0].name;
}
