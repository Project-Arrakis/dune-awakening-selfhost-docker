import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getWriteBridgeToken,
  resetWriteBridgeTokenForTests,
  resolveWriteBridgePrincipal,
  WRITE_BRIDGE_TOKEN_HEADER,
  WRITE_BRIDGE_ACTION_HEADER,
  WRITE_BRIDGE_TIER_HEADER,
  WRITE_BRIDGE_ACTOR_USER_ID_HEADER,
  WRITE_BRIDGE_ACTOR_USERNAME_HEADER
} from "../src/integrations/discord/writeBridgeCredential.js";
import { resolveWriteActionRoute } from "../src/integrations/discord/writeActionRoutes.js";

test.beforeEach(() => resetWriteBridgeTokenForTests());

function validHeaders(overrides = {}) {
  return {
    [WRITE_BRIDGE_TOKEN_HEADER]: getWriteBridgeToken(),
    [WRITE_BRIDGE_ACTION_HEADER]: "player.kick",
    [WRITE_BRIDGE_TIER_HEADER]: "admin",
    [WRITE_BRIDGE_ACTOR_USER_ID_HEADER]: "discord-user-1",
    [WRITE_BRIDGE_ACTOR_USERNAME_HEADER]: "tester",
    ...overrides
  };
}

function kickTarget() {
  return resolveWriteActionRoute("player.kick", { playerId: "Server#4242" });
}

test("getWriteBridgeToken: lazily generated, stable across calls within a process lifetime", () => {
  const a = getWriteBridgeToken();
  const b = getWriteBridgeToken();
  assert.equal(a, b);
  assert.equal(typeof a, "string");
  assert.equal(a.length, 64); // 32 bytes, hex-encoded
});

test("resetWriteBridgeTokenForTests: simulates a process restart -- a new token is generated, invalidating the old one", () => {
  const before = getWriteBridgeToken();
  resetWriteBridgeTokenForTests();
  const after = getWriteBridgeToken();
  assert.notEqual(before, after);
});

test("resolveWriteBridgePrincipal: checks viaWriteBridgeSocket FIRST -- returns null even with a fully valid token/headers if not from the socket", () => {
  const target = kickTarget();
  const result = resolveWriteBridgePrincipal({
    headers: validHeaders(),
    method: target.method,
    path: target.path,
    viaWriteBridgeSocket: false
  });
  assert.equal(result, null);
});

test("resolveWriteBridgePrincipal: valid request via the socket returns a correctly-shaped principal", () => {
  const target = kickTarget();
  const result = resolveWriteBridgePrincipal({
    headers: validHeaders(),
    method: target.method,
    path: target.path,
    viaWriteBridgeSocket: true
  });
  assert.equal(result.source, "discord-write-bridge");
  assert.equal(result.tier, "admin");
  assert.equal(result.userId, "discord-user-1");
  assert.equal(result.discordUserId, "discord-user-1");
  assert.equal(result.discordUsername, "tester");
  assert.equal(result.id, "discord:discord-user-1");
  assert.equal(result.csrf, null);
});

test("resolveWriteBridgePrincipal: wrong token is rejected", () => {
  const target = kickTarget();
  const result = resolveWriteBridgePrincipal({
    headers: validHeaders({ [WRITE_BRIDGE_TOKEN_HEADER]: "0".repeat(64) }),
    method: target.method,
    path: target.path,
    viaWriteBridgeSocket: true
  });
  assert.equal(result, null);
});

test("resolveWriteBridgePrincipal: missing token is rejected, never throws", () => {
  const target = kickTarget();
  const headers = validHeaders();
  delete headers[WRITE_BRIDGE_TOKEN_HEADER];
  assert.doesNotThrow(() => resolveWriteBridgePrincipal({ headers, method: target.method, path: target.path, viaWriteBridgeSocket: true }));
  assert.equal(resolveWriteBridgePrincipal({ headers, method: target.method, path: target.path, viaWriteBridgeSocket: true }), null);
});

test("resolveWriteBridgePrincipal: mismatched-length token never throws (length-guard before constant-time compare)", () => {
  const target = kickTarget();
  const result = resolveWriteBridgePrincipal({
    headers: validHeaders({ [WRITE_BRIDGE_TOKEN_HEADER]: "ab" }),
    method: target.method,
    path: target.path,
    viaWriteBridgeSocket: true
  });
  assert.equal(result, null);
});

test("resolveWriteBridgePrincipal: exact-match path scoping -- a valid token cannot be reused for a DIFFERENT action's target (CRITICAL #728)", () => {
  const banTarget = resolveWriteActionRoute("player.ban", { playerId: "Server#4242" });
  // Headers claim player.kick, but the actual (method,path) is player.ban's.
  const result = resolveWriteBridgePrincipal({
    headers: validHeaders({ [WRITE_BRIDGE_ACTION_HEADER]: "player.kick" }),
    method: banTarget.method,
    path: banTarget.path,
    viaWriteBridgeSocket: true
  });
  assert.equal(result, null);
});

test("resolveWriteBridgePrincipal: a valid credential must never grant access to an unrelated real Core route (database:query class)", () => {
  const result = resolveWriteBridgePrincipal({
    headers: validHeaders(),
    method: "POST",
    path: "/api/database/query",
    viaWriteBridgeSocket: true
  });
  assert.equal(result, null);
});

test("resolveWriteBridgePrincipal: malformed tier is rejected, fails closed rather than defaulting", () => {
  const target = kickTarget();
  for (const badTier of ["owner-ish", "OWNER", "", "public", "observer", "constructor"]) {
    const result = resolveWriteBridgePrincipal({
      headers: validHeaders({ [WRITE_BRIDGE_TIER_HEADER]: badTier }),
      method: target.method,
      path: target.path,
      viaWriteBridgeSocket: true
    });
    assert.equal(result, null, `tier "${badTier}" should have been rejected`);
  }
});

test("resolveWriteBridgePrincipal: missing actor user id is rejected", () => {
  const target = kickTarget();
  const headers = validHeaders({ [WRITE_BRIDGE_ACTOR_USER_ID_HEADER]: "" });
  const result = resolveWriteBridgePrincipal({ headers, method: target.method, path: target.path, viaWriteBridgeSocket: true });
  assert.equal(result, null);
});

test("resolveWriteBridgePrincipal: each of the three valid tiers is accepted and reflected verbatim", () => {
  const target = kickTarget();
  for (const tier of ["moderator", "admin", "owner"]) {
    const result = resolveWriteBridgePrincipal({
      headers: validHeaders({ [WRITE_BRIDGE_TIER_HEADER]: tier }),
      method: target.method,
      path: target.path,
      viaWriteBridgeSocket: true
    });
    assert.equal(result.tier, tier);
  }
});
