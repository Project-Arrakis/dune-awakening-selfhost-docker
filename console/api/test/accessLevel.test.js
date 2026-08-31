import assert from "node:assert/strict";
import test from "node:test";
import { accessLevelForAction, allAccessLevels, crownJewelActions } from "../src/policy.js";
import { allKnownActions } from "../src/policy.js";

// #634 (AWS-IAM-Visual-Editor-style Access Control UI). Real classification
// lives entirely server-side, sent to the client as an already-computed field
// (see server.js's catalog endpoint) -- the client never re-derives it. This
// avoids the cross-package duplication the Eight Hats QA hat flagged as a
// fixture-drift/tautology risk if the same logic lived twice (once per
// package) with only a completeness, not correctness, test to catch drift.

test("accessLevelForAction: a crown-jewel action is 'permissions' even though its own literal isn't the crown-jewel pattern", () => {
  // players:mutate is a concrete literal already IN CROWN_JEWEL_DENY_ACTIONS.
  assert.equal(accessLevelForAction("players:mutate"), "permissions");
});

test("accessLevelForAction: a concrete action reached only via the wildcard crown-jewel pattern settings:* is 'permissions'", () => {
  // settings:read is not itself a CROWN_JEWEL_DENY_ACTIONS literal -- it's
  // covered by the "settings:*" wildcard entry. This is the exact matching
  // shape the Security hat's CRITICAL finding (see #575) was about: must use
  // matchAction(), not literal array membership.
  assert.equal(accessLevelForAction("settings:read"), "permissions");
  assert.equal(accessLevelForAction("settings:write"), "permissions");
});

test("accessLevelForAction: a POST-only action with no crown-jewel/settings/setup namespace is 'write'", () => {
  assert.equal(accessLevelForAction("players:kick"), "write");
});

test("accessLevelForAction: a GET-only action is 'read'", () => {
  assert.equal(accessLevelForAction("server:read"), "read");
});

// /code-review ultra finding: this test's own claim was false. storage:read
// is ALSO registered in ROUTE_ACTIONS ("GET /api/storage"), so it resolves
// via the ordinary GET-is-not-mutating path, never touching the
// method-agnostic fallback below -- confirmed by grepping every
// REGEX_ACTIONS entry against the other three tables: as of this writing,
// EVERY one has a shadow entry supplying a real method, so the fallback is
// genuinely unreachable by any current real action. Kept as a real
// classification-correctness check (it's still a valid assertion), but no
// longer claims to exercise the fallback branch.
test("accessLevelForAction: storage:read resolves via its registered GET method (not the method-agnostic fallback -- see the synthetic test below for that)", () => {
  assert.equal(accessLevelForAction("storage:read"), "read");
});

// The method-agnostic fallback itself, tested honestly with a synthetic
// action name no real table registers -- proves the naming-convention logic
// is correct for the day a genuinely method-agnostic action IS added,
// without relying on a real action that (today) never actually reaches it.
test("accessLevelForAction: a genuinely method-agnostic action (no method in any table) falls back to the naming convention", () => {
  assert.equal(accessLevelForAction("synthetic-test-only:write"), "write");
  assert.equal(accessLevelForAction("synthetic-test-only:read"), "read");
});

test("accessLevelForAction: setup:read is 'permissions' via the namespace override, not the method heuristic", () => {
  assert.equal(accessLevelForAction("setup:read"), "permissions");
});

