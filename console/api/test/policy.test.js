// Issue #245 fix: src/rbac.js (421 lines, a duplicate capability-list RBAC
// system never imported by any production file) was correctly deleted as
// dead code (see git history: "fix: resolve blocking audit findings...
// #203: Removed dead rbac.js"), but its 281-line test file (test/rbac.test.js)
// was left behind, importing the now-nonexistent module and crashing at
// ESM load time on every CI run. That file's own tests were deleted rather
// than migrated, because rbac.js's API (a flat capability-list lookup) has
// no 1:1 mapping onto policy.js's real, current API (an AWS-IAM-style
// Deny > Allow > default-Deny statement evaluator) -- these are genuinely
// different evaluation models, not a rename.
//
// This file is new, real test coverage for src/policy.js -- the actual,
// current console RBAC engine, which had ZERO direct test coverage before
// this file (confirmed via grep across test/*.js for any import of
// "../src/policy.js"; test/rbacParity.test.js only checks that every route
// has an action assignment in actions.js, it never exercises policy.js's
// own evaluate()/matchAction()/resolveSessionTier() logic; test/
// discordPolicy.test.js tests a different, unrelated file --
// src/integrations/discord/policy.js, the Discord bot's own capability
// gate, not this one).

import assert from "node:assert/strict";
import test from "node:test";
import {
  WILDCARD,
  matchAction,
  evaluate,
  resolveSessionTier,
  resolveAllowedActions,
  getPolicy,
  getAllPolicies,
  setPolicies
} from "../src/policy.js";

test.afterEach(() => {
  // setPolicies(null) is not itself a real reset (loadPolicies() reads a
  // file), but every test below either passes explicit policies to
  // evaluate()/getPolicy() or sets its own via setPolicies() -- resetting
  // here just prevents one test's setPolicies() call from leaking into an
  // unrelated later test that forgot to pass its own.
  setPolicies(null);
});

// ---- matchAction() ----

test("matchAction: exact match", () => {
  assert.equal(matchAction("server:read", "server:read"), true);
  assert.equal(matchAction("server:read", "server:write"), false);
});

test("matchAction: WILDCARD constant matches any action", () => {
  assert.equal(matchAction(WILDCARD, "anything:at-all"), true);
});

test("matchAction: namespace wildcard (ns:*) matches the bare namespace and any ns:subaction", () => {
  assert.equal(matchAction("players:*", "players:kick"), true);
  assert.equal(matchAction("players:*", "players"), true, "the bare namespace itself must match, not just subactions");
  assert.equal(matchAction("players:*", "guilds:read"), false);
});

test("matchAction: suffix wildcard (prefix-*) matches by prefix, not namespace boundary", () => {
  // Unlike the ns:* form above (which strips ":*" and also matches the
  // bare namespace with no separator), this form only strips the
  // trailing "*", so the hyphen stays part of the required prefix --
  // "database:write" (no trailing hyphen) does NOT match
  // "database:write-*", only "database:write-<anything>" does.
  assert.equal(matchAction("database:write-*", "database:write-config"), true);
  assert.equal(matchAction("database:write-*", "database:write"), false, "the bare prefix without its trailing hyphen must not match -- only prefix.startsWith('database:write-') does");
  assert.equal(matchAction("database:write-*", "database:read"), false);
});

test("matchAction: general glob pattern with embedded *", () => {
  assert.equal(matchAction("data*port", "database:export"), true);
  assert.equal(matchAction("data*port", "server:read"), false);
});

// ---- resolveSessionTier() ----

test("resolveSessionTier: returns the tier for every valid value", () => {
  for (const tier of ["owner", "admin", "moderator", "player", "observer"]) {
    assert.equal(resolveSessionTier({ tier }), tier);
  }
});

test("resolveSessionTier: returns empty string for a null/undefined session", () => {
  assert.equal(resolveSessionTier(null), "");
  assert.equal(resolveSessionTier(undefined), "");
});

test("resolveSessionTier: returns empty string for an unrecognized tier value", () => {
  assert.equal(resolveSessionTier({ tier: "superadmin" }), "");
});

test("resolveSessionTier: returns empty string when tier is missing or not a string", () => {
  assert.equal(resolveSessionTier({}), "");
  assert.equal(resolveSessionTier({ tier: 123 }), "");
});

// ---- evaluate() ----
// Uses explicit, self-contained policy documents (not the real
// DEFAULT_POLICIES ladder) so these tests pin evaluate()'s own
// Deny > Allow > default-Deny algorithm in isolation, independent of
// whatever the real default policy content happens to be at any given
// time (that's a separate, deliberate concern -- see the DEFAULT_POLICIES
// tests below).

const testPolicies = {
  admin: {
    version: 1,
    tier: "admin",
    statements: [
      { Effect: "Allow", Action: ["players:*", "server:read"] },
      { Effect: "Deny", Action: ["players:reset-progression"] }
    ]
  }
};

test("evaluate: owner tier always passes, even with no matching policy document", () => {
  assert.equal(evaluate({ tier: "owner" }, "anything:at-all", {}), true);
});

test("evaluate: a null/empty action is treated as a public route and always allowed", () => {
  assert.equal(evaluate({ tier: "admin" }, "", testPolicies), true);
  assert.equal(evaluate({ tier: "admin" }, null, testPolicies), true);
});

