import test from "node:test";
import assert from "node:assert/strict";
import { setBasePermissions, listBasePermissions, basePermissionSystemCustodian, transferBaseToSystemCustodian } from "../src/duneDb.js";

const SUPPORTED_TABLES = ["dune.permission_actor_rank", "dune.permission_actor", "dune.actors", "dune.player_state", "dune.map_names"];
const SUPPORTED_FUNCTIONS = [
  "dune.permission_set_player_rank(bigint,bigint,smallint,text)",
  "dune.permission_remove_player_rank(bigint,bigint)"
];

// The displayed base_id and the permission actor id are deliberately different
// here, mirroring production where they differ for every base.
const BASE_ID = 1006;
const ACTOR_ID = "1004";

function createDb({ existing = [], canonicalPlayers = ["4", "23", "29", "437", "900000201"], mapNameId = 7, buildings = "found", custodians = [{ player_id: "900000201", character_name: "Server" }] } = {}) {
  const calls = [];
  const db = {
    calls,
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        return { rows: [{ exists: SUPPORTED_TABLES.includes(String(values[0] || "")) }] };
      }
      if (text.includes("to_regprocedure")) {
        return { rows: [{ exists: SUPPORTED_FUNCTIONS.includes(String(values[0] || "")) }] };
      }
      if (text.includes("from dune.buildings b")) {
        // "missing" mirrors a base id that does not exist at all; "orphaned"
        // mirrors building_instances.owner_entity_id being null (it is
        // nullable, ON DELETE SET NULL against fgl_entities) so the left-join
        // chain resolves the buildings row but not down to an actor.
        if (buildings === "missing") return { rows: [] };
        // Matches the real query's coalesce(...) wrapping: a genuine orphaned
        // row never comes back with literal nulls for these three fields.
        if (buildings === "orphaned") return { rows: [{ actor_id: null, map: "", map_name_id: 0, partition_id: 0 }] };
        return { rows: [{ actor_id: ACTOR_ID, map: "DeepDesert", map_name_id: mapNameId, partition_id: 59 }] };
      }
      if (text.includes("for update")) return { rows: [{ id: ACTOR_ID }], rowCount: 1 };
      if (text.includes("from dune.permission_actor_rank")) {
        return { rows: existing.map((entry) => ({ player_id: entry.playerId, rank: entry.rank })) };
      }
      if (text.includes("player_controller_id = any")) {
        const requested = values[0] || [];
        return { rows: requested.filter((id) => canonicalPlayers.includes(String(id))).map((id) => ({ player_id: String(id) })) };
      }
      if (text.includes("lower(btrim(coalesce(ps.character_name")) return { rows: custodians };
      return { rows: [] };
    },
    transaction: async (fn) => fn(db)
  };
  return db;
}

function procCalls(db, name) {
  return db.calls.filter((call) => call.text.includes(name)).map((call) => call.values);
}

test("setBasePermissions rejects a roster without exactly one owner", async () => {
  await assert.rejects(
    () => setBasePermissions(createDb(), BASE_ID, [{ playerId: "4", rank: 2 }]),
    /exactly one Owner/);
  await assert.rejects(
    () => setBasePermissions(createDb(), BASE_ID, [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 1 }]),
    /only have one Owner/);
});

test("setBasePermissions rejects invalid ranks and duplicate players", async () => {
  await assert.rejects(
    () => setBasePermissions(createDb(), BASE_ID, [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 4 }]),
    /not a valid base permission rank/);
  await assert.rejects(
    () => setBasePermissions(createDb(), BASE_ID, [{ playerId: "4", rank: 1 }, { playerId: "4", rank: 3 }]),
    /listed twice/);
});

// The cap comes from live server config, so it arrives as an argument rather
// than a constant. Passing a small one proves it is actually enforced.
test("setBasePermissions enforces the configured cap", async () => {
  await assert.rejects(
    () => setBasePermissions(createDb(), BASE_ID, [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 3 }], 1),
    /above the configured maximum of 1/);
});

