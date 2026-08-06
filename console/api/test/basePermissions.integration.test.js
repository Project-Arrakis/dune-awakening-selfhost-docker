import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { setBasePermissions, listBasePermissions, basePermissionCandidates, baseMapLocation } from "../src/duneDb.js";
import { pgConnectionConfig, pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const { Client } = pg;

// The mocked suite in basePermissions.test.js string-matches SQL and can prove
// what we *intend* to send. It cannot catch the failures that only a real
// PostgreSQL round trip surfaces, and this feature has three of them:
//
//   1. Transposed arguments. permission_set_player_rank(actor_id, player_id, ..)
//      takes two bigints; swapping them is invisible to a mock and writes a rank
//      row keyed on the wrong column against a live database.
//   2. search_path. The shipped procedures reference their tables unqualified
//      and carry no `SET search_path`, so they resolve only because the console
//      connects as a role whose default path reaches the dune schema.
//   3. The notify payload. permission_set_player_rank interpolates its map
//      argument into JSON *unquoted*, so passing a map name rather than the
//      numeric dune.map_names id emits malformed JSON to the game server.
//
// The procedure bodies below are transcribed from the shipped schema so those
// three can be exercised for real. permission_actor_create_or_update_base_marker
// is stubbed: the real one rebuilds map markers, which is the game's concern,
// not ours -- what matters here is that our call reaches the procedure with the
// right arguments and that the notification it emits is well formed.
const OWNER_RANK = 1;
const CO_OWNER_RANK = 2;
const ASSOCIATE_RANK = 3;

// Deliberately different values, mirroring production where the displayed base
// id and the permission actor id never match.
const BASE_ID = 1006;
const ACTOR_ID = 1004;
const ENTITY_ID = 5001;
const MAP_NAME = "DeepDesert";
const MAP_NAME_ID = 7;

const SCHEMA = `
  create schema dune;

  create table dune.buildings (id bigint primary key);
  -- owner_entity_id is nullable in production: it carries an
  -- ON DELETE SET NULL foreign key against fgl_entities. instance_id is the
  -- per-piece tiebreak basePermissionActor/baseMapLocation order by.
  create table dune.building_instances (building_id bigint not null, instance_id integer not null, owner_entity_id bigint);
  create table dune.actor_fgl_entities (entity_id bigint not null, actor_id bigint not null);
  create table dune.actors (id bigint primary key, map text, partition_id bigint, owner_account_id bigint);
  create table dune.map_names (map_name_id smallint primary key, map_name text not null);
  create table dune.permission_actor (actor_id bigint primary key, actor_name text);
  create table dune.permission_actor_rank (permission_actor_id bigint not null, player_id bigint not null, rank smallint not null);
  create table dune.player_state (account_id bigint, player_controller_id bigint, character_name text);

  create function dune.permission_actor_create_or_update_base_marker(in_actor_id bigint, in_player_id bigint, in_rank smallint)
  returns void language plpgsql as $$ begin return; end $$;

  create function dune.permission_set_player_rank(in_actor_id bigint, in_player_id bigint, in_rank smallint, in_map_id text)
  returns void language plpgsql as $$
  declare found_actor_id bigint;
  begin
    select permission_actor_id from permission_actor_rank
      where permission_actor_id = in_actor_id and player_id = in_player_id into found_actor_id;
    if not found then
      insert into permission_actor_rank(permission_actor_id, player_id, rank) values(in_actor_id, in_player_id, in_rank);
    else
      update permission_actor_rank set rank = in_rank
        where permission_actor_rank.permission_actor_id = in_actor_id and player_id = in_player_id;
    end if;
    perform permission_actor_create_or_update_base_marker(in_actor_id, in_player_id, in_rank);
    perform pg_notify('permission_notify_channel',
      format('set_rank#{"ActorId" : %s , "PlayerId" : %s, "PlayerGuildId" : %s, "Rank" : %s, "Map" : %s}',
             in_actor_id, in_player_id, 0, in_rank, in_map_id));
  end $$;

  create function dune.permission_remove_player_rank(in_actor_id bigint, in_player_id bigint)
  returns void language plpgsql as $$
  begin
    delete from permission_actor_rank where permission_actor_id = in_actor_id and player_id = in_player_id;
    perform pg_notify('permission_notify_channel',
      format('remove_rank#{"ActorId" : %s , "PlayerId" : %s}', in_actor_id, in_player_id));
  end $$;
`;

const SEED = `
  insert into dune.buildings (id) values (${BASE_ID});
  insert into dune.building_instances (building_id, instance_id, owner_entity_id) values (${BASE_ID}, 0, ${ENTITY_ID});
  insert into dune.actor_fgl_entities (entity_id, actor_id) values (${ENTITY_ID}, ${ACTOR_ID});
  insert into dune.actors (id, map, partition_id, owner_account_id) values (${ACTOR_ID}, '${MAP_NAME}', 8, null);
  insert into dune.map_names (map_name_id, map_name) values (${MAP_NAME_ID}, '${MAP_NAME}');
  insert into dune.permission_actor (actor_id, actor_name) values (${ACTOR_ID}, 'DD Test');

  -- Account 2 owns three actor rows; only player_controller_id 4 is a real
  -- permission holder. Ids 5 and 6 exist to prove they are rejected.
  insert into dune.actors (id, owner_account_id) values (4, 2), (5, 2), (6, 2), (23, 6), (29, 8);
  insert into dune.player_state (account_id, player_controller_id, character_name)
    values (2, 4, 'DarkShark'), (6, 23, 'Furizu'), (8, 29, 'Yaida'), (99, 900000201, 'Server');

  insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values (${ACTOR_ID}, 4, ${OWNER_RANK});
`;

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_perms",
    unavailableLabel: "the base permission integration test"
  }, async (pool, database) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);
    return run(pool, database);
  });
}

