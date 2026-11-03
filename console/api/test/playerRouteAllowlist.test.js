import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ROUTE_ACTIONS, actionForRoute } from "../src/actions.js";
import { evaluate, resolveAllowedActions } from "../src/policy.js";
import { playerMayCall, playerServerStatusView, statusBodyForSession } from "../src/playerOwnedScope.js";
import { classifyPlayerTierRequest, PLAYER_TIER_ACTIONS } from "../src/playerTierGate.js";

// Operator contract (#1276): a `player` session sees only its own character, the
// bases/vehicles/storage it owns, and its guild including the roster. It never
// sees another player's information. Two gates apply after the IAM policy:
// playerTierGate.js (everything under /api/players and /api/guilds, by id) and the
// allowlist in playerOwnedScope.js (every other route, "open" to the first gate).
// Together they do not depend on what an operator saved in iam-policies.json.

// What the server does for a player once the IAM check has passed: mirrors
// enforcePlayerTier in server.js (pinned by the source checks below).
function playerReachable(method, path) {
  const action = actionForRoute(path, method);
  if (!action || !evaluate({ tier: "player" }, action)) return false;
  if (!PLAYER_TIER_ACTIONS.has(action)) return false;
  const route = classifyPlayerTierRequest(path, method);
  if (route.kind === "open") return playerMayCall(method, path);
  return route.kind !== "deny";
}

const LEAKS = [
  "/api/map/players", "/api/map/poi", "/api/map/spice", "/api/map/partitions", "/api/map/capabilities",
  "/api/map/bases", "/api/map/storage", "/api/map/markers", "/api/map/overlays", "/api/map/services",
  "/api/maps/user-settings/raw", "/api/maps/user-settings/values", "/api/maps/userengine", "/api/maps/usergame",
  "/api/maps/choam-terminals/capture", "/api/maps/memory", "/api/maps/autoscaler",
  "/api/server/doctor", "/api/server/ports", "/api/server/services", "/api/server/funcom-token/check",
  "/api/server/readiness", "/api/map/status", "/api/server/performance", "/api/server/restart-history",
  "/api/base-backups", "/api/base-backups/7/export",
  "/api/players/deleted-characters",
  "/api/players/combat", "/api/settings/realtime-agent", "/api/realtime/objects", "/api/realtime/healthz", "/api/realtime/stream", "/api/maps/combat-state",
  "/api/players/abc123/teleport-destinations", "/api/players/abc123/ban", "/api/players/abc123/character-recovery",
];

for (const path of LEAKS) {
  test(`player may not GET ${path}`, () => {
    assert.equal(playerMayCall("GET", path), false);
    assert.equal(playerReachable("GET", path), false);
  });
}

const OWN_DATA = ["/api/server/status", "/api/bases", "/api/vehicles", "/api/storage"];

for (const path of OWN_DATA) {
  test(`player may GET ${path} (handler scopes or reduces it)`, () => {
    assert.equal(playerMayCall("GET", path), true);
    assert.equal(playerReachable("GET", path), true);
  });
}

test("player may never use a non-GET method on any route", () => {
  for (const key of Object.keys(ROUTE_ACTIONS)) {
    const [, path] = key.split(" ", 2);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(playerMayCall(method, path), false, `${method} ${path}`);
      assert.equal(playerReachable(method, path), false, `${method} ${path}`);
    }
  }
});

test("unknown and malformed paths are denied", () => {
  for (const path of ["", "/", "/api", "/api/unknown", "/api/map/", "api/players", "/API/players", "/api/bases/", "/api/bases/1001", "/api/storage/2001/items", "/api/vehicles/1"]) {
    assert.equal(playerMayCall("GET", path), false, path);
  }
});

test("HEAD, OPTIONS and unusual verbs are never admitted for the player tier", () => {
  for (const method of ["HEAD", "OPTIONS", "TRACE", "CONNECT", "", undefined, null]) assert.equal(playerMayCall(method, "/api/bases"), false, String(method));
  assert.equal(playerMayCall("get", "/api/bases"), true, "verbs are case-insensitive, as Node delivers them upper-case");
});