// A rank row written against a non-canonical actor id is accepted by the shipped
// procedure and then ignored by the game -- confirmed live. Catching it here is
// the difference between a no-op that looks successful and a clear error.
test("setBasePermissions refuses a player id that is not a player_controller_id", async () => {
  await assert.rejects(
    () => setBasePermissions(createDb({ canonicalPlayers: ["4"] }), BASE_ID, [
      { playerId: "4", rank: 1 },
      { playerId: "5", rank: 3 }
    ]),
    /not a known player character/);
});

test("setBasePermissions refuses a base whose map has no map_names entry", async () => {
  await assert.rejects(
    () => setBasePermissions(createDb({ mapNameId: 0 }), BASE_ID, [{ playerId: "4", rank: 1 }]),
    /no dune.map_names entry/);
});

test("listBasePermissions rejects a base id that does not exist", async () => {
  await assert.rejects(
    () => listBasePermissions(createDb({ buildings: "missing" }), 999999),
    /That base was not found/);
});

test("listBasePermissions surfaces a clear error when the base's owner-entity link is broken", async () => {
  await assert.rejects(
    () => listBasePermissions(createDb({ buildings: "orphaned" }), BASE_ID),
    /no resolvable owner entity/);
});

test("setBasePermissions surfaces a clear error when the base's owner-entity link is broken", async () => {
  await assert.rejects(
    () => setBasePermissions(createDb({ buildings: "orphaned" }), BASE_ID, [{ playerId: "4", rank: 1 }]),
    /no resolvable owner entity/);
});

test("setBasePermissions writes through the shipped procedures, never raw DML", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }] });
  await setBasePermissions(db, BASE_ID, [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 3 }]);
  const written = db.calls.filter((call) => /insert into|update .*permission_actor_rank|delete from/i.test(call.text));
  assert.deepEqual(written, [], "permission rows must only be written by the game's own procedures");
  assert.equal(procCalls(db, "permission_set_player_rank").length, 1);
});

test("setBasePermissions passes the numeric map_name_id to the notify payload", async () => {
  const db = createDb({ existing: [] });
  await setBasePermissions(db, BASE_ID, [{ playerId: "4", rank: 1 }]);
  const [values] = procCalls(db, "permission_set_player_rank");
  // Not "DeepDesert": the procedure interpolates this unquoted into JSON.
  assert.equal(values[3], "7");
});

test("setBasePermissions skips unchanged rows", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }, { playerId: "29", rank: 2 }] });
  const result = await setBasePermissions(db, BASE_ID, [{ playerId: "4", rank: 1 }, { playerId: "29", rank: 2 }]);
  assert.equal(procCalls(db, "permission_set_player_rank").length, 0);
  assert.equal(procCalls(db, "permission_remove_player_rank").length, 0);
  assert.equal(result.added, 0);
  assert.equal(result.reranked, 0);
  assert.equal(result.removed, 0);
});

// The marker refresh inside permission_set_player_rank resolves the owner with a
// LIMIT 1 over rank-1 rows, so a moment with two owners could stamp the wrong
// name onto the base marker. The outgoing owner must be demoted first.
test("setBasePermissions demotes the outgoing owner before promoting the new one", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 3 }] });
  await setBasePermissions(db, BASE_ID, [{ playerId: "23", rank: 1 }, { playerId: "4", rank: 2 }]);
  const ranks = procCalls(db, "permission_set_player_rank").map((values) => ({ playerId: String(values[1]), rank: values[2] }));
  assert.deepEqual(ranks, [{ playerId: "4", rank: 2 }, { playerId: "23", rank: 1 }]);
});

test("setBasePermissions removes dropped players before writing the owner", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 3 }] });
  const result = await setBasePermissions(db, BASE_ID, [{ playerId: "29", rank: 1 }]);
  const order = db.calls
    .filter((call) => /permission_remove_player_rank|permission_set_player_rank/.test(call.text))
    .map((call) => call.text.includes("remove") ? "remove" : "set");
  assert.deepEqual(order, ["remove", "remove", "set"]);
  assert.equal(result.removed, 2);
  assert.equal(result.added, 1);
});