async function ranks(pool) {
  const result = await pool.query(
    "select player_id::text as player_id, rank::int as rank from dune.permission_actor_rank where permission_actor_id = $1 order by rank, player_id",
    [ACTOR_ID]);
  return result.rows.map((row) => ({ playerId: row.player_id, rank: row.rank }));
}

test("real PostgreSQL: a roster save writes through the shipped procedures with the right argument order", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const result = await setBasePermissions(db, BASE_ID, [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "23", rank: ASSOCIATE_RANK }
    ], 32);

    assert.equal(result.ok, true);
    assert.equal(result.actorId, String(ACTOR_ID));
    // Transposed arguments would key the row on the player and store the actor
    // id in player_id -- this is the assertion a mocked test cannot make.
    assert.deepEqual(await ranks(pool), [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "23", rank: ASSOCIATE_RANK }
    ]);
  });
});

test("real PostgreSQL: promoting swaps the owner without ever leaving two", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await setBasePermissions(db, BASE_ID, [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "23", rank: CO_OWNER_RANK }
    ], 32);
    await setBasePermissions(db, BASE_ID, [
      { playerId: "23", rank: OWNER_RANK },
      { playerId: "4", rank: CO_OWNER_RANK }
    ], 32);

    const rows = await ranks(pool);
    assert.deepEqual(rows, [
      { playerId: "23", rank: OWNER_RANK },
      { playerId: "4", rank: CO_OWNER_RANK }
    ]);
    assert.equal(rows.filter((row) => row.rank === OWNER_RANK).length, 1);
  });
});

test("real PostgreSQL: removing a player deletes only that rank row", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await setBasePermissions(db, BASE_ID, [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "23", rank: ASSOCIATE_RANK },
      { playerId: "29", rank: ASSOCIATE_RANK }
    ], 32);
    const result = await setBasePermissions(db, BASE_ID, [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "29", rank: ASSOCIATE_RANK }
    ], 32);

    assert.equal(result.removed, 1);
    assert.deepEqual(await ranks(pool), [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "29", rank: ASSOCIATE_RANK }
    ]);
  });
});

// The procedure interpolates its map argument into the payload unquoted. A text
// map name produces `"Map" : DeepDesert}`, which is not parseable -- so the
// notification the game receives is only valid if we pass the numeric id.
test("real PostgreSQL: the emitted notification payload is well-formed JSON carrying the numeric map id", async (t) => {
  await withDatabase(t, async (pool, database) => {
    const listener = new Client(pgConnectionConfig(database));
    const received = [];
    await listener.connect();
    listener.on("notification", (message) => received.push(message.payload));
    await listener.query("listen permission_notify_channel");

    const db = pgTransactionalDb(pool);
    await setBasePermissions(db, BASE_ID, [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "23", rank: ASSOCIATE_RANK }
    ], 32);

    // NOTIFY is delivered on commit; give the listener a moment to drain.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await listener.query("select 1");
    await listener.end();

    const setRank = received.find((payload) => payload.startsWith("set_rank#"));
    assert.ok(setRank, `expected a set_rank notification, got ${JSON.stringify(received)}`);
    const body = JSON.parse(setRank.slice("set_rank#".length));
    assert.equal(body.ActorId, ACTOR_ID);
    assert.equal(body.PlayerId, 23);
    assert.equal(body.Rank, ASSOCIATE_RANK);
    assert.equal(body.Map, MAP_NAME_ID);
  });
});

// A rank row written against a non-canonical actor id is accepted by the
// procedure and then ignored by the game -- a silent no-op that looks like a
// successful save. Confirmed against a live server before this guard existed.
test("real PostgreSQL: a player id that is not a player_controller_id is refused", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await assert.rejects(
      () => setBasePermissions(db, BASE_ID, [
        { playerId: "4", rank: OWNER_RANK },
        { playerId: "5", rank: ASSOCIATE_RANK }
      ], 32),
      /not a known player character/);
    // The rejection must leave the roster untouched, not half-applied.
    assert.deepEqual(await ranks(pool), [{ playerId: "4", rank: OWNER_RANK }]);
  });
});