test("the set of routes a player reaches outside /api/players and /api/guilds is pinned", () => {
  const reachable = Object.entries(ROUTE_ACTIONS)
    .map(([key]) => key.split(" ", 2))
    .filter(([method, path]) => method === "GET" && classifyPlayerTierRequest(path, method).kind === "open" && playerReachable(method, path))
    .map(([, path]) => path);
  // Pinned so that widening the allowlist is a visible, reviewed change.
  assert.deepEqual(reachable.sort(), [
    "/api/bases", "/api/server/status", "/api/storage", "/api/vehicles",
  ]);
});

test("every action the player tier can ever hold is pinned", () => {
  assert.deepEqual([...PLAYER_TIER_ACTIONS].sort(), ["bases:read", "guilds:read", "players:read", "server:read", "storage:read", "vehicles:read"]);
  assert.deepEqual([...resolveAllowedActions("player")].sort(), [...PLAYER_TIER_ACTIONS].sort());
});

test("the request gate applies the player gates after the IAM check and wires the allowlist", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const gate = src.indexOf("!action || !evaluate(session, action)");
  assert.ok(gate > 0, "IAM gate not found");
  assert.match(src.slice(gate, gate + 700), /resolveSessionTier\(session\) === "player"\) \{\s*const blocked = await enforcePlayerTier\(/);
  assert.match(src, /route\.kind === "open"\) return action && !playerMayCall\(method, path\)/);
});

test("/api/auth/me reports no allowed actions for a session whose tier the policy engine rejects", async () => {
  const { resolveSessionTier } = await import("../src/policy.js");
  for (const session of [{}, { tier: "" }, { tier: "root" }, { tier: undefined }, null]) {
    assert.deepEqual(resolveAllowedActions(resolveSessionTier(session)), [], JSON.stringify(session));
  }
  assert.ok(resolveAllowedActions(resolveSessionTier({ tier: "owner" })).length > 0);
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /resolveAllowedActions\(resolveSessionTier\(session\)\)/);
  assert.doesNotMatch(src, /resolveAllowedActions\(session\.tier \|\| "owner"\)/);
});

test("the server status a player gets has no raw output, addresses, containers or ports", () => {
  const body = {
    stdout: "Server IP: 1.2.3.4", stderr: "", exitCode: 0, schemaVersion: 1, ok: true,
    data: {
      summary: { overall: "READY", title: "T", region: "R", mode: "M", serverIp: "1.2.3.4", battlegroup: "sh-secret", population: { current: 1, max: 180 } },
      containers: [{ name: "dune-postgres" }], listeners: [{ name: "pg", port: 5432 }],
      gameServers: [{ map: "Survival_1", status: "Ready", uptime: "1h", serverId: "srv-9", gamePort: 7777 }],
      rabbitmq: { details: "amqp://x" }, fls: { gatewayDbMonitoring: "x" }, database: { worldPartitions: 3 },
    },
  };
  const out = playerServerStatusView(body);
  const text = JSON.stringify(out);
  for (const leak of ["1.2.3.4", "sh-secret", "dune-postgres", "5432", "srv-9", "7777", "amqp", "stdout", "worldPartitions"]) assert.ok(!text.includes(leak), leak);
  assert.equal(out.ok, true);
  assert.equal(out.data.summary.overall, "READY");
  assert.deepEqual(out.data.gameServers, [{ map: "Survival_1", status: "Ready", uptime: "1h" }]);
  assert.deepEqual(playerServerStatusView(null).data.gameServers, []);
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /statusBodyForSession\(session, body\)/);
  assert.equal(statusBodyForSession({ tier: "admin" }, body), body, "operators keep the full status");
  assert.ok(!JSON.stringify(statusBodyForSession({ tier: "player" }, body)).includes("1.2.3.4"));
  assert.ok(!JSON.stringify(statusBodyForSession({ tier: "observer" }, body)).includes("1.2.3.4"), "legacy observer alias is reduced too");
});
