import test from "node:test";
import assert from "node:assert/strict";
import { baseContainerSlots, deleteBaseContainerItem } from "../src/duneDb.js";
import { pgTransactionalDb } from "../test-support/pgIntegrationDb.js";
import {
  BUILDING_ACTOR,
  CHEST,
  GENERATOR,
  OTHER_BUILDING_ACTOR,
  OTHER_CHEST,
  itemAt,
  itemsIn,
  retryOnTransientDisconnect,
  waitUntilBlockedOnLock,
  withBaseContainerDatabase
} from "../test-support/baseContainerFixture.js";

// Real PostgreSQL rather than a mocked db, for the same reason
// baseDelete.integration.test.js uses it: the guarantees that matter here are
// ones a string-matched mock cannot prove -- that the ownership query actually
// isolates one base from another, that `for update of i, inv` actually takes a
// row lock, that a failed verification actually rolls back the write, and that
// the shipped procedures behave as the code assumes.
//
// The schema, seed and helpers live in test-support/baseContainerFixture.js so
// the add suite exercises byte-identical production constraints -- see that
// file's header for why a second copy would be a liability.
function withDatabase(t, run) {
  return withBaseContainerDatabase(t, {
    namePrefix: "dune_container_item_delete",
    unavailableLabel: "the base container item delete integration test"
  }, run);
}

test("real PostgreSQL: baseContainerSlots returns one entry per slot, keeping two stacks of one template apart", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const result = await baseContainerSlots(db, BUILDING_ACTOR, CHEST);

    assert.equal(result.supported, true);
    assert.equal(result.found, true);
    assert.equal(result.group, "storage");
    assert.equal(result.usedSlots, 3);
    assert.equal(result.maxSlots, 45);
    assert.equal(result.inventories.length, 1);

    const slots = result.inventories[0].slots;
    assert.equal(slots.length, 3);
    // Ordered by slot, not by template or quantity.
    assert.deepEqual(slots.map((slot) => slot.positionIndex), [0, 1, 2]);
    // The two ScrapMetal stacks stay separate at their own quantities rather
    // than merging into 900.
    const scrap = slots.filter((slot) => slot.templateId === "ScrapMetal");
    assert.equal(scrap.length, 2);
    assert.deepEqual(scrap.map((slot) => slot.quantity).sort((a, b) => a - b), [400, 500]);
    // Every slot carries a distinct item id -- the delete target.
    assert.equal(new Set(slots.map((slot) => slot.itemId)).size, 3);
  });
});

test("real PostgreSQL: baseContainerSlots does not expose a generator's fuel inventory", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    // The generator is a genuine placeable at this base with a real inventory;
    // it is excluded solely by the container allowlist, which is what keeps
    // the Power tab's fuel out of this surface.
    const result = await baseContainerSlots(db, BUILDING_ACTOR, GENERATOR);
    assert.equal(result.found, false);
  });
});

test("real PostgreSQL: a container at another base is not reachable through this one", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    assert.equal((await baseContainerSlots(db, BUILDING_ACTOR, OTHER_CHEST)).found, false);
    assert.equal((await baseContainerSlots(db, OTHER_BUILDING_ACTOR, OTHER_CHEST)).found, true);
  });
});

test("real PostgreSQL: deleting a whole slot removes that row and nothing else", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const target = await itemAt(pool, CHEST * 10, 0);

    const result = await deleteBaseContainerItem(db, BUILDING_ACTOR, CHEST, target.id);
    assert.equal(result.ok, true);
    assert.equal(result.partial, false);
    assert.equal(result.removed.count, 500);

    const remaining = await itemsIn(pool, CHEST * 10);
    assert.deepEqual(remaining.map((row) => Number(row.position_index)), [1, 2]);
    // The other ScrapMetal stack, sharing the template, must survive -- a
    // delete addresses a row, never a template.
    assert.ok(remaining.some((row) => row.template_id === "ScrapMetal" && Number(row.stack_size) === 400));
    // And the other base is untouched.
    assert.equal((await itemsIn(pool, OTHER_CHEST * 10)).length, 1);
  });
});

test("real PostgreSQL: deleting preserves a bigint item id beyond Number.MAX_SAFE_INTEGER", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const largeId = "9007199254740993";
    await pool.query(`
      insert into dune.items (id, inventory_id, template_id, stack_size, position_index, stats)
      values ($1, $2, 'SpiceMelange', 12, 4, '{}'::jsonb)
    `, [largeId, CHEST * 10]);

    const result = await deleteBaseContainerItem(db, BUILDING_ACTOR, CHEST, largeId);
    assert.equal(result.removed.itemId, largeId);
    assert.equal((await pool.query("select id from dune.items where id = $1", [largeId])).rowCount, 0);
  });
});

test("real PostgreSQL: an item in another base's container cannot be deleted through this base", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const victim = (await itemsIn(pool, OTHER_CHEST * 10))[0];

    // Both the wrong-base and the wrong-container framings must fail.
    await assert.rejects(
      () => deleteBaseContainerItem(db, BUILDING_ACTOR, OTHER_CHEST, victim.id),
      /not found in a storage container/);
    await assert.rejects(
      () => deleteBaseContainerItem(db, BUILDING_ACTOR, CHEST, victim.id),
      /not found in a storage container/);

    assert.equal((await itemsIn(pool, OTHER_CHEST * 10)).length, 1, "the other base's item must survive");
  });
});

