import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WRITE_ACTION_ROUTES,
  resolveWriteActionRoute,
  selfCheckWriteActionRoutes,
  checkConfirmPhrasesAgainstRealHandlers,
  validatePlayerId,
  validateBaseId,
  validateGuildId,
  matchesWriteActionTarget,
  setRequiresDualConfirmationForTests,
  resetRequiresDualConfirmationOverridesForTests
} from "../src/integrations/discord/writeActionRoutes.js";
import { WRITE_ACTION_MIN_TIER } from "../src/integrations/discord/writeActionMinTier.js";

test("selfCheckWriteActionRoutes: clean against real actions.js -- every entry resolves to a real route with a matching policyAction", () => {
  const problems = selfCheckWriteActionRoutes();
  assert.deepEqual(problems, []);
});

// [Layer 3 integration audit fix, MEDIUM, issue #1039] Mutation-tested: a
// WRITE_ACTION_ROUTES entry with no matching WRITE_ACTION_MIN_TIER entry
// used to pass boot silently. Deletes and restores a real min-tier entry
// (rather than adding a fake WRITE_ACTION_ROUTES entry) so this test can
// never itself go stale relative to whichever action set is real at the
// time it runs.
test("selfCheckWriteActionRoutes: flags a WRITE_ACTION_ROUTES entry with no matching WRITE_ACTION_MIN_TIER entry", () => {
  const [someAction] = Object.keys(WRITE_ACTION_ROUTES);
  const savedMinTier = WRITE_ACTION_MIN_TIER[someAction];
  delete WRITE_ACTION_MIN_TIER[someAction];
  try {
    const problems = selfCheckWriteActionRoutes();
    assert.ok(
      problems.some((p) => p.includes(someAction) && p.includes("no matching WRITE_ACTION_MIN_TIER entry")),
      `expected a problem naming "${someAction}", got: ${JSON.stringify(problems)}`
    );
  } finally {
    WRITE_ACTION_MIN_TIER[someAction] = savedMinTier;
  }
});

test("checkConfirmPhrasesAgainstRealHandlers: clean -- the real carePackage.js handlers actually reject a wrong confirmation with the phrase this table declares", async () => {
  const problems = await checkConfirmPhrasesAgainstRealHandlers();
  assert.deepEqual(problems, []);
});

test("checkConfirmPhrasesAgainstRealHandlers: regression proof -- catches issue #1018's exact shape (a missing confirmPhrase for a real-handler-checked action), independently of the hand-maintained completeness test", async () => {
  // A routes table shaped exactly like #1018's real bug: carepackage.grant
  // declared with NO confirmPhrase, even though the real grantCarePackage()
  // handler unconditionally requires one. The injectable `routes` parameter
  // lets this test call the real checker against this broken shape without
  // mutating WRITE_ACTION_ROUTES itself (deep-frozen by design).
  const brokenRoutes = {
    "carepackage.grant": { confirmPhrase: undefined },
    "carepackage.grant-all": WRITE_ACTION_ROUTES["carepackage.grant-all"]
  };
  const problems = await checkConfirmPhrasesAgainstRealHandlers(brokenRoutes);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /carepackage\.grant.*no confirmPhrase set/);
});

test("checkConfirmPhrasesAgainstRealHandlers: catches a WRONG (drifted) confirmPhrase, not just a missing one", async () => {
  const driftedRoutes = {
    "carepackage.grant": { confirmPhrase: "GRANT SOMETHING ELSE" },
    "carepackage.grant-all": WRITE_ACTION_ROUTES["carepackage.grant-all"]
  };
  const problems = await checkConfirmPhrasesAgainstRealHandlers(driftedRoutes);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /carepackage\.grant.*does not mention the table's declared confirmPhrase/);
});

test("resolveWriteActionRoute: poisoned keys never resolve (Object.hasOwn guard, not a bare index)", () => {
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(resolveWriteActionRoute(key, {}), null);
  }
});

test("resolveWriteActionRoute: unknown action returns null, never throws", () => {
  assert.equal(resolveWriteActionRoute("player.does-not-exist", {}), null);
});

