import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyPlayerTierRequest as c, PLAYER_TIER_ACTIONS } from "../src/playerTierGate.js";
import { listGuilds, guildIdsForPlayerControllers } from "../src/duneDb.js";

test("player tier may only ever hold players:read and guilds:read", () => {
  assert.deepEqual([...PLAYER_TIER_ACTIONS].sort(), ["guilds:read", "players:read"]);
});

test("routes outside /api/players and /api/guilds are not this gate's business", () => {
  assert.deepEqual(c("/api/server/status", "GET"), { kind: "open" });
  assert.deepEqual(c("/api/playersx", "GET"), { kind: "open" });
});

test("list routes are scoped lists, own sub-resources are id-checked", () => {
  for (const p of ["/api/players", "/api/players/online", "/api/players/search", "/api/guilds"]) {
    assert.deepEqual(c(p, "GET"), { kind: "scoped-list" }, p);
  }
  assert.deepEqual(c("/api/players/42", "GET"), { kind: "own-player", id: "42" });
  for (const sub of ["inventory", "vehicles", "bases", "currency", "solaris-coin"]) {
    assert.deepEqual(c(`/api/players/42/${sub}`, "GET"), { kind: "own-player", id: "42" }, sub);
  }
  assert.deepEqual(c("/api/guilds/7/members", "GET"), { kind: "own-guild", id: "7" });
});

test("everything else under players/guilds is denied, including sensitive sub-routes", () => {
  for (const p of [
    "/api/players/42/position", "/api/players/42/vitals", "/api/players/42/teleport-destinations",
    "/api/players/42/character-recovery", "/api/players/42/ban", "/api/players/42/progression",
    "/api/players/42/inventory/", "/api/players/42/", "/api/players//inventory", "/api/players/42/inventory/extra",
    "/api/guilds/7", "/api/guilds/7/", "/api/guilds/7/members/9", "/api/guilds/",
    "/api/players/online/extra", "/api/players/42/../43"
  ]) {
    assert.deepEqual(c(p, "GET"), { kind: "deny" }, p);
  }
});

test("non-GET is always denied on guarded paths", () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.deepEqual(c("/api/players/42/inventory", m), { kind: "deny" }, m);
    assert.deepEqual(c("/api/guilds", m), { kind: "deny" }, m);
  }
});

function fakeDb(rows = []) {
  const calls = [];
  return { calls, query: async (text, values) => {
    calls.push({ text, values });
    if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
    if (text.includes("information_schema.columns")) {
      return { rows: ["guild_id", "guild_name", "player_id", "role_id", "player_controller_id", "account_id", "player_pawn_id"].map((column_name) => ({ column_name })) };
    }
    return { rows, rowCount: rows.length };
  } };
}

test("listGuilds fails closed for an empty guild scope and scopes the totals", async () => {
  const db = fakeDb();
  const result = await listGuilds(db, { guildIds: [] });
  const queries = db.calls.filter((x) => x.text.includes("dune.guilds"));
  assert.ok(queries.some((x) => /and false/.test(x.text)));
  assert.equal(db.calls.some((x) => /select count\(\*\)::int as total_guilds from dune\.guilds/.test(x.text)), false, "unscoped total must not run");
  assert.equal(result.totalGuilds, 0);
});

test("listGuilds scope binds numeric guild ids only and leaves undefined unscoped", async () => {
  const db = fakeDb();
  await listGuilds(db, { guildIds: ["7", "x'; drop", "0", 9, "7"] });
  const q = db.calls.find((x) => /any\(\$1::bigint\[\]\)/.test(x.text));
  assert.ok(q, "scoped query uses a bigint[] parameter");
  assert.deepEqual(q.values[0], ["7", "9"]);
  const db2 = fakeDb();
  await listGuilds(db2, {});
  assert.equal(db2.calls.some((x) => /and false|any\(\$1::bigint/.test(x.text)), false);
  assert.ok(db2.calls.some((x) => /total_guilds from dune\.guilds/.test(x.text)));
});

test("guildIdsForPlayerControllers drops non-numeric ids and returns [] without a query when none are left", async () => {
  const db = fakeDb();
  assert.deepEqual(await guildIdsForPlayerControllers(db, ["abc", "", "0", null]), []);
  assert.equal(db.calls.some((x) => x.text.includes("guild_members gm")), false);
  const db2 = fakeDb([{ guild_id: 7 }, { guild_id: "9" }]);
  assert.deepEqual(await guildIdsForPlayerControllers(db2, ["5"]), ["7", "9"]);
  assert.deepEqual(db2.calls.find((x) => x.text.includes("guild_members gm")).values, [["5"]]);
});

// Source-wiring guards (behavioural coverage of the helpers is above).
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
test("the gate runs right after the policy check and resolves ownership from the controller id", () => {
  const evalAt = server.indexOf("if (!action || !evaluate(session, action))");
  const gateAt = server.indexOf('resolveSessionTier(session) === "player"', evalAt);
  assert.ok(evalAt > 0 && gateAt > evalAt && gateAt - evalAt < 600, "gate directly follows evaluate()");
  assert.match(server, /target\.controllerId && scope\.ids\.has\(String\(target\.controllerId\)\)/);
  assert.match(server, /guildIds: await playerGuildScopeIds\(session, db\)/);
});
test("no session-creation site can store the legacy observer tier", () => {
  assert.doesNotMatch(server, /tier:\s*"observer"/);
  assert.match(server, /tier: normalizeTier\(resolved\.tier\)/);
});

test("scoped guild totals count only the caller's guilds and an over-long id is dropped", async () => {
  const db = fakeDb();
  await listGuilds(db, { guildIds: ["7", "9999999999999999999"] });
  const totals = db.calls.find((x) => /select count\(\*\)::int as total_guilds from dune\.guilds g where/.test(x.text));
  assert.ok(totals, "scoped total query runs");
  assert.deepEqual(totals.values, [["7"]]);
});

test("the gate accepts only canonical integer ids and the OAuth audit logs the normalized tier", () => {
  assert.match(server, /\^\[1-9\]\[0-9\]\{0,17\}\$/);
  assert.match(server, /tier: normalizeTier\(resolved\.tier\) \}\)/);
});
