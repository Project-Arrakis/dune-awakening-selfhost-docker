import test from "node:test";
import assert from "node:assert/strict";
import { parseRoleIdList, resolveRoleTier, higherTier, mfaGateReason, roleTiersConfigured, parseTierList, TIER_ORDER } from "../src/integrations/discord/roleTiers.js";

const R = { owner: ["100000000000000001"], admin: ["100000000000000002"], moderator: ["100000000000000003"], player: ["100000000000000004"] };

test("parseRoleIdList keeps only snowflakes, dedupes, never throws", () => {
  assert.deepEqual(parseRoleIdList(" 100000000000000001, nope, 100000000000000001 ,42"), ["100000000000000001"]);
  assert.deepEqual(parseRoleIdList(""), []);
  assert.deepEqual(parseRoleIdList(undefined), []);
});

test("resolveRoleTier returns the HIGHEST mapped tier the member holds", () => {
  assert.equal(resolveRoleTier(["100000000000000004", "100000000000000003"], R), "moderator");
  assert.equal(resolveRoleTier(["100000000000000004", "100000000000000001"], R), "owner");
  assert.equal(resolveRoleTier(["100000000000000004"], R), "player");
});

test("resolveRoleTier denies when no held role is mapped, or no roles at all", () => {
  assert.equal(resolveRoleTier(["999999999999999999"], R), "");
  assert.equal(resolveRoleTier([], R), "");
  assert.equal(resolveRoleTier(["100000000000000001"], null), "");
});

test("precedence is explicit, not object-key order", () => {
  const shuffled = { player: R.player, moderator: R.moderator, admin: R.admin, owner: R.owner };
  assert.equal(resolveRoleTier(["100000000000000004", "100000000000000002"], shuffled), "admin");
  assert.deepEqual(TIER_ORDER, ["owner", "admin", "moderator", "player", "observer"]);
});

test("higherTier picks the stronger tier; empty loses to anything", () => {
  assert.equal(higherTier("owner", "player"), "owner");
  assert.equal(higherTier("player", "admin"), "admin");
  assert.equal(higherTier("", "observer"), "observer");
  assert.equal(higherTier("", ""), "");
});

test("mfaGateReason denies a gated tier without Discord 2FA, passes otherwise", () => {
  assert.equal(mfaGateReason("owner", false, ["owner", "admin"]), "mfa_required");
  assert.equal(mfaGateReason("admin", false, ["owner", "admin"]), "mfa_required");
  assert.equal(mfaGateReason("owner", true, ["owner", "admin"]), "");
  assert.equal(mfaGateReason("player", false, ["owner", "admin"]), "");
  assert.equal(mfaGateReason("owner", false, []), "", "empty list disables the gate");
  assert.equal(mfaGateReason("", false, ["owner"]), "", "no tier means nothing to gate");
});

test("roleTiersConfigured and parseTierList", () => {
  assert.equal(roleTiersConfigured(R), true);
  assert.equal(roleTiersConfigured({ owner: [], admin: [] }), false);
  assert.equal(roleTiersConfigured(null), false);
  assert.deepEqual(parseTierList("owner, Admin,bogus,admin"), ["owner", "admin"]);
});