test("resolveWriteActionRoute: real entries resolve method+path+policyAction+auditAction correctly", () => {
  const kick = resolveWriteActionRoute("player.kick", { playerId: "Server#4242" });
  assert.equal(kick.method, "POST");
  assert.equal(kick.path, "/api/players/Server%234242/kick");
  assert.equal(kick.policyAction, "players:moderate");
  assert.equal(kick.auditAction, "task.adminKick");
  assert.equal(kick.confirmPhrase, null);

  const ban = resolveWriteActionRoute("player.ban", { playerId: "Server#4242" });
  assert.equal(ban.confirmPhrase, "BAN PLAYER");

  const grantAll = resolveWriteActionRoute("carepackage.grant-all", {});
  assert.equal(grantAll.method, "POST");
  assert.equal(grantAll.path, "/api/care-package/grant-eligible");
});

test("validatePlayerId: rejects path-traversal-shaped values", () => {
  for (const bad of ["..", "../", "a/../b", ".", "a.b", "a/b", "", 123, null, undefined]) {
    assert.throws(() => validatePlayerId(bad), /Invalid playerId shape/);
  }
});

test("validatePlayerId: accepts real Funcom-style ids", () => {
  assert.equal(validatePlayerId("Server#4242"), "Server#4242");
  assert.equal(validatePlayerId("5E121CE000000001"), "5E121CE000000001");
});

test("validatePlayerId: accepts underscore/colon/hyphen (issue #1051), still rejects dots", () => {
  assert.equal(validatePlayerId("steam_76561198000000000"), "steam_76561198000000000");
  assert.equal(validatePlayerId("steam:76561198000000000"), "steam:76561198000000000");
  assert.equal(validatePlayerId("Server-4242"), "Server-4242");
  for (const stillBad of ["a.b", ".."]) {
    assert.throws(() => validatePlayerId(stillBad), /Invalid playerId shape/);
  }
});

test("validateBaseId: rejects non-numeric and traversal-shaped values", () => {
  for (const bad of ["..", "1.5", "01", "-1", "0", "abc", "1/2", ""]) {
    assert.throws(() => validateBaseId(bad), /Invalid baseId shape/);
  }
  assert.equal(validateBaseId("1"), "1");
  assert.equal(validateBaseId("12345"), "12345");
});

test("validateGuildId: rejects path-traversal-shaped values", () => {
  for (const bad of ["..", "a.b", "a/b", ""]) {
    assert.throws(() => validateGuildId(bad), /Invalid guildId shape/);
  }
  assert.equal(validateGuildId("abc123"), "abc123");
});

test("WRITE_ACTION_ROUTES: throws for malformed params instead of silently building an unsafe path", () => {
  assert.throws(() => resolveWriteActionRoute("player.kick", { playerId: ".." }));
  assert.throws(() => resolveWriteActionRoute("base.refill-water", { baseId: "../1" }));
  assert.throws(() => resolveWriteActionRoute("guild.remove", { guildId: "1", playerId: "../etc" }));
});

test("WRITE_ACTION_ROUTES: is frozen -- no entry can be mutated at runtime", () => {
  assert.throws(() => {
    WRITE_ACTION_ROUTES["player.kick"].method = "GET";
  }, TypeError);
});

test("WRITE_ACTION_ROUTES: exactly 28 entries, matching the design doc's own count", () => {
  assert.equal(Object.keys(WRITE_ACTION_ROUTES).length, 28);
});

test("WRITE_ACTION_ROUTES: broadcast.* is intentionally absent", () => {
  assert.equal(Object.hasOwn(WRITE_ACTION_ROUTES, "broadcast.send"), false);
});

test("WRITE_ACTION_ROUTES: every entry with a confirmPhrase matches the real doc-verified value", () => {
  const expected = {
    "player.ban": "BAN PLAYER",
    "player.clear-backpack": "CLEAN INVENTORY",
    "map.spawn": "SPAWN MAP",
    "map.despawn": "DESPAWN MAP",
    "map.respawn": "RESTART MAP",
    "carepackage.history-clear": "CLEAR GRANT HISTORY",
    "carepackage.enable": "ENABLE CARE PACKAGE",
    "carepackage.disable": "DISABLE CARE PACKAGE",
    "carepackage.scan": "RUN CARE PACKAGE SCAN",
    "carepackage.grant": "GRANT CARE PACKAGE",
    "carepackage.grant-all": "GRANT CARE PACKAGE TO ELIGIBLE PLAYERS",
    "server.stop": "STOP SERVER"
  };
  for (const [action, phrase] of Object.entries(expected)) {
    assert.equal(WRITE_ACTION_ROUTES[action].confirmPhrase, phrase, `${action} confirmPhrase mismatch`);
  }
  // Completeness, not just correctness (issue #1016): every action absent
  // from `expected` above must have no confirmPhrase at all -- a table entry
  // silently missing a phrase its own real target route unconditionally
  // requires is exactly how carepackage.enable/disable/scan went undetected
  // (write/execute never injects `confirmation` into the loopback body
  // unless confirmPhrase is set, so the real route always 400'd).
  for (const action of Object.keys(WRITE_ACTION_ROUTES)) {
    if (Object.hasOwn(expected, action)) continue;
    assert.ok(!WRITE_ACTION_ROUTES[action].confirmPhrase, `${action} has an undocumented confirmPhrase`);
  }
});

