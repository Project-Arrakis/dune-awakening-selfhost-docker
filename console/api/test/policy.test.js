import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { actionForRoute } from "../src/actions.js";
import {
  evaluate, matchAction, resolveAllowedActions, setPolicies,
  aggregateStatements, migrateIfLegacyShape, validPolicyStore,
  createPolicy, editPolicy, rollbackPolicy, deletePolicyVersion, deletePolicy,
  createTier, setTierInline, attachPolicy, detachPolicy,
  getAllPolicies, MAX_POLICY_VERSIONS, MAX_NAMED_POLICIES, MAX_CUSTOM_TIERS,
  _resetPolicyStoreForTests
} from "../src/policy.js";

// The AWS-mirrored policy/role tests below (migration through cache
// invalidation) all mutate policy.js's module-level in-memory store via
// createPolicy/createTier/attachPolicy/etc. Reset to a clean, known-good
// state before each test so they don't depend on execution order or leak
// state into each other -- matches this codebase's existing
// `_resetXForTests()` + `beforeEach` convention (see db.test.js).
beforeEach(() => {
  _resetPolicyStoreForTests();
});

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

// ---- AWS-mirrored policy/role model: migration (L1 design §4.4, §7) ----
//
// beforeEach() above resets policy.js's module-level store to clean
// wrapped defaults before every test in this file, so the tests below
// don't depend on execution order.

