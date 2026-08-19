import { withIsolatedDatabase } from "./pgIntegrationDb.js";

// Shared by baseContainerItemDelete.integration.test.js and
// baseContainerItemAdd.integration.test.js. Extracted rather than copied
// because the SCHEMA below is the honest part of these tests: it was corrected
// once already against .claude/dune_backup.sql (an invented `stats` default,
// two missing actor_fgl_entities UNIQUE constraints, a NOT NULL that is not
// real), and a second copy would silently drift on the next such correction --
// taking the ownership-isolation guarantees with it.
//
// The procedures are transcribed from the shipped schema, not reinvented.
// delete_inventory_item returning the REMAINING stack size -- and NULL only
// when the count exceeds it -- is load-bearing: a remaining size of 0 is a
// success, so any check treating the return as plain truthy would be wrong.
export const CLAIM_ACTOR = 8001;
export const BUILDING_ACTOR = 8002;
export const ENTITY_ID = 701;
export const CHEST = 8003;          // storagecontainer_placeable, on the allowlist
export const GENERATOR = 8004;      // oilgenerator_placeable, NOT on the allowlist

export const OTHER_CLAIM_ACTOR = 8101;
export const OTHER_BUILDING_ACTOR = 8102;
export const OTHER_ENTITY_ID = 801;
export const OTHER_CHEST = 8103;

// A refinery at the SAME base as CHEST. On the inventory-types allowlist but in
// the "refining" group, so it is the fixture that proves the group check fires
// against real data rather than only against a mocked group_key.
export const REFINERY = 8005;

// A placeable that belongs to no base at all -- no building_instances row ties
// its entity back to a claim.
export const ORPHAN_PLACEABLE = 8006;
export const ORPHAN_ENTITY_ID = 702;

export const SCHEMA = `
  create schema dune;

  create table dune.actors (id bigint primary key, map text, partition_id bigint, owner_account_id bigint);
  create table dune.buildings (id bigint primary key references dune.actors(id) on delete cascade);
  create table dune.building_instances (
    building_id bigint not null references dune.actors(id) on delete cascade,
    instance_id integer not null,
    owner_entity_id bigint
  );
  -- Both columns are nullable in production and carry a third NOT NULL column,
  -- plus two UNIQUE constraints. The uniques matter here: entity_id being
  -- unique is what makes the placeables -> base_entities join single-valued,
  -- so declaring them keeps the ownership-isolation tests honest rather than
  -- passing because the fixture happens not to contain a duplicate.
  create table dune.actor_fgl_entities (
    entity_id bigint,
    actor_id bigint references dune.actors(id) on delete cascade,
    slot_name text not null default '',
    constraint actor_fgl_entities_entity_id_key unique (entity_id),
    constraint actor_fgl_no_slot_duplication unique (actor_id, slot_name)
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
  -- actor_id is nullable in production, guarded by a CHECK that at least one
  -- of the four owner columns is set: an inventory can belong to an exchange,
  -- an item or a vehicle module instead of an actor. max_item_count is
  -- nullable with no default. Declaring the loose production shape is what
  -- lets the max_item_count >= 0 filter be exercised against a NULL.
  create table dune.inventories (
    id bigint primary key,
    actor_id bigint references dune.actors(id) on delete cascade,
    exchange_id bigint,
    item_id bigint,
    vehicle_module_id bigint,
    max_item_count integer,
    constraint valid_fkey check (actor_id is not null or exchange_id is not null
      or item_id is not null or vehicle_module_id is not null)
  );
  -- The production constraints, not a convenient subset: position_index is NOT
  -- NULL with a >= 0 check and has NO unique constraint against
  -- (inventory_id, position_index), which is exactly why the grid has to cope
  -- with duplicates -- and why the add's next-free-slot computation is guarded
  -- by a row lock rather than by the database.
  -- stats has NO default in production, so every insert must supply it; a
  -- default here would let a seed omit it and pass a test production would
  -- reject. id uses a sequence default rather than GENERATED ALWAYS, which
  -- would refuse the explicit ids production accepts.
  create sequence dune.items_id_seq;
  create table dune.items (
    id bigint primary key default nextval('dune.items_id_seq'),
    inventory_id bigint references dune.inventories(id) on delete cascade,
    stack_size bigint not null,
    position_index bigint not null,
    template_id text not null,
    stats jsonb not null,
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

export function seedBase(claimActor, buildingActor, entityId, chestId, extraPlaceables = "") {
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
export const SEED = `
  ${seedBase(CLAIM_ACTOR, BUILDING_ACTOR, ENTITY_ID, CHEST, `
    insert into dune.actors (id, map, partition_id) values (${GENERATOR}, 'HaggaBasin', 3);
    insert into dune.placeables (id, owner_entity_id, building_type) values (${GENERATOR}, ${ENTITY_ID}, 'oilgenerator_placeable');
    insert into dune.inventories (id, actor_id, max_item_count) values (${GENERATOR} * 10, ${GENERATOR}, 4);

    insert into dune.actors (id, map, partition_id) values (${REFINERY}, 'HaggaBasin', 3);
    insert into dune.placeables (id, owner_entity_id, building_type) values (${REFINERY}, ${ENTITY_ID}, 'smallorerefinery_placeable');
    insert into dune.inventories (id, actor_id, max_item_count) values (${REFINERY} * 10, ${REFINERY}, 10);

    insert into dune.actors (id, map, partition_id) values (${ORPHAN_PLACEABLE}, 'HaggaBasin', 3);
    insert into dune.actor_fgl_entities (entity_id, actor_id) values (${ORPHAN_ENTITY_ID}, ${ORPHAN_PLACEABLE});
    insert into dune.placeables (id, owner_entity_id, building_type) values (${ORPHAN_PLACEABLE}, ${ORPHAN_ENTITY_ID}, 'storagecontainer_placeable');
    insert into dune.inventories (id, actor_id, max_item_count) values (${ORPHAN_PLACEABLE} * 10, ${ORPHAN_PLACEABLE}, 20);
  `)}
  insert into dune.items (inventory_id, template_id, stack_size, position_index, stats) values
    (${CHEST} * 10, 'ScrapMetal', 500, 0, '{}'::jsonb),
    (${CHEST} * 10, 'MagnetiteOre', 200, 1, '{}'::jsonb),
    (${CHEST} * 10, 'ScrapMetal', 400, 2, '{}'::jsonb);
  insert into dune.items (inventory_id, template_id, stack_size, position_index, stats) values
    (${GENERATOR} * 10, 'Oil', 900, 0, '{}'::jsonb);

  ${seedBase(OTHER_CLAIM_ACTOR, OTHER_BUILDING_ACTOR, OTHER_ENTITY_ID, OTHER_CHEST)}
  insert into dune.items (inventory_id, template_id, stack_size, position_index, stats) values
    (${OTHER_CHEST} * 10, 'Spice', 77, 0, '{}'::jsonb);