test("matchesWriteActionTarget: every real action's own resolved (method, path) matches itself, exhaustively across all 28 entries", () => {
  for (const action of Object.keys(WRITE_ACTION_ROUTES)) {
    const resolved = resolveWriteActionRoute(action, { playerId: "Server#4242", baseId: "1", guildId: "abc123" });
    assert.equal(matchesWriteActionTarget(action, resolved.method, resolved.path), true, `${action} should match its own resolved target`);
  }
});

test("matchesWriteActionTarget: rejects a DIFFERENT action's target sharing the same IAM policyAction class (player.kick vs player.ban both resolve to players:moderate)", () => {
  const banResolved = resolveWriteActionRoute("player.ban", { playerId: "Server#4242" });
  assert.equal(matchesWriteActionTarget("player.kick", banResolved.method, banResolved.path), false);
});

test("matchesWriteActionTarget: ban and unban share the identical path, disambiguated only by method -- both directions must be correct", () => {
  const banResolved = resolveWriteActionRoute("player.ban", { playerId: "Server#4242" });
  const unbanResolved = resolveWriteActionRoute("player.unban", { playerId: "Server#4242" });
  assert.equal(banResolved.path, unbanResolved.path, "precondition: they really do share a path");
  assert.equal(matchesWriteActionTarget("player.ban", unbanResolved.method, unbanResolved.path), false);
  assert.equal(matchesWriteActionTarget("player.unban", banResolved.method, banResolved.path), false);
  assert.equal(matchesWriteActionTarget("player.ban", banResolved.method, banResolved.path), true);
  assert.equal(matchesWriteActionTarget("player.unban", unbanResolved.method, unbanResolved.path), true);
});

test("matchesWriteActionTarget: rejects an unrelated real Core route entirely (a credential scoped to the write bridge must never reach database:query/settings:write class routes)", () => {
  assert.equal(matchesWriteActionTarget("player.kick", "POST", "/api/settings/admin-password"), false);
  assert.equal(matchesWriteActionTarget("player.kick", "POST", "/api/database/query"), false);
});

test("matchesWriteActionTarget: rejects wrong method for an otherwise-correct path", () => {
  const resolved = resolveWriteActionRoute("player.kick", { playerId: "Server#4242" });
  assert.equal(matchesWriteActionTarget("player.kick", "DELETE", resolved.path), false);
  assert.equal(matchesWriteActionTarget("player.kick", "GET", resolved.path), false);
});

test("matchesWriteActionTarget: rejects an unknown action name outright, including poisoned keys", () => {
  assert.equal(matchesWriteActionTarget("player.does-not-exist", "POST", "/api/players/x/kick"), false);
  assert.equal(matchesWriteActionTarget("constructor", "POST", "/api/players/x/kick"), false);
});

test("matchesWriteActionTarget: defense-in-depth -- rejects any path containing '..' outright, even though real callers always pass an already-normalized path", () => {
  assert.equal(matchesWriteActionTarget("player.kick", "POST", "/api/players/../kick"), false);
  assert.equal(matchesWriteActionTarget("player.kick", "POST", "/api/players/..%2Fkick/kick"), false);
});

test("matchesWriteActionTarget: rejects a non-string path without throwing", () => {
  assert.doesNotThrow(() => matchesWriteActionTarget("player.kick", "POST", undefined));
  assert.equal(matchesWriteActionTarget("player.kick", "POST", undefined), false);
  assert.equal(matchesWriteActionTarget("player.kick", "POST", null), false);
});

