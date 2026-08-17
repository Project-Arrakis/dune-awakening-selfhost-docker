import assert from "node:assert/strict";
import test from "node:test";
import { actionForRoute } from "../src/actions.js";
import { evaluate, matchAction, resolveAllowedActions, setPolicies } from "../src/policy.js";

test("policy matching supports exact and namespace wildcards", () => {
  assert.equal(matchAction("players:read", "players:read"), true);
  assert.equal(matchAction("players:*", "players:kick"), true);
  assert.equal(matchAction("players:*", "server:read"), false);
});

test("explicit deny overrides allow, including for owner", () => {
  const policies = {
    owner: {
      version: 1,
      tier: "owner",
      statements: [
        { Effect: "Allow", Action: "*" },
        { Effect: "Deny", Action: "database:mutate" }
      ]
    }
  };
  assert.equal(evaluate({ tier: "owner" }, "server:read", policies), true);
  assert.equal(evaluate({ tier: "owner" }, "database:mutate", policies), false);
});

// bases:delete is a separate action from bases:mutate specifically so a
// custom policy can grant routine base mutations (refills, permission
// edits, cancelling a queued refill/delete -- all reversible) without also
// granting the one irreversible action. This proves that separation holds
// through the real evaluate()/matchAction() path, not just at resolution.
test("bases:delete can be withheld independently of bases:mutate", () => {
  const policies = {
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [
        { Effect: "Allow", Action: ["bases:read", "bases:mutate"] },
        { Effect: "Deny", Action: "bases:delete" }
      ]
    }
  };
  assert.equal(evaluate({ tier: "moderator" }, "bases:mutate", policies), true);
  assert.equal(evaluate({ tier: "moderator" }, "bases:delete", policies), false);

  // The reverse also holds: a namespace wildcard (the shipped admin/owner
  // default) still covers the new action without any policy change, so
  // existing installs keep exactly the access they already had.
  const wildcardPolicies = { admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: "bases:*" }] } };
  assert.equal(evaluate({ tier: "admin" }, "bases:delete", wildcardPolicies), true);
});

// bases:delete-item is separate from bases:mutate for a different reason than
// bases:delete: consent, not blast radius. Base inventory shipped read-only, so
// an operator whose policy already grants bases:mutate agreed to refills and
// permission edits and could not have agreed to item destruction -- folding it
// in would silently widen every existing narrow policy.
test("bases:delete-item can be withheld independently of bases:mutate", () => {
  const policies = {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [{ Effect: "Allow", Action: ["bases:read", "bases:mutate"] }]
    },
    admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: "bases:*" }] }
  };
  assert.equal(setPolicies(policies).ok, true);
  // Granting bases:mutate alone must not carry item deletion with it.
  assert.equal(evaluate({ tier: "moderator" }, "bases:mutate", policies), true);
  assert.equal(evaluate({ tier: "moderator" }, "bases:delete-item", policies), false);
  // The shipped wildcard policies are unaffected.
  assert.equal(evaluate({ tier: "admin" }, "bases:delete-item", policies), true);
});

test("the container item delete route resolves to bases:delete-item without shadowing its neighbours", () => {
  assert.equal(actionForRoute("/api/bases/5/containers/9/items/77", "DELETE"), "bases:delete-item");
  // The base delete and the cancellation routes must keep their own actions --
  // the new pattern sits alongside them, it does not swallow them.
  assert.equal(actionForRoute("/api/bases/5", "DELETE"), "bases:delete");
  assert.equal(actionForRoute("/api/bases/5/queued-delete", "DELETE"), "bases:mutate");
  assert.equal(actionForRoute("/api/bases/5/queued-refill", "DELETE"), "bases:mutate");
  // Reading a container's slots stays an ordinary base read.
  assert.equal(actionForRoute("/api/bases/5/containers/9", "GET"), "bases:read");
});

// resolveAllowedActions has no caller yet (planned for a future policy-editor
// UI), but it must already surface every action actionForRoute can resolve,
// not just the ones with an exact ROUTE_ACTIONS entry -- bases:delete only
// exists via the REGEX_ACTIONS_BY_METHOD_PATTERN tier (see actions.js), so
// this is the case an implementation reading ROUTE_ACTIONS alone would miss.
test("resolveAllowedActions surfaces an action that only exists via the regex-pattern resolution tier", () => {
  const policies = {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [
        { Effect: "Allow", Action: ["bases:read", "bases:mutate"] },
        { Effect: "Deny", Action: "bases:delete" }
      ]
    },
    admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: "bases:*" }] }
  };
  assert.equal(setPolicies(policies).ok, true);

  const moderatorActions = resolveAllowedActions("moderator");
  assert.ok(moderatorActions.includes("bases:mutate"));
  assert.ok(!moderatorActions.includes("bases:delete"), "bases:delete is explicitly denied for moderator");

  // Confirms the wildcard-covered case reaches an action with no exact
  // ROUTE_ACTIONS entry at all -- not just an explicit grant/deny of it.
  const adminActions = resolveAllowedActions("admin");
  assert.ok(adminActions.includes("bases:delete"));
});

test("policy updates validate documents and preserve owner recovery access", () => {
  assert.equal(setPolicies({ owner: { tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] } }).ok, true);
  assert.equal(setPolicies({ owner: { tier: "owner", statements: [{ Effect: "Maybe", Action: "*" }] } }).ok, false);
  assert.equal(setPolicies({ owner: { tier: "owner", statements: [{ Effect: "Deny", Action: "settings:write" }] } }).ok, false);
});

// secrets:read (Stage 2 Secrets Status Panel, issue #318/#320) is
// deliberately admin+-only, matching the sensitivity precedent already
// set for backups:*. This proves the boundary is actually enforced by
// the policy engine, not just documented as excluded in a design doc --
// per the Requirement 20 Layer 1 audit's own QA-3 finding, a design
// stating a tier boundary is not the same as a test confirming it holds.
// Uses an explicit policies object passed directly to evaluate() (not
// setPolicies(), which mutates shared module state across tests) so this
// test is self-contained and independent of execution order relative to
// the other tests in this file, matching this exact admin-tier
// statement list from policy.js's own DEFAULT_POLICIES.admin.
test("secrets:read is granted to admin but denied to moderator, player, and observer by default", () => {
  const policies = {
    admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: ["secrets:read", "backups:*"] }] },
    moderator: { version: 1, tier: "moderator", statements: [{ Effect: "Allow", Action: ["server:read", "logs:*"] }] },
    player: { version: 1, tier: "player", statements: [{ Effect: "Allow", Action: ["server:read"] }] },
    observer: { version: 1, tier: "observer", statements: [{ Effect: "Allow", Action: ["server:read"] }] }
  };
  assert.equal(evaluate({ tier: "admin" }, "secrets:read", policies), true);
  assert.equal(evaluate({ tier: "moderator" }, "secrets:read", policies), false);
  assert.equal(evaluate({ tier: "player" }, "secrets:read", policies), false);
  assert.equal(evaluate({ tier: "observer" }, "secrets:read", policies), false);
});