// The procedures resolve their own unqualified table names through search_path,
// which works only because the console connects as the `dune` role. Setting it
// explicitly keeps the feature working if that ever changes.
test("setBasePermissions pins search_path for the transaction", async () => {
  const db = createDb({ existing: [] });
  await setBasePermissions(db, BASE_ID, [{ playerId: "4", rank: 1 }]);
  assert.ok(db.calls.some((call) => /set local search_path to dune/.test(call.text)));
});

// The lock has to be on a row guaranteed to exist. A base whose roster is being
// fully replaced may have no rank rows, and `for update` over zero rows
// serializes nothing at all.
test("setBasePermissions locks the claim actor row, not the rank rows", async () => {
  const db = createDb({ existing: [] });
  await setBasePermissions(db, BASE_ID, [{ playerId: "4", rank: 1 }]);
  const lock = db.calls.find((call) => call.text.includes("for update"));
  assert.match(lock.text, /from dune\.actors/);
  assert.deepEqual(lock.values, [ACTOR_ID]);
});

test("system custodian detection requires one unambiguous canonical Server identity", async () => {
  assert.deepEqual(await basePermissionSystemCustodian(createDb()), {
    available: true,
    playerId: "900000201",
    name: "Server"
  });
  assert.match((await basePermissionSystemCustodian(createDb({ custodians: [] }))).reason, /No canonical Server/);
  assert.match((await basePermissionSystemCustodian(createDb({
    custodians: [
      { player_id: "900000201", character_name: "Server" },
      { player_id: "900000202", character_name: "Server" }
    ]
  }))).reason, /More than one/);
});

test("transferBaseToSystemCustodian preserves access, demotes the owner, and promotes Server last", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }, { playerId: "29", rank: 2 }] });
  const result = await transferBaseToSystemCustodian(db, BASE_ID);
  const ranks = procCalls(db, "permission_set_player_rank").map((values) => ({ playerId: String(values[1]), rank: values[2] }));
  assert.deepEqual(ranks, [
    { playerId: "4", rank: 2 },
    { playerId: "900000201", rank: 1 }
  ]);
  assert.equal(result.total, 3);
  assert.equal(result.systemCustodian.playerId, "900000201");
  assert.match(result.message, /Server system custodian/);
});

test("transferBaseToSystemCustodian refuses a missing or ambiguous Server identity", async () => {
  await assert.rejects(
    () => transferBaseToSystemCustodian(createDb({ custodians: [] }), BASE_ID),
    /No canonical Server/);
  await assert.rejects(
    () => transferBaseToSystemCustodian(createDb({ custodians: [
      { player_id: "900000201", character_name: "Server" },
      { player_id: "900000202", character_name: "Server" }
    ] }), BASE_ID),
    /More than one/);
});

test("listBasePermissions labels ranks and flags rows the game ignores", async () => {
  const db = createDb();
  db.query = async (text, values = []) => {
    if (text.includes("to_regclass")) return { rows: [{ exists: SUPPORTED_TABLES.includes(String(values[0] || "")) }] };
    if (text.includes("to_regprocedure")) return { rows: [{ exists: SUPPORTED_FUNCTIONS.includes(String(values[0] || "")) }] };
    if (text.includes("from dune.buildings b")) {
      return { rows: [{ actor_id: ACTOR_ID, map: "DeepDesert", map_name_id: 7, partition_id: 59 }] };
    }
    return { rows: [
      { player_id: "4", character_name: "DarkShark", rank: 1, canonical: true },
      { player_id: "29", character_name: "Yaida", rank: 2, canonical: true },
      { player_id: "5", character_name: "DarkShark", rank: 3, canonical: false }
    ] };
  };
  const result = await listBasePermissions(db, BASE_ID);
  assert.equal(result.actorId, ACTOR_ID);
  assert.deepEqual(result.entries.map((entry) => entry.label), ["Owner", "Co-Owner", "Associate"]);
  assert.deepEqual(result.entries.map((entry) => entry.canonical), [true, true, false]);
});