test("matchesWriteActionTarget: multi-segment param routes (guild.remove has two wildcard segments) match exactly and don't cross-match guild.add's single-segment shape", () => {
  const addResolved = resolveWriteActionRoute("guild.add", { guildId: "abc123" });
  const removeResolved = resolveWriteActionRoute("guild.remove", { guildId: "abc123", playerId: "Server#4242" });
  assert.equal(matchesWriteActionTarget("guild.add", addResolved.method, addResolved.path), true);
  assert.equal(matchesWriteActionTarget("guild.remove", removeResolved.method, removeResolved.path), true);
  assert.equal(matchesWriteActionTarget("guild.add", removeResolved.method, removeResolved.path), false);
  assert.equal(matchesWriteActionTarget("guild.remove", addResolved.method, addResolved.path), false);
});

test("WRITE_ACTION_ROUTES: backup.create and updates.* resolve to their real Core routes", () => {
  const backup = resolveWriteActionRoute("backup.create", {});
  assert.deepEqual(backup, { method: "POST", path: "/api/backups/create", confirmPhrase: null, policyAction: "backups:create", auditAction: "task.backupCreate", requiresDualConfirmation: false });

  const applyGame = resolveWriteActionRoute("updates.apply-game", {});
  assert.deepEqual(applyGame, { method: "POST", path: "/api/updates/apply-game", confirmPhrase: null, policyAction: "updates:apply", auditAction: "task.updateApply", requiresDualConfirmation: false });

  const fixSteamcmd = resolveWriteActionRoute("updates.fix-steamcmd", {});
  assert.deepEqual(fixSteamcmd, { method: "POST", path: "/api/updates/fix-steamcmd", confirmPhrase: null, policyAction: "updates:fix", auditAction: "task.updateFixSteamcmd", requiresDualConfirmation: false });
});

test("server.stop no longer requires dual confirmation -- the flag is absent from its entry and resolves to false, matching every other action", () => {
  // Deliberate operator decision, not a regression: the companion Discord
  // bot's RBAC model makes owner tier exactly one account per guild, so a
  // "second, genuinely different owner-tier admin" cannot exist in practice
  // and the gate was impossible to satisfy rather than merely strict. The
  // generic mechanism itself is untouched -- see writeBridge.integration.test.js,
  // which still exercises it end-to-end via the test-only override below.
  assert.equal(Object.hasOwn(WRITE_ACTION_ROUTES["server.stop"], "requiresDualConfirmation"), false, "the field should be absent entirely, matching every other non-dual-confirmation action's convention");
  assert.equal(resolveWriteActionRoute("server.stop", {}).requiresDualConfirmation, false);
});

test("no production action requires dual confirmation -- the mechanism exists but nothing currently opts in (regression guard: turning it back on anywhere is a deliberate change that must update this test)", () => {
  const optedIn = Object.keys(WRITE_ACTION_ROUTES).filter((action) => resolveWriteActionRoute(action, { playerId: "Server#4242", baseId: "1", guildId: "1" }).requiresDualConfirmation);
  assert.deepEqual(optedIn, []);
});

test("setRequiresDualConfirmationForTests: overrides ONLY the requiresDualConfirmation field of an already-real action, and resets cleanly", () => {
  const before = resolveWriteActionRoute("server.restart", {});
  assert.equal(before.requiresDualConfirmation, false);

  setRequiresDualConfirmationForTests("server.restart", true);
  try {
    const overridden = resolveWriteActionRoute("server.restart", {});
    assert.equal(overridden.requiresDualConfirmation, true);
    // Every other field must be untouched -- this is a real action with real
    // path/policy/audit behavior, not a fabricated one.
    assert.deepEqual({ ...overridden, requiresDualConfirmation: false }, before);
    // Other actions are unaffected by one action's override.
    assert.equal(resolveWriteActionRoute("server.start", {}).requiresDualConfirmation, false);
  } finally {
    resetRequiresDualConfirmationOverridesForTests();
  }

  assert.deepEqual(resolveWriteActionRoute("server.restart", {}), before);
});

test("setRequiresDualConfirmationForTests: refuses an action that isn't a real WRITE_ACTION_ROUTES entry -- the override can never fabricate an action", () => {
  assert.throws(() => setRequiresDualConfirmationForTests("server.does-not-exist", true), /unknown write action/);
  assert.throws(() => setRequiresDualConfirmationForTests("__proto__", true), /unknown write action/);
  assert.equal(resolveWriteActionRoute("server.does-not-exist", {}), null);
});