// Correctness table, not just completeness -- the QA hat's finding: a
// TypeScript return-type union already guarantees every action resolves to
// SOME level, so a test only checking "every action has a level" can never
// fail on a wrong classification. This table is a curated, independently
// human-reviewed oracle for the actions where getting it wrong would matter
// most (every crown jewel, plus the three confirmed real mixed-method edge
// cases from the design doc's §4.2) -- not a full enumeration of the ~93
// action catalog, which would just be reimplementing accessLevelForAction
// by hand and proving nothing beyond "I copied the output."
test("accessLevelForAction: curated correctness table for the highest-stakes and known-ambiguous actions", () => {
  const expected = {
    // Every crown-jewel action must be "permissions" -- this is the actual
    // safety property #634's whole UI redesign depends on.
    "settings:write": "permissions",
    "settings:read": "permissions",
    "server:write-credentials": "permissions",
    "database:write-config": "permissions",
    "database:mutate": "permissions",
    "database:export": "permissions",
    "admin:transfer-settings:write": "permissions",
    "updates:apply": "permissions",
    "updates:fix": "permissions",
    "updates:repair": "permissions",
    "backups:restore": "permissions",
    "backups:import": "permissions",
    "addons:install": "permissions",
    "addons:update": "permissions",
    "setup:write": "permissions",
    "players:mutate": "permissions",
    "carepackage:grant": "permissions",
    "carepackage:write-config": "permissions",
    "exchange:market": "permissions",
    "exchange:market-write": "permissions",
    // Confirmed real mixed-method edge cases (design doc §4.2): all three
    // currently resolve correctly, two via an unrelated override.
    "admin:map-chat": "write",
    // Representative reads and writes across a few namespaces.
    "players:read": "read",
    "players:kick": "write",
    "players:ban": "write",
    "players:teleport": "write",
    "server:read": "read",
    "server:restart": "write",
    "bases:read": "read",
    "bases:mutate": "write",
    "bases:delete": "write",
    "storage:read": "read",
    "blueprints:read": "read",
    "addons:read": "read",
    "logs:read": "read",
    "setup:read": "permissions",
    // /code-review ultra finding on PR #647: the HTTP method (POST, since a
    // SQL-like query needs a request body) does not match the real,
    // server-enforced semantics -- see DEFAULT_POLICIES' own
    // "query is read-only-enforced in the handler" comment. Previously
    // absent from this table entirely, so the misclassification (the
    // mutating-method heuristic alone would call it "write") went uncaught.
    "database:query": "read",
  };
  for (const [action, level] of Object.entries(expected)) {
    assert.equal(accessLevelForAction(action), level, `${action} should be "${level}"`);
  }
});

test("accessLevelForAction: every real action in the catalog resolves to one of the three levels (completeness, not correctness -- see the curated table above for correctness)", () => {
  for (const action of allKnownActions()) {
    assert.ok(["read", "write", "permissions"].includes(accessLevelForAction(action)), `${action} did not resolve to a known level`);
  }
});

// /code-review ultra finding on PR #647: crownJewelActions() used to hand
// out the live memoized array by direct reference on every call after the
// first, unlike allKnownActions() (and every one of its own callers), which
// is always freshly spread. A caller mutating what it reasonably assumes is
// a fresh array would permanently corrupt this shared, security-critical
// cache for the rest of the process.
test("crownJewelActions: returns a fresh array each call -- mutating one call's result does not corrupt the shared cache", () => {
  const first = crownJewelActions();
  const originalLength = first.length;
  first.push("not-a-real-action");
  first.sort(() => 0); // also exercise in-place mutation, not just push
  const second = crownJewelActions();
  assert.equal(second.length, originalLength, "a later call must not see the earlier call's mutation");
  assert.ok(!second.includes("not-a-real-action"));
});

// /code-review ultra finding on PR #647: this was previously rebuilt in full
// (crown-jewel pattern-matching + method-set lookups for ~90+ actions) on
// every single request to /api/settings/iam/policies, despite being over a
// static, process-lifetime-constant action catalog -- an inconsistent
// caching discipline right next to the already-memoized crownJewelActions()
// one line away in that same handler. Mirrors the defensive-copy test above:
// verifies both that repeated calls agree, and that the returned object is a
// fresh copy each time, not a shared mutable reference.
test("allAccessLevels: memoized (repeated calls agree) and returns a fresh object each call", () => {
  const first = allAccessLevels();
  assert.equal(first["database:query"], "read");
  assert.equal(first["settings:write"], "permissions");
  first["settings:write"] = "read"; // mutate the returned object directly
  const second = allAccessLevels();
  assert.equal(second["settings:write"], "permissions", "a later call must not see the earlier call's mutation");
  assert.deepEqual(Object.keys(second).sort(), [...allKnownActions()].sort(), "covers every known action, same as the old inline computation");
});