`;

// namePrefix must be unique per calling test file -- it is the first line of
// defence against two suites colliding on a database name, independent of the
// advisory lock withIsolatedDatabase adds.
export function withBaseContainerDatabase(t, { namePrefix, unavailableLabel }, run) {
  return withIsolatedDatabase(t, { namePrefix, unavailableLabel }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);
    return run(pool);
  });
}

export async function itemsIn(pool, inventoryId) {
  const result = await pool.query(
    "select id, template_id, stack_size, position_index from dune.items where inventory_id = $1 order by position_index",
    [inventoryId]);
  return result.rows;
}

export async function itemAt(pool, inventoryId, positionIndex) {
  const rows = await itemsIn(pool, inventoryId);
  return rows.find((row) => Number(row.position_index) === positionIndex);
}

// Confirms a transaction is genuinely blocked on a held row lock via
// Postgres's own wait-state, instead of inferring "still waiting" from a fixed
// timer -- a timer proves nothing about WHY a promise has not settled, and the
// fixed 1200ms hold this replaced was the most likely reason this file was the
// one seen hitting the teardown race documented in pgIntegrationDb.js.
//
// `requested_claims` is the CTE name shared by both ownership queries. Both
// deleteBaseContainerItem and addBaseContainerItem take FOR UPDATE there;
// baseContainerSlots names it too but never locks, so it can never be the
// blocked one.
export async function waitUntilBlockedOnLock(pool, { timeoutMs = 3000, pollMs = 50, queryPattern = "%requested_claims%" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(`
      select 1 from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and query ilike $1
      limit 1`, [queryPattern]);
    if (rows.length) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

// pgIntegrationDb.js's own header documents a confirmed, external race: its
// teardown issues a best-effort pg_terminate_backend against any connection
// its pool.end() missed, and under load that can hit a connection a test
// still needed, surfacing as this exact server-generated error text. A
// single retry re-runs the WHOLE test body against a brand-new isolated
// database and a brand-new lock scenario, so it cannot mask a real locking
// bug -- if the locking were actually broken, the retry would fail
// identically, not intermittently.
export async function retryOnTransientDisconnect(fn) {
  try {
    return await fn();
  } catch (error) {
    if (!/terminating connection due to administrator command/.test(error?.message || "")) throw error;
    return await fn();
  }
}