test("real PostgreSQL: the roster reads back with resolved names and rank labels", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await setBasePermissions(db, BASE_ID, [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "29", rank: CO_OWNER_RANK }
    ], 32);

    const roster = await listBasePermissions(db, BASE_ID);
    assert.equal(roster.actorId, String(ACTOR_ID));
    assert.equal(roster.mapNameId, MAP_NAME_ID);
    assert.deepEqual(roster.entries.map((entry) => [entry.name, entry.label, entry.canonical]), [
      ["DarkShark", "Owner", true],
      ["Yaida", "Co-Owner", true]
    ]);
  });
});

// listBasePermissions must not silently drop a row the game ignores -- it is the
// one roster state the console can see and the game client cannot.
test("real PostgreSQL: a rank row on a non-canonical actor is surfaced, not hidden", async (t) => {
  await withDatabase(t, async (pool) => {
    await pool.query("insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values ($1, 5, $2)",
      [ACTOR_ID, ASSOCIATE_RANK]);
    const roster = await listBasePermissions(pgTransactionalDb(pool), BASE_ID);
    const orphan = roster.entries.find((entry) => entry.playerId === "5");
    assert.ok(orphan, "the ignored row must still be listed");
    assert.equal(orphan.canonical, false);
    // The name still resolves through the account, which is why the console can
    // show it meaningfully rather than as a bare id.
    assert.equal(orphan.name, "DarkShark");
  });
});

// building_instances.owner_entity_id is nullable in production (ON DELETE SET
// NULL against fgl_entities), so a base can exist in dune.buildings while its
// owning entity link is broken. That must surface a distinct, clear error --
// not the same "not found" message a genuinely deleted base id gets, which
// would read as a client-side glitch to an operator looking at a base that is
// plainly visible in the table.
test("real PostgreSQL: a base with a broken owner-entity link gets a clear error, not 'not found'", async (t) => {
  await withDatabase(t, async (pool) => {
    const orphanBaseId = 2000;
    await pool.query("insert into dune.buildings (id) values ($1)", [orphanBaseId]);
    await pool.query("insert into dune.building_instances (building_id, instance_id, owner_entity_id) values ($1, 0, null)", [orphanBaseId]);

    const db = pgTransactionalDb(pool);
    await assert.rejects(
      () => listBasePermissions(db, orphanBaseId),
      /no resolvable owner entity/);
    // A genuinely nonexistent base id must still get the original message --
    // the left-join restructuring must not blur the two cases together.
    await assert.rejects(
      () => listBasePermissions(db, 999999),
      /That base was not found/);
  });
});

// A base can legitimately have several building_instances rows ("pieces") --
// listBases' piece_count and exportBaseAsBlueprint's multi-piece fetch both
// depend on that. Before the left-join fix's order by, an orphaned piece
// could nondeterministically beat a sibling piece that resolves fine. This
// seeds one orphaned piece alongside the SEED's already-valid piece on the
// same base and proves resolution is stable regardless of insertion order.
test("real PostgreSQL: a base with one orphaned piece and one valid piece still resolves the valid one", async (t) => {
  await withDatabase(t, async (pool) => {
    // instance_id 1, inserted after the SEED's valid instance_id 0 -- if the
    // missing order by regressed, an unordered LIMIT 1 could return this one.
    await pool.query("insert into dune.building_instances (building_id, instance_id, owner_entity_id) values ($1, 1, null)", [BASE_ID]);

    const db = pgTransactionalDb(pool);
    const roster = await listBasePermissions(db, BASE_ID);
    assert.equal(roster.actorId, String(ACTOR_ID));

    const location = await baseMapLocation(db, BASE_ID);
    assert.equal(location.map, MAP_NAME);
  });
});

test("real PostgreSQL: baseMapLocation distinguishes a broken owner-entity link from a missing base id", async (t) => {
  await withDatabase(t, async (pool) => {
    const orphanBaseId = 2001;
    await pool.query("insert into dune.buildings (id) values ($1)", [orphanBaseId]);
    await pool.query("insert into dune.building_instances (building_id, instance_id, owner_entity_id) values ($1, 0, null)", [orphanBaseId]);

    const db = pgTransactionalDb(pool);
    await assert.rejects(
      () => baseMapLocation(db, orphanBaseId),
      /no resolvable owner entity/);
    await assert.rejects(
      () => baseMapLocation(db, 999999),
      /That base was not found/);
    // The unbroken case is unaffected.
    const location = await baseMapLocation(db, BASE_ID);
    assert.equal(location.map, MAP_NAME);
  });
});

test("real PostgreSQL: the candidate picker returns player_controller_ids and excludes system accounts", async (t) => {
  await withDatabase(t, async (pool) => {
    const candidates = await basePermissionCandidates(pgTransactionalDb(pool), { limit: 50 });
    const ids = candidates.map((row) => row.playerId);
    assert.deepEqual(ids.sort(), ["23", "29", "4"].sort());
    assert.ok(!candidates.some((row) => row.name === "Server"), "system accounts must not be offered");
    // 5 and 6 belong to the same account as 4 but are not controller ids.
    assert.ok(!ids.includes("5") && !ids.includes("6"));
  });
});
