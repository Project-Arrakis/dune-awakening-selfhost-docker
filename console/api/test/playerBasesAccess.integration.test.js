import test from "node:test";
import assert from "node:assert/strict";
import { listBases } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// The ?access filter on a player's Bases tab, against real rows. Rank 1 is "Owner", rank 2
// "Co-Owner", rank 3 "Associate". Co-owner must not list a base where the same player is
// also rank 1 (the roster's unique key makes that impossible today; the guard is defensive).
const SCHEMA = `
  create schema dune;
  create type dune.vector3 as (x double precision, y double precision, z double precision);
  create type dune.transform as (location dune.vector3);
  create table dune.buildings (id bigint primary key, owner_id bigint);
  create table dune.building_instances (building_id bigint not null, instance_id integer not null, building_type text, owner_entity_id bigint, health real);
  create table dune.actor_fgl_entities (entity_id bigint not null, actor_id bigint not null);
  create table dune.actors (id bigint primary key, class text, map text, partition_id bigint, owner_account_id bigint, transform dune.transform);
  create table dune.permission_actor (actor_id bigint primary key, actor_name text, actor_type smallint, access_level smallint, is_child boolean default false, edited_by_player_id bigint);
  create table dune.permission_actor_rank (
    permission_actor_id bigint not null references dune.permission_actor(actor_id) on delete cascade,
    player_id bigint not null,
    rank smallint not null,
    unique (permission_actor_id, player_id)
  );
  -- Production exposes player_state as a view over encrypted_player_state (Active characters only);
  -- a plain table is enough here because these tests only need the pawn/controller/account mapping.
  create table dune.player_state (
    id bigint, account_id bigint, player_controller_id bigint, player_pawn_id bigint,
    character_name text, online_status text default 'Offline'
  );
  create table dune.placeables (id bigint primary key, owner_entity_id bigint, health real, building_type text);
  create table dune.map_names (map_name_id smallint primary key, map_name text not null);
`;

const DUNCAN = { pawn: 21, controller: 11, account: 100 };
const GURNEY = { pawn: 22, controller: 12, account: 200 };

// One base = one building, one claim actor, one piece. Ids stay distinct per base.
function base(n, name) {
  const id = 1000 + n;
  return `
    insert into dune.buildings (id) values (${id});
    insert into dune.actors (id, class, map, partition_id, transform) values (${id}, '/Game/Totem.Totem_C', 'HaggaBasin', 1, row(row(1,2,3)::dune.vector3)::dune.transform);
    insert into dune.actor_fgl_entities (entity_id, actor_id) values (${id + 500}, ${id});
    insert into dune.building_instances (building_id, instance_id, building_type, owner_entity_id, health)
      values (${id}, 1, 'Sardaukar_Foundation', ${id + 500}, 100);
    insert into dune.permission_actor (actor_id, actor_name, actor_type, access_level, is_child) values (${id}, '${name}', 1, 3, false);
  `;
}

const SEED = `
  insert into dune.actors (id, class, owner_account_id) values
    (${DUNCAN.pawn}, '/Game/Characters/BP_PlayerCharacter.BP_PlayerCharacter_C', ${DUNCAN.account}),
    (${GURNEY.pawn}, '/Game/Characters/BP_PlayerCharacter.BP_PlayerCharacter_C', ${GURNEY.account}),
    (${DUNCAN.controller}, null, ${DUNCAN.account}),
    (${GURNEY.controller}, null, ${GURNEY.account});
  insert into dune.player_state (id, account_id, player_controller_id, player_pawn_id, character_name) values
    (1, ${DUNCAN.account}, ${DUNCAN.controller}, ${DUNCAN.pawn}, 'Duncan'),
    (2, ${GURNEY.account}, ${GURNEY.controller}, ${GURNEY.pawn}, 'Gurney');
  ${base(1, "Owned by Duncan")}
  ${base(2, "Duncan is co-owner")}
  ${base(3, "Duncan is associate")}
  ${base(4, "Gurney only")}
  insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values
    (1001, ${DUNCAN.controller}, 1),
    (1002, ${DUNCAN.controller}, 2), (1002, ${GURNEY.controller}, 1),
    (1003, ${DUNCAN.controller}, 3), (1003, ${GURNEY.controller}, 1),
    (1004, ${GURNEY.controller}, 1);
`;

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_player_bases_access",
    unavailableLabel: "the player bases access integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);
    return run(pgTransactionalDb(pool), pool);
  });
}

async function bases(db, player, access) {
  const result = await listBases(db, { playerId: String(player.pawn), pageSize: 5000, ...(access ? { access } : {}) });
  assert.equal(result.capabilities?.bases, true, result.reason);
  return result;
}
const ids = (result) => result.rows.map((row) => Number(row.base_id ?? row.baseId ?? row.id)).sort((a, b) => a - b);

test("real PostgreSQL: the access filter partitions a player's bases by roster rank", async (t) => {
  await withDatabase(t, async (db) => {
    assert.deepEqual(ids(await bases(db, DUNCAN)), [1001, 1002, 1003], "default is every roster rank");
    assert.deepEqual(ids(await bases(db, DUNCAN, "all")), [1001, 1002, 1003]);
    assert.deepEqual(ids(await bases(db, DUNCAN, "owner")), [1001], "rank 1 only");
    assert.deepEqual(ids(await bases(db, DUNCAN, "coowner")), [1002], "rank 2 only");
    assert.deepEqual(ids(await bases(db, DUNCAN, "bogus")), [1001, 1002, 1003], "an unknown level means all");

    const owner = await bases(db, DUNCAN, "owner");
    assert.ok(owner.rows.every((r) => r.relationship === "Owner"));
    const co = await bases(db, DUNCAN, "coowner");
    assert.ok(co.rows.every((r) => r.relationship === "Co-Owner"));
    // The aggregate totals describe exactly the listed scope, not the unfiltered one.
    const totals = (r) => [r.totalCount, r.totalBases, r.totalOwned, r.totalShared, r.totalPieces];
    assert.deepEqual(totals(await bases(db, DUNCAN, "all")), [3, 3, 1, 2, 3], "all: 3 bases, 1 owned, 2 shared");
    assert.deepEqual(totals(owner), [1, 1, 1, 0, 1], "owner: only the owned base");
    assert.deepEqual(totals(co), [1, 1, 0, 1, 1], "co-owner: only the co-owned base");

    // Per player: Gurney owns 1002..1004 and is never shown Duncan-only data.
    assert.deepEqual(ids(await bases(db, GURNEY, "owner")), [1002, 1003, 1004]);
    assert.deepEqual(ids(await bases(db, GURNEY, "coowner")), []);
  });
});

test("real PostgreSQL: a player on no roster lists no bases under any filter", async (t) => {
  await withDatabase(t, async (db, pool) => {
    await pool.query("delete from dune.permission_actor_rank where player_id = 11");
    for (const access of [undefined, "all", "owner", "coowner"]) {
      assert.deepEqual(ids(await bases(db, DUNCAN, access)), [], `access=${access}`);
    }
  });
});
