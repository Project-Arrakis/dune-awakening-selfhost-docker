import assert from "node:assert/strict";
import test from "node:test";
import { accessLevelForAction } from "../src/policy.js";
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

test("accessLevelForAction: a method-agnostic action (REGEX_ACTIONS, no method recorded at all) falls back to the naming convention", () => {
  // storage:read comes from REGEX_ACTIONS ("/api/storage/" -> "storage:read"),
  // which records no HTTP method at all -- confirmed real edge case from the
  // design doc's §4.2. Its name ends in ":read", so the naming-convention
  // fallback must classify it "read", not silently default somewhere else.
  assert.equal(accessLevelForAction("storage:read"), "read");
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
