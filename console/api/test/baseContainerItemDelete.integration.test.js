import test from "node:test";
import assert from "node:assert/strict";
import { baseContainerSlots, deleteBaseContainerItem } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Real PostgreSQL rather than a mocked db, for the same reason
// baseDelete.integration.test.js uses it: the guarantees that matter here are
// ones a string-matched mock cannot prove -- that the ownership query actually
// isolates one base from another, that `for update of i, inv` actually takes a
// row lock, that a failed verification actually rolls back the write, and that
// the shipped procedures behave as the code assumes.
//
// The procedures below are transcribed from the shipped schema
// (.claude/dune_backup.sql), not reinvented. delete_inventory_item returning
// the REMAINING stack size -- and NULL only when the count exceeds it -- is
// load-bearing: a remaining size of 0 is a success, so any check that treats
// the return as a plain truthy value would be wrong.
const CLAIM_ACTOR = 8001;
const BUILDING_ACTOR = 8002;
const ENTITY_ID = 701;
const CHEST = 8003;          // storagecontainer_placeable, on the allowlist
const GENERATOR = 8004;      // oilgenerator_placeable, NOT on the allowlist

const OTHER_CLAIM_ACTOR = 8101;
const OTHER_BUILDING_ACTOR = 8102;
const OTHER_ENTITY_ID = 801;
const OTHER_CHEST = 8103;

const SCHEMA = `
  create schema dune;

  create table dune.actors (id bigint primary key, map text, partition_id bigint, owner_account_id bigint);
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
  create table dune.placeables (
    id bigint primary key references dune.actors(id) on delete cascade,
    owner_entity_id bigint,
    building_type text,
    is_hologram boolean not null default false
  );
  create table dune.permission_actor (
    actor_id bigint primary key references dune.actors(id) on delete cascade,
    actor_name text
  );
  create table dune.inventories (
    id bigint primary key,
    actor_id bigint not null references dune.actors(id) on delete cascade,
    max_item_count integer not null default 10
  );
  -- The production constraints, not a convenient subset: position_index is NOT
  -- NULL with a >= 0 check and has NO unique constraint against
  -- (inventory_id, position_index), which is exactly why the grid has to cope
  -- with duplicates. stack_size > 0 is why a partial removal to zero must go
  -- through delete_item rather than an UPDATE.
  create table dune.items (
    id bigint generated always as identity primary key,
    inventory_id bigint references dune.inventories(id) on delete cascade,
    stack_size bigint not null,
    position_index bigint not null,
    template_id text not null,
    stats jsonb not null default '{}'::jsonb,
    quality_level bigint not null default 0,
    constraint items_position_index_check check (position_index >= 0),
    constraint items_stack_size_check check (stack_size > 0)
  );

  -- delete_item's item-tracking log. Early-returns in production unless
  -- dune.item_tracking_enabled is set; stubbed to a no-op so the signature and
  -- call shape match without needing the setting.
  create function dune._add_item_delete_log(in_item_id bigint, in_inventory_id bigint, in_template_id text)
  returns void language plpgsql as $$ begin return; end $$;

  create function dune.delete_item(in_id bigint) returns void
  language sql as $$
    delete from dune.items i
    using dune.inventories inv
    where i.inventory_id = inv.id
      and i.id = in_id
    returning dune._add_item_delete_log(i.id, inv.id, i.template_id);
  $$;

  create function dune.delete_inventory_item(in_item_id bigint, in_count bigint) returns bigint
  language plpgsql as $$
  declare
    remaining_stack_size bigint;
  begin
    select into strict remaining_stack_size stack_size from dune.items where id = in_item_id;
    remaining_stack_size := remaining_stack_size - in_count;
    if remaining_stack_size < 0 then
      return null;
    end if;
    if remaining_stack_size > 0 then
      update dune.items set stack_size = remaining_stack_size where id = in_item_id;
    else
      perform dune.delete_item(in_item_id);
    end if;
    return remaining_stack_size;
  end $$;
`;

