import { test } from "node:test";
import assert from "node:assert/strict";
import { WRITE_ACTION_MIN_TIER, meetsMinTier } from "../src/integrations/discord/writeActionMinTier.js";

test("meetsMinTier: exhaustive matrix across every real action and every tier", () => {
  const tiers = ["moderator", "admin", "owner"];
  const rank = { moderator: 0, admin: 1, owner: 2 };
  for (const [action, minTier] of Object.entries(WRITE_ACTION_MIN_TIER)) {
    for (const actorTier of tiers) {
      const expected = rank[actorTier] >= rank[minTier];
      assert.equal(
        meetsMinTier(actorTier, action),
        expected,
        `${actorTier} vs ${action} (min ${minTier}) expected ${expected}`
      );
    }
  }
});

test("meetsMinTier: owner-tier actions reject admin and moderator", () => {
  const ownerOnly = Object.entries(WRITE_ACTION_MIN_TIER)
    .filter(([, tier]) => tier === "owner")
    .map(([action]) => action);
  assert.ok(ownerOnly.includes("player.give-item"));
  assert.ok(ownerOnly.includes("server.restart"));
  assert.ok(ownerOnly.includes("carepackage.grant-all"));
  assert.ok(ownerOnly.includes("carepackage.history-clear"));
  for (const action of ownerOnly) {
    assert.equal(meetsMinTier("admin", action), false);
    assert.equal(meetsMinTier("moderator", action), false);
    assert.equal(meetsMinTier("owner", action), true);
  }
});

test("meetsMinTier: unknown action fails closed with a throw, never a silent false", () => {
  assert.throws(() => meetsMinTier("owner", "player.does-not-exist"), /No minimum tier defined/);
});

test("meetsMinTier: poisoned keys never resolve to a truthy inherited value", () => {
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.throws(() => meetsMinTier("owner", key), /No minimum tier defined/);
  }
});

test("meetsMinTier: broadcast.* is intentionally absent from this table", () => {
  assert.throws(() => meetsMinTier("owner", "broadcast.send"), /No minimum tier defined/);
});

test("WRITE_ACTION_MIN_TIER: table is frozen against poisoned-prototype lookups via Object.hasOwn, not a bare index", () => {
  // Regression guard for the class of bug this table's own design doc explicitly
  // calls out (docs/rw-architecture.md 3.3a, round-3 correction #747): a bare
  // WRITE_ACTION_MIN_TIER[action] lookup on a poisoned key resolves to a
  // non-tier inherited value rather than undefined, which meetsMinTier's own
  // TIER_RANK comparison would silently evaluate as false instead of throwing.
  assert.equal(Object.hasOwn(WRITE_ACTION_MIN_TIER, "constructor"), false);
  assert.equal(Object.hasOwn(WRITE_ACTION_MIN_TIER, "toString"), false);
});