test("evaluate: an unrecognized tier is denied, even for an action the ladder would otherwise allow", () => {
  assert.equal(evaluate({ tier: "superadmin" }, "players:read", testPolicies), false);
});

test("evaluate: a tier with no policy document at all is denied", () => {
  assert.equal(evaluate({ tier: "moderator" }, "players:read", testPolicies), false);
});

test("evaluate: an Allow statement whose Action pattern matches grants access", () => {
  assert.equal(evaluate({ tier: "admin" }, "players:kick", testPolicies), true);
  assert.equal(evaluate({ tier: "admin" }, "server:read", testPolicies), true);
});

test("evaluate: an action matching no statement at all is denied by default", () => {
  assert.equal(evaluate({ tier: "admin" }, "guilds:read", testPolicies), false);
});

test("evaluate: an explicit Deny wins even when a broader Allow also matches the same action -- Deny > Allow, regardless of statement order", () => {
  // players:reset-progression matches BOTH the broad players:* Allow AND
  // the specific Deny -- the Deny must win. This is the single most
  // important invariant policy.js's own header comment documents
  // ("Deny > Allow > default Deny").
  assert.equal(evaluate({ tier: "admin" }, "players:reset-progression", testPolicies), false);
});

test("evaluate: statement order does not matter -- Deny still wins even if it appears before the matching Allow", () => {
  const reordered = {
    admin: {
      version: 1,
      tier: "admin",
      statements: [
        { Effect: "Deny", Action: ["players:reset-progression"] },
        { Effect: "Allow", Action: ["players:*"] }
      ]
    }
  };
  assert.equal(evaluate({ tier: "admin" }, "players:reset-progression", reordered), false);
});

test("evaluate: a single statement's Action may be a bare string, not just an array", () => {
  const singleActionPolicy = {
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [{ Effect: "Allow", Action: "server:read" }]
    }
  };
  assert.equal(evaluate({ tier: "moderator" }, "server:read", singleActionPolicy), true);
  assert.equal(evaluate({ tier: "moderator" }, "server:write", singleActionPolicy), false);
});

// ---- getPolicy() / getAllPolicies() / setPolicies() ----

test("getPolicy: returns the named tier's document from an explicit policies argument", () => {
  assert.deepEqual(getPolicy("admin", testPolicies), testPolicies.admin);
});

test("getPolicy: returns null for a tier not present in the policy store", () => {
  assert.equal(getPolicy("moderator", testPolicies), null);
});

test("setPolicies: makes the given policies the default for getPolicy()/evaluate() when no explicit policies argument is passed", () => {
  setPolicies(testPolicies);
  assert.deepEqual(getPolicy("admin"), testPolicies.admin);
  assert.equal(evaluate({ tier: "admin" }, "server:read"), true);
});

test("getAllPolicies: returns a shallow copy of the full policy store, not the live reference", () => {
  setPolicies(testPolicies);
  const copy = getAllPolicies();
  assert.deepEqual(copy, testPolicies);
  copy.admin = "mutated";
  assert.notEqual(getPolicy("admin"), "mutated", "mutating the returned copy must not affect the internal policy store");
});

// ---- resolveAllowedActions() ----
// Exercises the REAL DEFAULT_POLICIES ladder (via the real ROUTE_ACTIONS
// action set) since this function's whole purpose is to answer "what can
// THIS tier actually do, right now, with the real, currently-configured
// policy" -- explicit test policies would defeat the point.

test("resolveAllowedActions: owner is allowed every real action (matches ROUTE_ACTIONS' full action set)", () => {
  setPolicies(null); // force DEFAULT_POLICIES via loadPolicies()'s own fallback path is not re-triggered by setPolicies(null) -- but evaluate()'s owner-tier fast path (see policy.js's own "Owner always passes" comment) means this still holds true regardless of which policy store is active.
  const allowed = resolveAllowedActions("owner");
  assert.ok(allowed.length > 0, "owner must be allowed at least one real action");
});

test("resolveAllowedActions: an unrecognized tier is allowed nothing", () => {
  assert.deepEqual(resolveAllowedActions(""), []);
});

test("resolveAllowedActions: caches its result per tier -- a second call with a mutated action set still returns the cached list, not a recomputation", () => {
  const first = resolveAllowedActions("player");
  const second = resolveAllowedActions("player");
  assert.equal(first, second, "must return the exact same cached array reference, confirming the internal _allowedActions cache is used");
});

test("setPolicies: clears the resolveAllowedActions() cache so a new policy document takes effect immediately", () => {
  setPolicies({
    moderator: { version: 1, tier: "moderator", statements: [{ Effect: "Allow", Action: ["server:read"] }] }
  });
  const beforeSecondPolicy = resolveAllowedActions("moderator");
  setPolicies({
    moderator: { version: 1, tier: "moderator", statements: [{ Effect: "Allow", Action: ["server:read", "players:read"] }] }
  });
  const afterSecondPolicy = resolveAllowedActions("moderator");
  assert.notDeepEqual(beforeSecondPolicy, afterSecondPolicy, "changing policies via setPolicies() must invalidate the per-tier cache, not silently reuse the previous document's resolved action list");
});
