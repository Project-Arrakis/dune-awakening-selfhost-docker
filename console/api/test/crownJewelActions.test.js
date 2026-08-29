import assert from "node:assert/strict";
import test from "node:test";
import { crownJewelActions } from "../src/policy.js";

// #634: the Visual Editor's "select all" must exclude crown-jewel actions for
// non-owner tiers, independent of a tier's CURRENT draft Deny statements
// (which an operator could have edited away) and independent of the
// read/write/permissions UI grouping (accessLevelForAction's "permissions"
// bucket also includes non-crown-jewel actions like setup:read, which admin's
// default policy legitimately grants -- conflating the two would wrongly
// exclude a grantable action). This is the concrete, already-expanded action
// list -- the client checks plain array membership, doing zero pattern
// matching itself, mirroring the same expand-then-match fix setPolicies()
// uses (the CRITICAL bug fixed at de0ed64b was matching a PATTERN as if it
// were a concrete action).
test("crownJewelActions: expands the settings:* wildcard into its real concrete actions", () => {
  const actions = crownJewelActions();
  assert.ok(actions.includes("settings:read"));
  assert.ok(actions.includes("settings:write"));
});

test("crownJewelActions: includes every literal entry from CROWN_JEWEL_DENY_ACTIONS unchanged", () => {
  const actions = crownJewelActions();
  assert.ok(actions.includes("players:mutate"));
  assert.ok(actions.includes("database:mutate"));
});

test("crownJewelActions: does not include a non-crown-jewel action that merely shares the 'permissions' UI grouping", () => {
  // setup:read is grouped "permissions" by accessLevelForAction (UI bucket,
  // §4.2), but it is NOT a crown-jewel action -- admin's default policy
  // legitimately grants it. The two concepts must not be conflated.
  const actions = crownJewelActions();
  assert.ok(!actions.includes("setup:read"));
});