test("real PostgreSQL: a generator's fuel cannot be deleted through the container route", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const fuel = (await itemsIn(pool, GENERATOR * 10))[0];

    await assert.rejects(
      () => deleteBaseContainerItem(db, BUILDING_ACTOR, GENERATOR, fuel.id),
      /not found in a storage container/);
    assert.equal((await itemsIn(pool, GENERATOR * 10)).length, 1, "generator fuel must survive");
  });
});

test("real PostgreSQL: a partial removal decrements the real stack through the shipped procedure", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const target = await itemAt(pool, CHEST * 10, 0);

    const result = await deleteBaseContainerItem(db, BUILDING_ACTOR, CHEST, target.id, { count: 150 });
    assert.equal(result.partial, true);
    assert.equal(result.removed.remaining, 350);

    const after = await itemAt(pool, CHEST * 10, 0);
    assert.equal(Number(after.stack_size), 350);
    assert.equal((await itemsIn(pool, CHEST * 10)).length, 3, "the slot must still exist");
  });
});

test("real PostgreSQL: a count above the stack is refused and leaves the stack untouched", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const target = await itemAt(pool, CHEST * 10, 0);

    // The race this guards: the stack shrank since the view loaded. Rounding
    // the request down to "delete it all" would destroy more than was asked.
    await assert.rejects(
      () => deleteBaseContainerItem(db, BUILDING_ACTOR, CHEST, target.id, { count: 900 }),
      /Cannot remove 900: the stack holds 500/);

    const after = await itemAt(pool, CHEST * 10, 0);
    assert.equal(Number(after.stack_size), 500);
    assert.equal((await itemsIn(pool, CHEST * 10)).length, 3);
  });
});

test("real PostgreSQL: the delete waits on a row another transaction holds locked", async (t) => {
  await retryOnTransientDisconnect(() => withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const target = await itemAt(pool, CHEST * 10, 0);
    const holder = await pool.connect();
    let settled = false;
    try {
      // Someone else holds the item row.
      await holder.query("begin");
      await holder.query("select id from dune.items where id = $1 for update", [target.id]);

      // The delete must block rather than racing the other transaction.
      // waitUntilBlockedOnLock confirms that via Postgres's own wait-state
      // rather than a fixed timer.
      //
      // What this does and does not prove, checked by removing the clause and
      // re-running: it does NOT isolate `for update of i, inv` specifically,
      // because dune.delete_item's own DELETE takes a row lock anyway, so the
      // call serializes either way. What it proves is the guarantee that
      // actually matters -- two concurrent deletes of one item cannot
      // interleave, and nothing is removed while the other holder is live.
      // The clause itself is pinned by a string assertion in db.test.js.
      const deleting = deleteBaseContainerItem(db, BUILDING_ACTOR, CHEST, target.id)
        .then((value) => { settled = true; return value; },
              (error) => { settled = true; throw error; });

      const blocked = await waitUntilBlockedOnLock(pool);
      assert.equal(blocked, true, "the delete must be genuinely blocked on the locked row, not just slow");
      assert.equal(settled, false);
      assert.equal(Number((await itemAt(pool, CHEST * 10, 0)).stack_size), 500, "nothing removed while blocked");

      // Releasing the lock lets the same call through, so the wait was the
      // lock and not a hang.
      await holder.query("rollback");
      const result = await deleting;
      assert.equal(result.ok, true);
      assert.equal(await itemAt(pool, CHEST * 10, 0), undefined, "the slot is gone once the lock clears");
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
  }));
});

test("real PostgreSQL: a failed post-write verification rolls the whole delete back", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const target = await itemAt(pool, CHEST * 10, 0);

    // Forces the partial path's "did not change the stack by the requested
    // amount" check to fire: the trigger overwrites the procedure's result, so
    // the verification disagrees and throws AFTER the write has happened. What
    // is under test is that the enclosing transaction takes the write back
    // with it -- not the trigger, which is a synthetic way to reach that state.
    await pool.query(`
      create function dune.meddle() returns trigger language plpgsql as $$
      begin
        new.stack_size := 999;
        return new;
      end $$;
      create trigger meddle_items before update on dune.items
      for each row execute function dune.meddle();
    `);

    await assert.rejects(
      () => deleteBaseContainerItem(db, BUILDING_ACTOR, CHEST, target.id, { count: 150 }),
      /did not change the stack/);

    const after = await itemAt(pool, CHEST * 10, 0);
    assert.equal(Number(after.stack_size), 500, "the interfered-with write must have rolled back");
    assert.equal((await itemsIn(pool, CHEST * 10)).length, 3);
  });
});

test("real PostgreSQL: the audit result carries the destroyed item's quality and durability", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    // Without these, a destroyed pristine legendary and a destroyed broken
    // common of the same template log identically -- this is the fixture that
    // would tell them apart.
    const seeded = await pool.query(`
      insert into dune.items (inventory_id, template_id, stack_size, position_index, quality_level, stats)
      values ($1, 'Ornithopter_Rudder', 1, 5, 3,
        '{"FItemStackAndDurabilityStats": [[], {"CurrentDurability": "812", "MaxDurability": "1000"}]}'::jsonb)
      returning id
    `, [CHEST * 10]);
    const itemId = seeded.rows[0].id;

    const result = await deleteBaseContainerItem(db, BUILDING_ACTOR, CHEST, itemId);
    assert.equal(result.removed.positionIndex, 5);
    assert.equal(result.removed.qualityLevel, 3);
    assert.equal(result.removed.currentDurability, 812);
    assert.equal(result.removed.maxDurability, 1000);
  });
});
