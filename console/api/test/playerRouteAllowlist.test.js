import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ROUTE_ACTIONS, actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";
import { playerMayCall } from "../src/playerScope.js";

// Operator contract (#1276): a `player` session sees only its own character,
// the bases/vehicles/storage it owns, and its guild including the roster. It
// never sees another player's information. The allowlist is a second gate on
// top of the IAM policy so that a stored policy file cannot widen it.

const LEAKS = [
  "/api/players/deleted-characters",
  "/api/map/bases",
  "/api/map/storage",
  "/api/map/markers",
  "/api/map/overlays",
  "/api/map/services",
  "/api/maps/user-settings/raw",
  "/api/maps/user-settings/values",
  "/api/maps/userengine",
  "/api/maps/usergame",
  "/api/maps/choam-terminals/capture",
  "/api/server/doctor",
  "/api/server/ports",
  "/api/server/services",
  "/api/server/funcom-token/check",
  "/api/maps/memory",
  "/api/maps/autoscaler",
];

for (const path of LEAKS) {
  test(`player may not GET ${path}`, () => {
    assert.equal(playerMayCall("GET", path), false);
  });
}

const OWN_DATA = [
  "/api/server/status",
  "/api/server/readiness",
  "/api/players",
  "/api/players/online",
  "/api/players/search",
  "/api/players/abc123",
  "/api/players/abc123/inventory",
  "/api/guilds",
  "/api/guilds/42/members",
  "/api/map/players",
  "/api/map/status",
];

for (const path of OWN_DATA) {
  test(`player may GET ${path} (handler scopes it)`, () => {
    assert.equal(playerMayCall("GET", path), true);
  });
}

test("player may never use a non-GET method on any route", () => {
  for (const key of Object.keys(ROUTE_ACTIONS)) {
    const [, path] = key.split(" ", 2);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(playerMayCall(method, path), false, `${method} ${path}`);
    }
  }
});

test("unknown and malformed paths are denied", () => {
  for (const path of ["", "/", "/api", "/api/unknown", "/api/map/", "api/players", "/API/players", "/api/players/", "/api/players//deleted-characters"]) {
    assert.equal(playerMayCall("GET", path), false, path);
  }
});

test("reserved player sub-paths are denied in every spelling", () => {
  for (const path of ["/api/players/deleted-characters", "/api/players/deleted-characters/", "/api/players/deleted-characters/x", "/api/players/list-settings", "/api/players/list-settings/"]) {
    assert.equal(playerMayCall("GET", path), false, path);
  }
});

test("the allowlist never grants a route the IAM policy denies the player tier", () => {
  // Independent of the allowlist: derive reachability from the real policy.
  for (const [key, action] of Object.entries(ROUTE_ACTIONS)) {
    const [method, path] = key.split(" ", 2);
    if (playerMayCall(method, path)) {
      assert.ok(evaluate({ tier: "player" }, action), `${key} -> ${action}`);
      assert.equal(actionForRoute(path, method), action);
    }
  }
});

test("every exact route a player can reach by policy is either allowed on purpose or denied on purpose", () => {
  const reachable = Object.entries(ROUTE_ACTIONS)
    .filter(([, action]) => evaluate({ tier: "player" }, action))
    .map(([key]) => key.split(" ", 2)[1]);
  const allowed = reachable.filter((path) => playerMayCall("GET", path));
  // Pinned so that widening the allowlist is a visible, reviewed change.
  assert.deepEqual(allowed.sort(), [
    "/api/bases",
    "/api/guilds",
    "/api/map/capabilities",
    "/api/map/partitions",
    "/api/map/players",
    "/api/map/poi",
    "/api/map/spice",
    "/api/map/status",
    "/api/players",
    "/api/players/online",
    "/api/players/search",
    "/api/server/performance",
    "/api/server/readiness",
    "/api/server/restart-history",
    "/api/server/status",
    "/api/storage",
    "/api/vehicles",
  ]);
});

test("the request gate applies the allowlist after the IAM check", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const gate = src.indexOf("!action || !evaluate(session, action)");
  assert.ok(gate > 0, "IAM gate not found");
  const after = src.slice(gate, gate + 900);
  assert.match(after, /session\.tier === "player" && !playerMayCall\(req\.method, path\)/);
});

test("only the exact guild roster path is open, not other guild routes", () => {
  for (const path of ["/api/guilds/42", "/api/guilds/42/members/extra", "/api/guilds/a/b/members", "/api/guilds//members", "/api/guilds/42/members/", "/api/guilds/42/storage"]) {
    assert.equal(playerMayCall("GET", path), false, path);
  }
});

test("/api/auth/me reports no allowed actions for a session whose tier the policy engine rejects", async () => {
  const { resolveAllowedActions, resolveSessionTier } = await import("../src/policy.js");
  for (const session of [{}, { tier: "" }, { tier: "root" }, { tier: undefined }, null]) {
    assert.deepEqual(resolveAllowedActions(resolveSessionTier(session)), [], JSON.stringify(session));
  }
  assert.ok(resolveAllowedActions(resolveSessionTier({ tier: "owner" })).length > 0);
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /resolveAllowedActions\(resolveSessionTier\(session\)\)/);
  assert.doesNotMatch(src, /resolveAllowedActions\(session\.tier \|\| "owner"\)/);
});