test("migration: all 5 real built-in tiers produce byte-identical evaluate() results before/after migration, including a Deny action and a string (non-array) wildcard", () => {
  const legacy = {
    owner: { tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    admin: { tier: "admin", statements: [
      { Effect: "Allow", Action: ["setup:*", "server:*", "database:read"] },
      { Effect: "Deny", Action: ["settings:*", "database:mutate"] }
    ]},
    moderator: { tier: "moderator", statements: [{ Effect: "Allow", Action: ["players:read", "logs:*"] }] },
    player: { tier: "player", statements: [{ Effect: "Allow", Action: "server:read" }] },
    observer: { tier: "observer", statements: [{ Effect: "Allow", Action: "server:read" }] },
  };
  const migrated = migrateIfLegacyShape(legacy);
  assert.equal(validPolicyStore(migrated), true);

  const actionsToCheck = ["server:read", "database:mutate", "settings:write", "players:read", "logs:anything", "setup:write"];
  for (const tier of Object.keys(legacy)) {
    for (const action of actionsToCheck) {
      const before = evaluate({ tier }, action, legacy);
      const after = evaluate({ tier }, action, migrated);
      assert.equal(after, before, `tier=${tier} action=${action}: expected ${before}, got ${after}`);
    }
  }
});

test("migration: an already-schema-v2 document is a no-op (idempotent)", () => {
  const v2 = { schemaVersion: 2, tiers: { owner: { inline: { statements: [{ Effect: "Allow", Action: "*" }] }, attached: [] } }, policies: {} };
  assert.equal(migrateIfLegacyShape(v2), v2);
});

test("migration: genuinely alien input (non-object, array, or no owner-producible tiers) returns null", () => {
  assert.equal(migrateIfLegacyShape(null), null);
  assert.equal(migrateIfLegacyShape("not an object"), null);
  assert.equal(migrateIfLegacyShape([1, 2, 3]), null);
  // An object with zero valid tiers and no built-in fallback available
  // (a custom-only, entirely malformed legacy file) has no owner tier to
  // fall back to -- must return null, not a store missing "owner".
  assert.equal(migrateIfLegacyShape({ "totally-custom": { tier: "totally-custom" /* no statements */ } }), null);
});

test("migration: 5 valid built-in tiers + 1 malformed tier salvages the 5 valid ones instead of discarding everything (L1 audit finding L1-H5)", () => {
  const legacy = {
    owner: { tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    admin: { tier: "admin", statements: [{ Effect: "Allow", Action: "server:*" }] },
    moderator: { tier: "moderator", statements: [{ Effect: "Allow", Action: "players:read" }] },
    player: { tier: "player", statements: [{ Effect: "Allow", Action: "server:read" }] },
    observer: { tier: "observer", statements: [{ Effect: "Allow", Action: "server:read" }] },
    "custom-broken": { tier: "custom-broken" /* missing statements -- malformed */ },
  };
  const migrated = migrateIfLegacyShape(legacy);
  assert.ok(migrated, "migration must not return null when 5 of 6 tiers are individually valid");
  assert.equal(migrated.schemaVersion, 2);
  // All 5 valid, customized tiers survive with their real statements intact.
  assert.deepEqual(migrated.tiers.admin.inline.statements, [{ Effect: "Allow", Action: "server:*" }]);
  assert.deepEqual(migrated.tiers.moderator.inline.statements, [{ Effect: "Allow", Action: "players:read" }]);
  // The malformed, unrecognized custom tier is dropped, not guessed at.
  assert.equal(migrated.tiers["custom-broken"], undefined);
});

test("migration: a malformed BUILT-IN tier (not custom) falls back to that tier's own DEFAULT_POLICIES entry, not the whole file's defaults", () => {
  const legacy = {
    owner: { tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    admin: { tier: "admin" /* malformed -- missing statements */ },
    moderator: { tier: "moderator", statements: [{ Effect: "Allow", Action: "players:read" }] },
    player: { tier: "player", statements: [{ Effect: "Allow", Action: "server:read" }] },
    observer: { tier: "observer", statements: [{ Effect: "Allow", Action: "server:read" }] },
  };
  const migrated = migrateIfLegacyShape(legacy);
  assert.ok(migrated);
  // admin falls back to its own built-in default (grants server:* per
  // DEFAULT_POLICIES, denies settings:*) rather than being dropped like an
  // unrecognized custom tier would be.
  assert.equal(evaluate({ tier: "admin" }, "server:restart", migrated), true);
  assert.equal(evaluate({ tier: "admin" }, "settings:write", migrated), false);
  // moderator's real customization is untouched.
  assert.deepEqual(migrated.tiers.moderator.inline.statements, [{ Effect: "Allow", Action: "players:read" }]);
});

// ---- Fail-closed aggregation on a dangling reference (L1 audit finding L1-C2) ----

test("aggregateStatements treats a dangling attached policyId as an implicit Deny *, not a silent skip", () => {
  const tierRecord = { inline: { statements: [{ Effect: "Allow", Action: "*" }] }, attached: ["does-not-exist"] };
  const statements = aggregateStatements(tierRecord, {});
  // The inline Allow * is still present, but the dangling reference must
  // ALSO contribute a Deny * -- proving the aggregate as a whole denies
  // everything the dangling reference's real (never-resolved) statements
  // might have covered, per the fail-closed requirement in policy.js's
  // own aggregateStatements() comment.
  assert.ok(statements.some((s) => s.Effect === "Deny" && s.Action === "*"));
});

test("evaluate() denies every action when a tier's only attached policy is a dangling reference, even though its inline policy alone would allow everything", () => {
  const store = {
    schemaVersion: 2,
    tiers: { owner: { inline: { statements: [{ Effect: "Allow", Action: "*" }] }, attached: ["ghost-policy-id"] } },
    policies: {} // "ghost-policy-id" does not exist here -- a dangling reference
  };
  // If aggregation silently skipped the dangling reference, this would be
  // true (inline Allow * unopposed). Fail-closed aggregation means the
  // implicit Deny * the dangling reference contributes wins instead.
  assert.equal(evaluate({ tier: "owner" }, "server:read", store), false);
  assert.equal(evaluate({ tier: "owner" }, "settings:write", store), false);
});

test("validPolicyStore rejects a store with a dangling attached->policies reference at validation time (referential integrity, L1 audit finding L1-C3)", () => {
  const store = {
    schemaVersion: 2,
    tiers: { owner: { inline: { statements: [{ Effect: "Allow", Action: "*" }] }, attached: ["missing-policy-id"] } },
    policies: {}
  };
  assert.equal(validPolicyStore(store), false);
});

test("validPolicyStore rejects a policy whose defaultVersionId does not resolve to a real version (L1 audit finding L1-C3)", () => {
  const store = {
    schemaVersion: 2,
    tiers: { owner: { inline: { statements: [{ Effect: "Allow", Action: "*" }] }, attached: [] } },
    policies: {
      "pol-1": {
        name: "test", managed: false, defaultVersionId: "v9-does-not-exist",
        versions: { v1: { statements: [{ Effect: "Allow", Action: "server:read" }], createdAt: "2026-01-01T00:00:00Z", createdBy: "owner" } }
      }
    }
  };
  assert.equal(validPolicyStore(store), false);
});

// ---- Aggregation (general, L1 design §4.1) ----

test("aggregation: a tier with inline=null and one attached policy evaluates using only the attached policy's statements", () => {
  const create = createPolicy({ name: "read-only-metrics", statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner");
  assert.equal(create.ok, true);
  assert.equal(createTier("event-mod").ok, true);
  assert.equal(attachPolicy("event-mod", create.policyId).ok, true);

  assert.equal(evaluate({ tier: "event-mod" }, "server:read"), true);
  assert.equal(evaluate({ tier: "event-mod" }, "settings:write"), false);
});

test("aggregation: a Deny in an attached policy overrides an Allow in the tier's own inline policy, and vice versa -- attachment order does not matter", () => {
  const denyPolicy = createPolicy({ name: "deny-database-mutate", statements: [{ Effect: "Deny", Action: "database:mutate" }] }, "owner");
  assert.equal(denyPolicy.ok, true);
  assert.equal(createTier("restricted-admin").ok, true);
  assert.equal(setTierInline("restricted-admin", [{ Effect: "Allow", Action: "*" }]).ok, true);
  assert.equal(attachPolicy("restricted-admin", denyPolicy.policyId).ok, true);

  // Inline grants everything; attached policy denies one specific action --
  // the Deny wins regardless of the fact the inline Allow was evaluated
  // first in the aggregate (inline statements are concatenated before
  // attached ones, per §4.1 -- this proves the ORDER doesn't matter to
  // the outcome, only that a Deny exists somewhere in the aggregate).
  assert.equal(evaluate({ tier: "restricted-admin" }, "server:read"), true);
  assert.equal(evaluate({ tier: "restricted-admin" }, "database:mutate"), false);

  // Reverse: an Allow in an attached policy plus a Deny in the tier's own
  // inline policy -- the inline Deny still wins.
  assert.equal(createTier("narrow-reader").ok, true);
  const allowPolicy = createPolicy({ name: "allow-server-read", statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner");
  assert.equal(allowPolicy.ok, true);
  assert.equal(attachPolicy("narrow-reader", allowPolicy.policyId).ok, true);
  assert.equal(setTierInline("narrow-reader", [{ Effect: "Deny", Action: "server:read" }]).ok, true);
  assert.equal(evaluate({ tier: "narrow-reader" }, "server:read"), false);
});

// ---- Named policy version lifecycle (L1 design §4.2, §7) ----

test("version lifecycle: create -> edit (new version becomes default) -> rollback -> delete-while-default rejected -> rollback forward -> delete succeeds", () => {
  const created = createPolicy({ name: "lifecycle-test", statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner");
  assert.equal(created.ok, true);
  const { policyId } = created;
  assert.equal(created.defaultVersionId, "v1");

  const edited = editPolicy(policyId, { statements: [{ Effect: "Allow", Action: "server:*" }] }, "owner");
  assert.equal(edited.ok, true);
  assert.equal(edited.defaultVersionId, "v2");

  const rolledBack = rollbackPolicy(policyId, "v1");
  assert.equal(rolledBack.ok, true);
  assert.equal(getAllPolicies().policies[policyId].defaultVersionId, "v1");
  // Rollback does not create a new version.
  assert.equal(Object.keys(getAllPolicies().policies[policyId].versions).length, 2);

  // v1 is now the default -- cannot delete it directly.
  const deleteDefaultAttempt = deletePolicyVersion(policyId, "v1");
  assert.equal(deleteDefaultAttempt.ok, false);

  const rolledForward = rollbackPolicy(policyId, "v2");
  assert.equal(rolledForward.ok, true);

  // v1 is no longer default -- deletable now.
  const deleteNonDefault = deletePolicyVersion(policyId, "v1");
  assert.equal(deleteNonDefault.ok, true);
  assert.equal(Object.keys(getAllPolicies().policies[policyId].versions).length, 1);
});

test("version cap: creating a 6th version is rejected AND the error names a specific, currently-non-default version to delete (L1 audit finding L1-H4)", () => {
  const created = createPolicy({ name: "cap-test", statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner");
  assert.equal(created.ok, true);
  const { policyId } = created;

  // Create versions v2..v5 (v1 already exists from createPolicy).
  for (let i = 2; i <= MAX_POLICY_VERSIONS; i++) {
    const r = editPolicy(policyId, { statements: [{ Effect: "Allow", Action: `server:read-v${i}` }] }, "owner");
    assert.equal(r.ok, true, `expected version ${i} to be created successfully`);
  }
  assert.equal(Object.keys(getAllPolicies().policies[policyId].versions).length, MAX_POLICY_VERSIONS);

  const sixth = editPolicy(policyId, { statements: [{ Effect: "Allow", Action: "server:read-v6" }] }, "owner");
  assert.equal(sixth.ok, false);
  assert.match(sixth.error, /v1/); // v1 is the oldest AND currently non-default (v5 is default) -- named explicitly
  assert.equal(Object.keys(getAllPolicies().policies[policyId].versions).length, MAX_POLICY_VERSIONS, "the existing 5 versions must remain untouched by the rejected 6th");
});

test("version cap: after a rollback, 'oldest non-default version' correctly excludes the rolled-back-to version even though it's chronologically oldest", () => {
  const created = createPolicy({ name: "cap-rollback-test", statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner");
  const { policyId } = created;
  for (let i = 2; i <= MAX_POLICY_VERSIONS; i++) {
    editPolicy(policyId, { statements: [{ Effect: "Allow", Action: `server:read-v${i}` }] }, "owner");
  }
  // Roll back to v1 (chronologically oldest, but now the DEFAULT).
  assert.equal(rollbackPolicy(policyId, "v1").ok, true);

  const sixth = editPolicy(policyId, { statements: [{ Effect: "Allow", Action: "server:read-v6" }] }, "owner");
  assert.equal(sixth.ok, false);
  // v1 is chronologically oldest but is now the default -- must NOT be named.
  assert.ok(!/\bv1\b/.test(sixth.error), `error must not name v1 (it is the current default): ${sixth.error}`);
  // v2 is the oldest version that is NOT the default.
  assert.match(sixth.error, /v2/);
});

test("delete-while-attached: rejected, with every attaching tier named in the error (not just one)", () => {
  const created = createPolicy({ name: "shared-policy", statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner");
  const { policyId } = created;
  assert.equal(createTier("tier-a").ok, true);
  assert.equal(createTier("tier-b").ok, true);
  assert.equal(attachPolicy("tier-a", policyId).ok, true);
  assert.equal(attachPolicy("tier-b", policyId).ok, true);

  const deleteAttempt = deletePolicy(policyId);
  assert.equal(deleteAttempt.ok, false);
  assert.match(deleteAttempt.error, /tier-a/);
  assert.match(deleteAttempt.error, /tier-b/);

  assert.equal(detachPolicy("tier-a", policyId).ok, true);
  const stillAttached = deletePolicy(policyId);
  assert.equal(stillAttached.ok, false);
  assert.match(stillAttached.error, /tier-b/);

  assert.equal(detachPolicy("tier-b", policyId).ok, true);
  assert.equal(deletePolicy(policyId).ok, true);
});

// ---- Owner-lockout guard: full state-transition surface (L1 audit finding L1-C1) ----
//
// This is the direct regression test for the redesigned single-choke-point
// guard (design §4.3). All 5 operation types that can change owner's
// effective aggregate are covered here -- the original design's guard,
// which only checked writes touching tiers.owner directly, would pass (i)
// and (ii) below but MISS (iii) and (iv) entirely, since neither of those
// two touches tiers.owner at all. Every one of these goes through
// applyMutation() (policy.js), the single choke point -- not a per-route
// reimplementation.

test("owner-lockout (i): direct inline edit removing settings:write from owner with no attached policy covering it is rejected", () => {
  const result = setTierInline("owner", [{ Effect: "Allow", Action: "server:read" }]);
  assert.equal(result.ok, false);
});

test("owner-lockout (ii): detaching owner's only settings:write-granting attached policy is rejected", () => {
  // Owner's inline policy is emptied of settings:write; owner relies
  // entirely on one attached policy for it.
  const grantPolicy = createPolicy({ name: "owner-write-grant", statements: [{ Effect: "Allow", Action: "settings:write" }] }, "owner");
  assert.equal(grantPolicy.ok, true);
  assert.equal(attachPolicy("owner", grantPolicy.policyId).ok, true);
  assert.equal(setTierInline("owner", [{ Effect: "Allow", Action: "server:read" }]).ok, true);
  // Sanity: owner currently has settings:write via the attached policy.
  assert.equal(evaluate({ tier: "owner" }, "settings:write"), true);

  const detachAttempt = detachPolicy("owner", grantPolicy.policyId);
  assert.equal(detachAttempt.ok, false);
  // Owner must still have settings:write after the rejected detach.
  assert.equal(evaluate({ tier: "owner" }, "settings:write"), true);
});

test("owner-lockout (iii): EDITING an attached policy to drop settings:write is rejected when it's owner's only source of that action -- the exact bypass the L1 audit found in the original per-route guard design", () => {
  const grantPolicy = createPolicy({ name: "owner-write-grant-2", statements: [{ Effect: "Allow", Action: "settings:write" }] }, "owner");
  assert.equal(attachPolicy("owner", grantPolicy.policyId).ok, true);
  assert.equal(setTierInline("owner", [{ Effect: "Allow", Action: "server:read" }]).ok, true);
  assert.equal(evaluate({ tier: "owner" }, "settings:write"), true);

  // This mutation touches ONLY the policy object -- tiers.owner itself is
  // never written. A guard that only fires on writes to tiers.owner would
  // never see this at all.
  const editAttempt = editPolicy(grantPolicy.policyId, { statements: [{ Effect: "Allow", Action: "server:restart" }] }, "owner");
  assert.equal(editAttempt.ok, false);
  assert.equal(evaluate({ tier: "owner" }, "settings:write"), true, "owner must still have settings:write after the rejected edit");
});

test("owner-lockout (iv): ROLLING BACK an attached policy to an older version lacking settings:write is rejected under the same condition", () => {
  const grantPolicy = createPolicy({ name: "owner-write-grant-3", statements: [{ Effect: "Allow", Action: "settings:write" }] }, "owner");
  const { policyId } = grantPolicy;
  // v2 does NOT grant settings:write.
  assert.equal(editPolicy(policyId, { statements: [{ Effect: "Allow", Action: "server:restart" }] }, "owner").ok, true);
  // Roll back to v1 to restore settings:write via this policy, then attach it.
  assert.equal(rollbackPolicy(policyId, "v1").ok, true);
  assert.equal(attachPolicy("owner", policyId).ok, true);
  assert.equal(setTierInline("owner", [{ Effect: "Allow", Action: "server:read" }]).ok, true);
  assert.equal(evaluate({ tier: "owner" }, "settings:write"), true);

  // Rolling back to v2 (no settings:write) while it's owner's only source
  // of that action -- must be rejected. This mutation touches ONLY the
  // policy's defaultVersionId, never tiers.owner.
  const rollbackAttempt = rollbackPolicy(policyId, "v2");
  assert.equal(rollbackAttempt.ok, false);
  assert.equal(evaluate({ tier: "owner" }, "settings:write"), true, "owner must still have settings:write after the rejected rollback");
});

test("owner-lockout (v): attaching a policy that does NOT grant settings:write succeeds when owner's inline policy already grants it -- the guard must not over-reject safe operations", () => {
  const readOnlyPolicy = createPolicy({ name: "unrelated-read-only", statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner");
  assert.equal(readOnlyPolicy.ok, true);
  // Owner's inline policy already grants settings:write (the default owner
  // policy grants Allow "*", which covers it).
  const attachResult = attachPolicy("owner", readOnlyPolicy.policyId);
  assert.equal(attachResult.ok, true);
  assert.equal(evaluate({ tier: "owner" }, "settings:write"), true);
  assert.equal(evaluate({ tier: "owner" }, "server:read"), true);
});

// ---- Resource bounds (L1 design §8 item 2, resolved) ----

test("createTier enforces RESERVED_TIER_NAME_PATTERN and rejects malformed names", () => {
  assert.equal(createTier("Uppercase-Not-Allowed").ok, false);
  assert.equal(createTier("has spaces").ok, false);
  assert.equal(createTier("a").ok, false); // too short (min 2 chars)
  assert.equal(createTier("x".repeat(33)).ok, false); // too long (max 32 chars)
  assert.equal(createTier("valid-tier_name-1").ok, true);
});

test("createTier rejects a duplicate tier name", () => {
  assert.equal(createTier("dup-test").ok, true);
  assert.equal(createTier("dup-test").ok, false);
});

test("MAX_CUSTOM_TIERS is enforced -- built-in tiers do not count against the cap", () => {
  for (let i = 0; i < MAX_CUSTOM_TIERS; i++) {
    assert.equal(createTier(`custom-tier-${i}`).ok, true, `custom tier ${i} should succeed`);
  }
  const overCap = createTier("one-too-many");
  assert.equal(overCap.ok, false);
  assert.match(overCap.error, new RegExp(String(MAX_CUSTOM_TIERS)));
});

test("MAX_NAMED_POLICIES is enforced", () => {
  for (let i = 0; i < MAX_NAMED_POLICIES; i++) {
    assert.equal(createPolicy({ name: `policy-${i}`, statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner").ok, true, `policy ${i} should succeed`);
  }
  const overCap = createPolicy({ name: "one-too-many", statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner");
  assert.equal(overCap.ok, false);
  assert.match(overCap.error, new RegExp(String(MAX_NAMED_POLICIES)));
});

// ---- Cache invalidation on the new mutation surface (L1 audit finding L1-M1) ----

test("resolveAllowedActions cache is invalidated by attach/detach, not just the legacy setPolicies() route", () => {
  assert.equal(createTier("cache-test-tier").ok, true);
  assert.equal(setTierInline("cache-test-tier", [{ Effect: "Allow", Action: "server:read" }]).ok, true);

  const before = resolveAllowedActions("cache-test-tier");
  assert.ok(!before.includes("database:query"));

  const policy = createPolicy({ name: "cache-test-policy", statements: [{ Effect: "Allow", Action: "database:query" }] }, "owner");
  assert.equal(attachPolicy("cache-test-tier", policy.policyId).ok, true);

  const after = resolveAllowedActions("cache-test-tier");
  assert.ok(after.includes("database:query"), "cache must reflect the newly attached policy's grant, not a stale pre-attach snapshot");
});