function seedBase(claimActor, buildingActor, entityId, chestId, extraPlaceables = "") {
  return `
    insert into dune.actors (id, map, partition_id) values (${claimActor}, 'HaggaBasin', 3);
    insert into dune.actor_fgl_entities (entity_id, actor_id) values (${entityId}, ${claimActor});
    insert into dune.permission_actor (actor_id, actor_name) values (${claimActor}, 'Base ${claimActor}');

    insert into dune.actors (id, map, partition_id) values (${buildingActor}, 'HaggaBasin', 3);
    insert into dune.buildings (id) values (${buildingActor});
    insert into dune.building_instances (building_id, instance_id, owner_entity_id) values (${buildingActor}, 0, ${entityId});

    insert into dune.actors (id, map, partition_id) values (${chestId}, 'HaggaBasin', 3);
    insert into dune.placeables (id, owner_entity_id, building_type) values (${chestId}, ${entityId}, 'storagecontainer_placeable');
    insert into dune.inventories (id, actor_id, max_item_count) values (${chestId} * 10, ${chestId}, 45);
    ${extraPlaceables}
  `;
}

// Two stacks of ONE template, plus a second template. The duplicate template is
// the case the merged items[] collapses and the per-slot view must keep apart.
const SEED = `
  ${seedBase(CLAIM_ACTOR, BUILDING_ACTOR, ENTITY_ID, CHEST, `
    insert into dune.actors (id, map, partition_id) values (${GENERATOR}, 'HaggaBasin', 3);
    insert into dune.placeables (id, owner_entity_id, building_type) values (${GENERATOR}, ${ENTITY_ID}, 'oilgenerator_placeable');
    insert into dune.inventories (id, actor_id, max_item_count) values (${GENERATOR} * 10, ${GENERATOR}, 4);
  `)}
  insert into dune.items (inventory_id, template_id, stack_size, position_index) values
    (${CHEST} * 10, 'ScrapMetal', 500, 0),
    (${CHEST} * 10, 'MagnetiteOre', 200, 1),
    (${CHEST} * 10, 'ScrapMetal', 400, 2);
  insert into dune.items (inventory_id, template_id, stack_size, position_index) values
    (${GENERATOR} * 10, 'Oil', 900, 0);

  ${seedBase(OTHER_CLAIM_ACTOR, OTHER_BUILDING_ACTOR, OTHER_ENTITY_ID, OTHER_CHEST)}
  insert into dune.items (inventory_id, template_id, stack_size, position_index) values
    (${OTHER_CHEST} * 10, 'Spice', 77, 0);
`;

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_container_item_delete",
    unavailableLabel: "the base container item delete integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);
    return run(pool);
  });
}

async function itemsIn(pool, inventoryId) {
  const result = await pool.query(
    "select id, template_id, stack_size, position_index from dune.items where inventory_id = $1 order by position_index",
    [inventoryId]);
  return result.rows;
}

async function itemAt(pool, inventoryId, positionIndex) {
  const rows = await itemsIn(pool, inventoryId);
  return rows.find((row) => Number(row.position_index) === positionIndex);
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
      insert into dune.items (id, inventory_id, template_id, stack_size, position_index)
      overriding system value values ($1, $2, 'SpiceMelange', 12, 4)
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
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const target = await itemAt(pool, CHEST * 10, 0);
    const holder = await pool.connect();
    let settled = false;
    try {
      // Someone else holds the item row.
      await holder.query("begin");
      await holder.query("select id from dune.items where id = $1 for update", [target.id]);

      // The delete must block rather than racing the other transaction.
      // Racing it against a timer shows that without needing a
      // statement_timeout.
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
      const raced = await Promise.race([
        deleting.then(() => "completed", () => "failed"),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1200))
      ]);
      assert.equal(raced, "still waiting", "the delete must wait on the locked row");
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
  });
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
