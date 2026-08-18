import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { actionForRoute } from "../src/actions.js";
import {
  evaluate, matchAction, resolveAllowedActions, setPolicies,
  aggregateStatements, migrateIfLegacyShape, validPolicyStore,
  createPolicy, editPolicy, rollbackPolicy, deletePolicyVersion, deletePolicy,
  createTier, setTierInline, attachPolicy, detachPolicy,
  getAllPolicies, loadPolicies, MAX_POLICY_VERSIONS, MAX_NAMED_POLICIES, MAX_CUSTOM_TIERS,
  _resetPolicyStoreForTests
} from "../src/policy.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const PRODUCTION_REPRESENTATIVE_FIXTURE_PATH = join(FIXTURES_DIR, "production-representative-legacy-iam.json");

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

// ---- matchAction() glob fallback: ReDoS elimination (Layer 3 re-audit,
// Architect hat -- CRITICAL, independently confirmed by
// `semgrep --config auto`'s detect-non-literal-regexp finding) ----
//
// The previous implementation built `new RegExp("^" + pattern.replace(/\*/g,
// ".*") + "$")` from a caller-supplied pattern string, escaping only `*`
// -- every other regex metacharacter (`.`, `+`, `(`, etc.) was passed
// through unescaped, and multiple `*` segments could cause catastrophic
// backtracking. Replaced with a deterministic, backtracking-free
// two-pointer glob matcher (globMatchNoBacktrack). These tests confirm
// (a) correctness parity with the old regex-based behavior for the
// legitimate multi-wildcard case this fallback exists for, (b) that
// literal regex metacharacters in a pattern are treated as LITERAL
// characters, not regex syntax (the old implementation's actual,
// silent bug), and (c) that a deliberately pathological multi-wildcard
// pattern against a long non-matching action string returns well
// within a tight time bound, not hanging the process.
test("matchAction() glob fallback: multi-wildcard patterns still match correctly (parity with the old regex-based behavior)", () => {
  assert.equal(matchAction("foo*bar*baz", "foo-XXX-bar-YYY-baz"), true);
  assert.equal(matchAction("foo*bar*baz", "foo-bar-nope"), false);
  assert.equal(matchAction("a*b*c*d", "aXXbXXcXXd"), true);
  assert.equal(matchAction("a*b*c*d", "aXXbXXcXX"), false, "missing the final literal segment must not match");
  assert.equal(matchAction("*:read", "players:read"), true);
  assert.equal(matchAction("*:read", "players:write"), false);
});

test("matchAction() glob fallback: regex metacharacters in a pattern are treated as LITERAL characters, not regex syntax (fixes a real, silent bug in the previous regex-based implementation)", () => {
  // "server.restart" as a literal pattern (a "." in an action namespace
  // is not itself meaningful in this codebase's convention, but a
  // pattern containing one must never be silently interpreted as
  // "server<any single char>restart" by accident).
  assert.equal(matchAction("server.restart*", "server.restart"), true);
  assert.equal(matchAction("server.restart*", "serverXrestart"), false, "a literal '.' in the pattern must NOT match an arbitrary character, unlike raw regex '.' semantics");
  // "(" / ")" / "+" are regex-special but must be treated as literal
  // text when they appear in a pattern.
  assert.equal(matchAction("foo(bar)+*", "foo(bar)+baz"), true);
  assert.equal(matchAction("foo(bar)+*", "foobarbaz"), false, "unescaped regex metacharacters must not be interpreted as regex syntax");
});

test("matchAction() glob fallback: a deliberately pathological multi-wildcard pattern against a long non-matching string does not hang -- confirms the ReDoS fix is real, not just a claim", () => {
  // This exact shape (many sequential wildcard segments) is the
  // canonical catastrophic-backtracking trigger for a naive
  // regex-based glob implementation matched against a string with no
  // valid match -- under the OLD implementation, this specific
  // combination is expected to take an exponential, multi-second (or
  // longer) amount of time on a non-matching input of this length. The
  // new matcher must resolve it in well under a second regardless.
  const pathologicalPattern = "a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*!";
  const nonMatchingInput = "a".repeat(40) + "b"; // ends in 'b', never matches the trailing literal '!'
  const start = Date.now();
  const result = matchAction(pathologicalPattern, nonMatchingInput);
  const elapsedMs = Date.now() - start;
  assert.equal(result, false);
  assert.ok(elapsedMs < 500, `matchAction() took ${elapsedMs}ms against a pathological pattern -- expected well under 500ms with the backtracking-free matcher`);
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

// ---- Concurrency safety (L1 audit finding L1-H1) ----
//
// policy.js's mutation choke point (applyMutation()) is fully synchronous
// end-to-end -- this is a load-bearing invariant, not an incidental
// implementation detail (see the CONCURRENCY INVARIANT comment directly
// above applyMutation() in policy.js). If a future change ever makes any
// part of the mutation path async without adding a real lock, this test
// is the regression guard: it races two mutations against a shared
// dependency (the same policy's version history, where one rollback
// would strip owner's settings:write) and asserts the outcome is always
// exactly one winner with no lost update -- not a probabilistic "usually
// fine," a hard structural guarantee this stress run exercises 100 times.
test("concurrent-shaped mutations on the same policy never produce a lost update or a silent owner-lockout, even under 100 racing iterations (L1 audit finding L1-H1)", async () => {
  let anyInconsistent = false;
  for (let i = 0; i < 100; i++) {
    _resetPolicyStoreForTests();
    // Build both versions BEFORE attaching to owner -- editPolicy() while
    // already attached-and-sole-source would itself be correctly rejected
    // by the owner-lockout guard (proven by the owner-lockout (iii) test
    // above), so v2 must exist first, then the policy gets attached.
    const grant = createPolicy({ name: `race-grant-${i}`, statements: [{ Effect: "Allow", Action: "settings:write" }] }, "owner"); // v1: HAS settings:write
    assert.equal(editPolicy(grant.policyId, { statements: [{ Effect: "Allow", Action: "server:restart" }] }, "owner").ok, true); // v2: does NOT
    assert.equal(rollbackPolicy(grant.policyId, "v1").ok, true); // v1 is default again before attaching
    assert.equal(attachPolicy("owner", grant.policyId).ok, true);
    assert.equal(setTierInline("owner", [{ Effect: "Allow", Action: "server:read" }]).ok, true);
    assert.equal(evaluate({ tier: "owner" }, "settings:write"), true, "sanity: owner has settings:write via the attached policy's default version (v1) before the race starts");

    // Two "concurrent" requests: both await a random microtask delay
    // (simulating two real HTTP requests whose bodies finish parsing at
    // slightly different times), then both call a synchronous mutation
    // function racing on the exact same policy -- one rollback keeps
    // settings:write (v1), the other would strip it (v2).
    await Promise.all([
      (async () => { await new Promise((r) => setTimeout(r, Math.random())); rollbackPolicy(grant.policyId, "v1"); })(),
      (async () => { await new Promise((r) => setTimeout(r, Math.random())); rollbackPolicy(grant.policyId, "v2"); })(),
    ]);

    if (!evaluate({ tier: "owner" }, "settings:write")) {
      anyInconsistent = true;
      break;
    }
  }
  assert.equal(anyInconsistent, false, "owner must retain settings:write after any interleaving of the two racing rollbacks -- a failure here means the synchronous-mutation-path invariant was broken");
});

// Layer 2 audit finding GRC-C1 (GRC hat, independently confirmed by the
// QA hat): the test above races two mutations that are each
// INDEPENDENTLY, unconditionally rejected/accepted by applyMutation()'s
// own outcome-based guard regardless of execution order -- it is a
// tautology that would still pass 100/100 even if a real `await` were
// introduced into applyMutation() (verified: the audit reproduced this
// exact regression in an isolated worktree and confirmed the test above
// did NOT catch it). This test is the fix: it directly asserts the
// structural invariant the whole safety argument actually depends on --
// that no function reachable from applyMutation() is an async function
// and that none of the mutation exports return a Promise -- rather than
// inferring it indirectly from an outcome that happens to be timing-
// independent by construction. If a future change ever adds `await`
// anywhere in this path, THIS test fails immediately, deterministically,
// with no dependence on timing, iteration count, or scenario construction.
test("concurrency invariant: every mutation export and applyMutation() itself are synchronous, not async functions (L1-H1, real regression test per Layer 2 audit finding GRC-C1)", () => {
  const mutationExports = { setPolicies, createPolicy, editPolicy, rollbackPolicy, deletePolicyVersion, deletePolicy, createTier, setTierInline, attachPolicy, detachPolicy };
  for (const [name, fn] of Object.entries(mutationExports)) {
    assert.equal(fn.constructor.name, "Function", `${name} must be a synchronous function, not async -- an AsyncFunction here would silently reintroduce the L1-H1 concurrency race this invariant exists to prevent`);
  }

  // Independently confirm none of them return a thenable/Promise for a
  // representative no-op-ish call (belt-and-suspenders against a
  // function that is syntactically non-async but manually returns a
  // Promise, which would defeat the invariant just as effectively).
  _resetPolicyStoreForTests();
  const probe = createTier("concurrency-probe-tier");
  assert.equal(typeof probe.then, "undefined", "createTier's return value must not be thenable");
  const probe2 = setTierInline("concurrency-probe-tier", [{ Effect: "Allow", Action: "server:read" }]);
  assert.equal(typeof probe2.then, "undefined", "setTierInline's return value must not be thenable");
});

// ---- Object.prototype pollution guard (Layer 2 audit finding NEW-1,
// Security hat -- CRITICAL) ----
//
// Every mutation function that takes a caller-supplied tierName/policyId
// must reject "__proto__"/"constructor"/"prototype" (case-insensitively)
// before ever using that value as a bracket-access key -- otherwise
// `store.tiers[tierName].inline = {...}` on `tierName === "__proto__"`
// mutates the REAL, LIVE, process-global Object.prototype, silently and
// invisibly (JSON.stringify never enumerates inherited properties), for
// any session holding settings:write (owner by default). This was
// confirmed reachable over a real, shipped HTTP route
// (PUT /api/settings/iam/tiers/__proto__/inline) during the Layer 2
// implementation audit.
test("Object.prototype pollution guard: every mutation function rejects __proto__/constructor/prototype (case-insensitive) without polluting the prototype chain", () => {
  const dangerousKeys = ["__proto__", "constructor", "prototype", "__PROTO__", "Constructor", "PROTOTYPE"];
  const before = { proto: Object.getOwnPropertyNames(Object.prototype).length };

  for (const key of dangerousKeys) {
    _resetPolicyStoreForTests();
    assert.equal(createTier(key).ok, false, `createTier(${JSON.stringify(key)}) must be rejected`);
    assert.equal(setTierInline(key, [{ Effect: "Allow", Action: "server:read" }]).ok, false, `setTierInline(${JSON.stringify(key)}) must be rejected`);
    assert.equal(attachPolicy(key, "11111111-1111-1111-1111-111111111111").ok, false, `attachPolicy(tier=${JSON.stringify(key)}) must be rejected`);
    assert.equal(attachPolicy("owner", key).ok, false, `attachPolicy(policyId=${JSON.stringify(key)}) must be rejected`);
    assert.equal(detachPolicy(key, "11111111-1111-1111-1111-111111111111").ok, false, `detachPolicy(tier=${JSON.stringify(key)}) must be rejected`);
    assert.equal(editPolicy(key, { statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner").ok, false, `editPolicy(${JSON.stringify(key)}) must be rejected`);
    assert.equal(rollbackPolicy(key, "v1").ok, false, `rollbackPolicy(policyId=${JSON.stringify(key)}) must be rejected`);
    assert.equal(deletePolicyVersion(key, "v1").ok, false, `deletePolicyVersion(policyId=${JSON.stringify(key)}) must be rejected`);
    assert.equal(deletePolicy(key).ok, false, `deletePolicy(${JSON.stringify(key)}) must be rejected`);
  }

  // The definitive check: Object.prototype itself must be byte-for-byte
  // unchanged after every one of the above attempts across every
  // dangerous key variant -- not just "the calls returned ok:false."
  const after = { proto: Object.getOwnPropertyNames(Object.prototype).length };
  assert.deepEqual(after, before, "Object.prototype must have zero new own properties after every dangerous-key mutation attempt");
  assert.equal(Object.prototype.inline, undefined, "Object.prototype.inline must never be set");
  assert.equal(Object.prototype.attached, undefined, "Object.prototype.attached must never be set");
  assert.equal(({}).inline, undefined, "a fresh plain object anywhere else in the process must be unaffected");
});

test("setPolicies (legacy route) drops a dangerous tier-name key from the incoming document instead of migrating/persisting it, and never pollutes Object.prototype", () => {
  _resetPolicyStoreForTests();
  // A `{ __proto__: {...} }` OBJECT LITERAL sets the prototype rather
  // than creating an own enumerable key -- JSON.parse() does NOT apply
  // that special-casing (confirmed: JSON.parse('{"__proto__":{}}') DOES
  // produce a real own "__proto__" property), and server.js's real
  // request body always arrives via JSON.parse (readJson(req)), so this
  // test constructs the malicious payload the same way a real HTTP
  // request body would, not via a literal (which would not actually
  // exercise the code path this guard covers).
  //
  // Confirmed by direct execution during implementation: a bare
  // `tiers[tierName] = {...}` (whole-value reassignment through an
  // inherited/dangerous key) does NOT itself pollute Object.prototype --
  // only a subsequent PROPERTY MUTATION on the already-looked-up value
  // (`tiers[tierName].inline = x`, the shape setTierInline used before
  // its own fix) does. So this route's correct, safe behavior is not
  // "reject the whole request" but "silently-but-EXPLICITLY drop the
  // dangerous tier and salvage every other, legitimate tier" -- exactly
  // the same per-tier salvage discipline migrateIfLegacyShape() already
  // applies to any other malformed tier entry (L1-H5), extended to
  // treat a dangerous key as one more kind of malformed entry rather
  // than a special, silently-vanishing case with no log signal at all.
  const maliciousBody = JSON.parse(
    '{"owner":{"tier":"owner","statements":[{"Effect":"Allow","Action":"*"}]},' +
    '"__proto__":{"tier":"__proto__","statements":[{"Effect":"Allow","Action":"pwned"}]}}'
  );
  assert.ok(Object.hasOwn(maliciousBody, "__proto__"), "sanity: the constructed payload must have a real own __proto__ property, matching what JSON.parse produces from a real request body");

  const result = setPolicies(maliciousBody);
  assert.equal(result.ok, true, "the request as a whole succeeds -- only the dangerous tier is dropped, per the same per-tier salvage discipline as any other malformed tier");
  assert.ok(!Object.hasOwn(result.policies.tiers, "__proto__"), "the dangerous key must never appear as an own property of the resulting tiers map");
  assert.equal(Object.prototype.inline, undefined);
  assert.equal(({}).inline, undefined, "a fresh plain object anywhere else in the process must be unaffected");
});

// ---- Deep-copy correctness (Layer 2 audit finding, DBA hat -- HIGH) ----
//
// deepCopyStore()'s original implementation only spread the OUTER
// statements array per tier/version -- each individual statement object,
// and its Action array when Action is an array, was the SAME object
// reference shared across every "copy". A caller that later mutated a
// statement/Action array obtained from getAllPolicies() (used by 3
// server.js route handlers) could silently corrupt live internal
// _policies state with no error, no validation trip, no audit trail.
// These tests assert reference-INEQUALITY, not just value-equality --
// the class of assertion the DBA hat found completely absent from the
// pre-existing 33 tests.
test("getAllPolicies() snapshots do not share statement/Action array references across separate calls", () => {
  _resetPolicyStoreForTests();
  const snap1 = getAllPolicies();
  const snap2 = getAllPolicies();
  assert.notEqual(snap1.tiers.admin.inline.statements[0], snap2.tiers.admin.inline.statements[0], "statement objects must not be the same reference across snapshots");
  assert.notEqual(snap1.tiers.admin.inline.statements[0].Action, snap2.tiers.admin.inline.statements[0].Action, "Action arrays must not be the same reference across snapshots");
});

test("mutating a statement's Action array from one getAllPolicies() snapshot does not corrupt the live internal store or a later snapshot", () => {
  _resetPolicyStoreForTests();
  const snap1 = getAllPolicies();
  const beforeMutationLiveCheck = evaluate({ tier: "admin" }, "database:mutate"); // false by default (admin denies this)

  // In-place mutation of a nested Action array obtained from a snapshot --
  // exactly the DBA hat's demonstrated bug scenario.
  if (Array.isArray(snap1.tiers.admin.inline.statements[0].Action)) {
    snap1.tiers.admin.inline.statements[0].Action.push("database:mutate-INJECTED");
  }

  const snap2 = getAllPolicies();
  assert.ok(!snap2.tiers.admin.inline.statements[0].Action.includes("database:mutate-INJECTED"), "a later snapshot must not see the mutation made to an earlier snapshot's nested array");
  assert.equal(evaluate({ tier: "admin" }, "database:mutate"), beforeMutationLiveCheck, "live evaluation must be completely unaffected by mutating a previously-returned snapshot's nested array");
});

test("createPolicy/editPolicy/setTierInline do not store the caller's own statements array by reference -- mutating the caller's array after the call does not affect the persisted policy", () => {
  _resetPolicyStoreForTests();
  const callerStatements = [{ Effect: "Allow", Action: ["server:read"] }];
  const created = createPolicy({ name: "ingest-copy-test", statements: callerStatements }, "owner");
  assert.equal(created.ok, true);

  // Mutate the caller's own array/objects AFTER the call returns --
  // simulates a future logging/audit hook or retry buffer that retains
  // a reference to the original request body and touches it later.
  callerStatements[0].Action.push("settings:write-INJECTED");
  callerStatements.push({ Effect: "Allow", Action: ["*"] });

  const stored = getAllPolicies().policies[created.policyId].versions.v1.statements;
  assert.equal(stored.length, 1, "the stored statement list must not grow when the caller's original array is mutated afterward");
  assert.ok(!stored[0].Action.includes("settings:write-INJECTED"), "the stored statement's Action array must not reflect a post-call mutation of the caller's original array");

  // Same check for setTierInline.
  const tierStatements = [{ Effect: "Allow", Action: ["server:read"] }];
  assert.equal(createTier("ingest-copy-tier").ok, true);
  assert.equal(setTierInline("ingest-copy-tier", tierStatements).ok, true);
  tierStatements[0].Action.push("settings:write-INJECTED");
  const storedTierStatements = getAllPolicies().tiers["ingest-copy-tier"].inline.statements;
  assert.ok(!storedTierStatements[0].Action.includes("settings:write-INJECTED"), "setTierInline must not store the caller's array by reference either");
});

// ---- Version-ID collision regression (Layer 2 audit finding, QA hat --
// HIGH: the highestSeq+1 fix had a manual, untracked verification script
// but zero committed regression coverage) ----
test("editPolicy assigns a collision-free version ID after a middle version is deleted (highestSeq+1, not versionCount+1)", () => {
  _resetPolicyStoreForTests();
  const created = createPolicy({ name: "collision-test", statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner");
  const { policyId } = created;
  // Create v2, v3, v4, v5 (v1 already exists from createPolicy).
  for (let i = 2; i <= 5; i++) {
    assert.equal(editPolicy(policyId, { statements: [{ Effect: "Allow", Action: `server:action-${i}` }] }, "owner").ok, true);
  }
  assert.deepEqual(Object.keys(getAllPolicies().policies[policyId].versions).sort(), ["v1", "v2", "v3", "v4", "v5"]);

  // Roll back to v3 (making it default, so it's deletable-adjacent) and
  // delete the middle version v3... actually delete a genuinely
  // non-default middle version: roll back to v1 first so v3 is safely
  // non-default, then delete v3.
  assert.equal(rollbackPolicy(policyId, "v1").ok, true);
  assert.equal(deletePolicyVersion(policyId, "v3").ok, true);
  assert.deepEqual(Object.keys(getAllPolicies().policies[policyId].versions).sort(), ["v1", "v2", "v4", "v5"]);

  // versionCount is now 4 (v1,v2,v4,v5) -- a naive versionCount+1 scheme
  // would produce "v5", COLLIDING with the still-existing v5. The
  // highestSeq+1 scheme must produce "v6" instead.
  assert.equal(rollbackPolicy(policyId, "v5").ok, true); // roll forward so the next edit doesn't hit the owner-lockout guard unrelatedly
  const edited = editPolicy(policyId, { statements: [{ Effect: "Allow", Action: "server:action-new" }] }, "owner");
  assert.equal(edited.ok, true);
  assert.equal(edited.defaultVersionId, "v6", "must be v6 (highestSeq+1), not v5 (versionCount+1), to avoid colliding with the still-existing v5");
  assert.deepEqual(Object.keys(getAllPolicies().policies[policyId].versions).sort(), ["v1", "v2", "v4", "v5", "v6"]);
  // Confirm no data was lost/overwritten -- v5's original statements are intact.
  assert.deepEqual(getAllPolicies().policies[policyId].versions.v5.statements, [{ Effect: "Allow", Action: "server:action-5" }]);
});

// ---- persist() 0o600 file-permission regression coverage (Layer 2
// audit finding, Cloud Security hat -- HIGH: this write path was
// correct in the code but had ZERO automated test coverage -- every
// pre-existing test calls every mutation function with repoRoot=null,
// so persist()'s actual writeJsonAtomic(..., 0o600) call was never
// exercised by `node --test` at all) ----
test("persist() writes iam-policies.json with real 0o600 permissions on disk, for every mutation entry point that accepts a repoRoot", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-iam-persist-"));
  try {
    _resetPolicyStoreForTests();
    const filePath = join(repoRoot, "runtime", "generated", "iam-policies.json");

    // setTierInline is a representative, already-exercised mutation --
    // confirms the choke point's persist(repoRoot) call actually reaches
    // disk with the correct content and mode, not just that the
    // in-memory result is correct (every other test in this file never
    // passes a real repoRoot at all).
    const result = setTierInline("owner", [{ Effect: "Allow", Action: "*" }], "owner", repoRoot);
    assert.equal(result.ok, true);

    const mode = statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600, `expected file mode 0600, got ${mode.toString(8)}`);

    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(onDisk.schemaVersion, 2);
    assert.deepEqual(onDisk.tiers.owner.inline.statements, [{ Effect: "Allow", Action: "*" }]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("persist() preserves 0o600 across every mutating export, not just setTierInline", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-iam-persist-all-"));
  try {
    _resetPolicyStoreForTests();
    const filePath = join(repoRoot, "runtime", "generated", "iam-policies.json");

    assert.equal(createTier("perm-check-tier", repoRoot).ok, true);
    assert.equal((statSync(filePath).mode & 0o777), 0o600);

    const created = createPolicy({ name: "perm-check-policy", statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner", repoRoot);
    assert.equal(created.ok, true);
    assert.equal((statSync(filePath).mode & 0o777), 0o600);

    assert.equal(attachPolicy("perm-check-tier", created.policyId, "owner", repoRoot).ok, true);
    assert.equal((statSync(filePath).mode & 0o777), 0o600);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---- Privilege-ceiling / no-amplification invariant (Layer 3 audit
// finding, Security hat -- CRITICAL, verified live over real HTTP during
// the audit before being fixed here) ----
//
// A tier granted ONLY settings:write could previously mint a brand-new
// Allow:"*" policy and attach it to its own tier (or, even more
// directly, overwrite its own inline policy with the same statement),
// reaching full owner-equivalent access in a single authenticated
// session. settings:write was never intended to be transitively
// equivalent to full owner status. These tests reproduce the exact
// attack sequence found during the audit and confirm it is now rejected,
// while confirming legitimate, non-escalating operations (owner granting
// broader access; a tier narrowing its own permissions) still work.

test("privilege ceiling: a tier holding ONLY settings:write cannot attach a new policy that grants itself an action it doesn't already have (the exact escalation sequence found during the Layer 3 audit)", () => {
  _resetPolicyStoreForTests();
  assert.equal(createTier("helper").ok, true);
  const grant = createPolicy({ name: "helper-grant", statements: [{ Effect: "Allow", Action: "settings:write" }] }, "owner");
  assert.equal(attachPolicy("helper", grant.policyId, "owner").ok, true);
  assert.equal(evaluate({ tier: "helper" }, "settings:write"), true, "sanity: helper genuinely holds settings:write before the escalation attempt");
  assert.equal(evaluate({ tier: "helper" }, "server:restart"), false, "sanity: helper does NOT hold server:restart before the escalation attempt");

  // Step 1: the "helper"-tier session (NOT owner) mints a new policy
  // granting unconditional Allow:"*" -- this alone is harmless (an
  // unattached policy grants nothing).
  const godPolicy = createPolicy({ name: "self-escalation-attempt", statements: [{ Effect: "Allow", Action: "*" }] }, "helper");
  assert.equal(godPolicy.ok, true);

  // Step 2: the SAME "helper"-tier session attempts to attach that
  // policy to its OWN tier -- this is the actual escalation step, and
  // must be rejected.
  const attachAttempt = attachPolicy("helper", godPolicy.policyId, "helper");
  assert.equal(attachAttempt.ok, false);
  assert.match(attachAttempt.error, /does not currently hold/);

  // Confirm the rejection actually held -- no privilege was gained.
  assert.equal(evaluate({ tier: "helper" }, "server:restart"), false, "helper must NOT have gained server:restart after the rejected attach");
  assert.equal(evaluate({ tier: "helper" }, "settings:write"), true, "helper's original, legitimate grant must be unaffected by the rejected attempt");
});

test("privilege ceiling: the more direct variant -- a tier overwriting its OWN inline policy to grant itself something it doesn't have -- is also rejected, with no attach step needed", () => {
  _resetPolicyStoreForTests();
  assert.equal(createTier("helper2").ok, true);
  const grant = createPolicy({ name: "helper2-grant", statements: [{ Effect: "Allow", Action: "settings:write" }] }, "owner");
  assert.equal(attachPolicy("helper2", grant.policyId, "owner").ok, true);
  assert.equal(evaluate({ tier: "helper2" }, "settings:write"), true);

  const directAttempt = setTierInline("helper2", [{ Effect: "Allow", Action: "*" }], "helper2");
  assert.equal(directAttempt.ok, false);
  assert.match(directAttempt.error, /does not currently hold/);
  assert.equal(evaluate({ tier: "helper2" }, "server:restart"), false);
});

test("privilege ceiling: rolling back an attached policy to a version that would grant the acting tier something new is also rejected", () => {
  _resetPolicyStoreForTests();
  assert.equal(createTier("helper3").ok, true);
  const grant = createPolicy({ name: "helper3-grant", statements: [{ Effect: "Allow", Action: "settings:write" }] }, "owner");
  const { policyId } = grant;
  // v2 grants settings:write AND server:restart -- broader than v1.
  assert.equal(editPolicy(policyId, { statements: [{ Effect: "Allow", Action: ["settings:write", "server:restart"] }] }, "owner").ok, true);
  // Roll back to v1 (narrower) before attaching, so helper3 starts narrow.
  assert.equal(rollbackPolicy(policyId, "v1", "owner").ok, true);
  assert.equal(attachPolicy("helper3", policyId, "owner").ok, true);
  assert.equal(evaluate({ tier: "helper3" }, "server:restart"), false, "sanity: helper3 does not have server:restart yet (v1 is default)");

  // helper3's own session attempts to roll forward to v2 (broader) --
  // must be rejected, since v2 would grant server:restart, which
  // helper3's own session doesn't currently hold.
  const rollForwardAttempt = rollbackPolicy(policyId, "v2", "helper3");
  assert.equal(rollForwardAttempt.ok, false);
  assert.match(rollForwardAttempt.error, /does not currently hold/);
  assert.equal(evaluate({ tier: "helper3" }, "server:restart"), false);
});

test("privilege ceiling: legitimate, non-escalating operations are NOT blocked -- owner granting broader access, and a tier narrowing its own permissions, both still work", () => {
  _resetPolicyStoreForTests();
  // Owner granting admin broader access -- owner's own ceiling is
  // Allow:"*", so this must succeed exactly as before this fix.
  const ownerGrant = setTierInline("admin", [{ Effect: "Allow", Action: "*" }], "owner");
  assert.equal(ownerGrant.ok, true);
  assert.equal(evaluate({ tier: "admin" }, "settings:write"), true);

  // A tier narrowing its OWN permissions (removing something, adding
  // nothing new) must never be blocked by a "no amplification" check --
  // there is no amplification here at all.
  assert.equal(createTier("helper4").ok, true);
  const grant = createPolicy({ name: "helper4-grant", statements: [{ Effect: "Allow", Action: ["settings:write", "server:read"] }] }, "owner");
  assert.equal(attachPolicy("helper4", grant.policyId, "owner").ok, true);
  const narrowAttempt = setTierInline("helper4", [], "helper4");
  assert.equal(narrowAttempt.ok, true, "narrowing (removing an inline grant, adding nothing) must never be rejected as an escalation");
});

test("privilege ceiling: the legacy setPolicies() route is also subject to the same check when an actorTier is supplied", () => {
  _resetPolicyStoreForTests();
  assert.equal(createTier("helper5").ok, true);
  const grant = createPolicy({ name: "helper5-grant", statements: [{ Effect: "Allow", Action: "settings:write" }] }, "owner");
  assert.equal(attachPolicy("helper5", grant.policyId, "owner").ok, true);

  // A "helper5"-acting session attempts to use the legacy wholesale-
  // replace route to grant its own tier full access via its inline
  // policy -- must be rejected on the same grounds. (migrateIfLegacyShape
  // requires an "owner" key to be present in the document at all -- an
  // unrelated, valid owner entry is included here purely to satisfy that
  // shape requirement, not because owner is the tier under test.)
  const escalationPayload = {
    owner: { tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    helper5: { tier: "helper5", statements: [{ Effect: "Allow", Action: "*" }] }
  };
  const legacyEscalation = setPolicies(escalationPayload, "helper5");
  assert.equal(legacyEscalation.ok, false);
  assert.match(legacyEscalation.error, /does not currently hold/);

  // The same call with actorTier="owner" (or omitted, defaulting to no
  // check) must still work -- confirms this isn't a blanket rejection.
  const legitimateChange = setPolicies(escalationPayload, "owner");
  assert.equal(legitimateChange.ok, true);
});

// ---- Cross-tier neutering / stranger-grant invariant (SECOND Layer 3
// re-audit, Security + Architect hats -- CRITICAL, found INCOMPLETE in
// the gain-only version of detectPrivilegeEscalation() above) ----
//
// The six tests above only ever exercise the ACTOR modifying its OWN
// tier. None of them would have caught this: the original check had NO
// examination of LOSSES on a THIRD-PARTY tier at all, so a tier holding
// only settings:write -- exactly this design's own documented "intended
// use case" -- could silently zero out or arbitrarily modify a
// completely unrelated tier's permissions, including a built-in
// admin/moderator tier, with no relationship required and no rejection.
// These tests reproduce both real reproduction vectors found during that
// re-audit (direct setTierInline() overwrite of a stranger tier, and
// editPolicy() on a policy shared with an unrelated tier) and confirm
// the symmetric fix rejects both while still allowing an actor with a
// genuinely broad-enough ceiling to manage another tier within that
// ceiling, matching AWS's real delegated-admin/permissions-boundary
// model.

test("cross-tier neutering: a tier holding ONLY settings:write cannot call setTierInline on an UNRELATED tier to strip its permissions (direct overwrite vector)", () => {
  _resetPolicyStoreForTests();
  assert.equal(createTier("helper6").ok, true);
  const grant = createPolicy({ name: "helper6-grant", statements: [{ Effect: "Allow", Action: "settings:write" }] }, "owner");
  assert.equal(attachPolicy("helper6", grant.policyId, "owner").ok, true);

  // A real, unrelated built-in tier with real permissions to lose.
  assert.equal(evaluate({ tier: "moderator" }, "server:read"), true, "sanity: moderator holds server:read before the attack");

  // "helper6"-acting session (settings:write only, no relationship to
  // moderator) attempts to zero out moderator's entire inline policy.
  const attack = setTierInline("moderator", [], "helper6");
  assert.equal(attack.ok, false, "a settings:write-only tier must not be able to strip an unrelated tier's permissions");
  assert.match(attack.error, /revoke/);
  assert.match(attack.error, /moderator/);

  // Confirm moderator's permissions are genuinely unaffected.
  assert.equal(evaluate({ tier: "moderator" }, "server:read"), true, "moderator must retain server:read after the rejected attack");
});

test("cross-tier neutering: a tier holding ONLY settings:write cannot use editPolicy on a policy shared with an unrelated tier to strip that tier's grant (indirect vector, no setTierInline call needed)", () => {
  _resetPolicyStoreForTests();
  assert.equal(createTier("helper7").ok, true);
  assert.equal(createTier("victim").ok, true);

  const writeGrant = createPolicy({ name: "helper7-grant", statements: [{ Effect: "Allow", Action: "settings:write" }] }, "owner");
  assert.equal(attachPolicy("helper7", writeGrant.policyId, "owner").ok, true);

  // A policy shared between "helper7" and "victim" -- editing it affects
  // BOTH tiers' aggregates, even though helper7 has no business touching
  // victim's access.
  const sharedPolicy = createPolicy({ name: "shared-with-victim", statements: [{ Effect: "Allow", Action: "server:restart" }] }, "owner");
  assert.equal(attachPolicy("victim", sharedPolicy.policyId, "owner").ok, true);
  assert.equal(evaluate({ tier: "victim" }, "server:restart"), true, "sanity: victim holds server:restart via the shared policy");

  // helper7's session edits the SHARED policy to drop server:restart --
  // this never calls setTierInline on victim at all, but still affects
  // victim's aggregate through the shared attachment.
  const attack = editPolicy(sharedPolicy.policyId, { statements: [] }, "helper7");
  assert.equal(attack.ok, false, "editing a policy shared with an unrelated tier must not silently strip that tier's access");
  assert.match(attack.error, /revoke/);
  assert.match(attack.error, /victim/);

  assert.equal(evaluate({ tier: "victim" }, "server:restart"), true, "victim must retain server:restart after the rejected edit");
});

test("cross-tier neutering: a tier holding ONLY settings:write cannot use editPolicy on a policy shared with an unrelated tier to GRANT that tier something new either (stranger-grant vector)", () => {
  _resetPolicyStoreForTests();
  assert.equal(createTier("helper8").ok, true);
  assert.equal(createTier("stranger").ok, true);

  const writeGrant = createPolicy({ name: "helper8-grant", statements: [{ Effect: "Allow", Action: "settings:write" }] }, "owner");
  assert.equal(attachPolicy("helper8", writeGrant.policyId, "owner").ok, true);

  const sharedPolicy = createPolicy({ name: "shared-with-stranger", statements: [{ Effect: "Allow", Action: "server:read" }] }, "owner");
  assert.equal(attachPolicy("stranger", sharedPolicy.policyId, "owner").ok, true);
  assert.equal(evaluate({ tier: "stranger" }, "server:restart"), false, "sanity: stranger does not hold server:restart yet");

  // helper8 (settings:write only) tries to expand the shared policy to
  // grant server:restart -- helper8 doesn't hold server:restart itself,
  // so this must be rejected exactly like the self-escalation case, even
  // though the tier being granted the new action isn't helper8 itself.
  const attack = editPolicy(sharedPolicy.policyId, { statements: [{ Effect: "Allow", Action: ["server:read", "server:restart"] }] }, "helper8");
  assert.equal(attack.ok, false, "granting an unrelated tier a permission the actor doesn't hold must be rejected, not just self-grants");
  assert.match(attack.error, /grant/);
  assert.equal(evaluate({ tier: "stranger" }, "server:restart"), false);
});

test("cross-tier management: a genuinely broad tier (holding players:* itself) MAY manage another tier's players:* grants -- the ceiling check is a boundary, not a blanket ban on managing other tiers", () => {
  _resetPolicyStoreForTests();
  assert.equal(createTier("scoped-admin").ok, true);
  const broadGrant = createPolicy({ name: "scoped-admin-grant", statements: [{ Effect: "Allow", Action: ["settings:write", "players:*"] }] }, "owner");
  assert.equal(attachPolicy("scoped-admin", broadGrant.policyId, "owner").ok, true);

  assert.equal(createTier("managed").ok, true);
  const managedResult = setTierInline("managed", [{ Effect: "Allow", Action: "players:kick" }], "scoped-admin");
  assert.equal(managedResult.ok, true, "a tier whose own ceiling includes players:* may grant another tier a players:* action, matching AWS delegated-admin semantics");
  assert.equal(evaluate({ tier: "managed" }, "players:kick"), true);

  // But the SAME scoped-admin tier still cannot touch an action outside
  // its own ceiling on that other tier.
  const outOfScope = setTierInline("managed", [{ Effect: "Allow", Action: ["players:kick", "server:restart"] }], "scoped-admin");
  assert.equal(outOfScope.ok, false, "scoped-admin's own ceiling does not include server:restart, so it cannot grant that to any other tier either");
});

test("detachPolicy(): now subject to the privilege-ceiling check -- a tier holding ONLY settings:write cannot detach a policy from an unrelated tier to strip its access (previously had NO actorTier wiring at all)", () => {
  _resetPolicyStoreForTests();
  assert.equal(createTier("helper9").ok, true);
  const writeGrant = createPolicy({ name: "helper9-grant", statements: [{ Effect: "Allow", Action: "settings:write" }] }, "owner");
  assert.equal(attachPolicy("helper9", writeGrant.policyId, "owner").ok, true);

  assert.equal(createTier("victim2").ok, true);
  const victimGrant = createPolicy({ name: "victim2-grant", statements: [{ Effect: "Allow", Action: "server:restart" }] }, "owner");
  assert.equal(attachPolicy("victim2", victimGrant.policyId, "owner").ok, true);
  assert.equal(evaluate({ tier: "victim2" }, "server:restart"), true, "sanity: victim2 holds server:restart before the attack");

  // helper9 (settings:write only, no relationship to victim2) attempts
  // to detach victim2's policy directly.
  const attack = detachPolicy("victim2", victimGrant.policyId, "helper9");
  assert.equal(attack.ok, false, "a settings:write-only tier must not be able to detach an unrelated tier's policy");
  assert.match(attack.error, /revoke/);
  assert.equal(evaluate({ tier: "victim2" }, "server:restart"), true, "victim2 must retain server:restart after the rejected detach");

  // Owner (unconditional ceiling) performing the identical detach must
  // still succeed -- confirms this isn't a blanket rejection of detach.
  const legitimateDetach = detachPolicy("victim2", victimGrant.policyId, "owner");
  assert.equal(legitimateDetach.ok, true);
  assert.equal(evaluate({ tier: "victim2" }, "server:restart"), false);
});

test("detachPolicy(): a tier detaching a policy from ITS OWN tier (self-narrowing) is never blocked, even with no relationship to any other tier", () => {
  _resetPolicyStoreForTests();
  assert.equal(createTier("helper10").ok, true);
  const grant = createPolicy({ name: "helper10-grant", statements: [{ Effect: "Allow", Action: ["settings:write", "server:read"] }] }, "owner");
  assert.equal(attachPolicy("helper10", grant.policyId, "owner").ok, true);

  const selfDetach = detachPolicy("helper10", grant.policyId, "helper10");
  assert.equal(selfDetach.ok, true, "a tier removing its own attached policy is self-narrowing and must never be rejected");
  assert.equal(evaluate({ tier: "helper10" }, "server:read"), false);
});

// ---- Operator-scenario test coverage via the REAL file-based
// loadPolicies() entry point (Layer 3 re-audit finding, DBA hat --
// L3-H4, HIGH) ----
//
// Of the 5 operator scenarios explicitly requested for this feature
// (clean install, upgrade, broken/interrupted-upgrade recovery,
// owner-lockout/corrupted-store recovery, downgrade), only "upgrade" had
// committed test coverage, and even that coverage exercised
// migrateIfLegacyShape() directly rather than the real, file-based
// loadPolicies() entry point every actual console process startup uses.
// A prior revision of this document falsely claimed these were "Fixed in
// Phase 3" -- verified false (no such phase/commit ever existed) during
// a later correction; these tests are the first real implementation of
// what that finding originally specified. Every test below uses a real
// mkdtempSync() temp directory and calls loadPolicies(repoRoot) itself,
// not a lower-level function, so a bug in loadPolicies()'s own file-read/
// parse/fallback logic (not just migrateIfLegacyShape()'s logic, already
// covered above) would be caught here.

test("operator scenario -- clean install: loadPolicies() with NO iam-policies.json file on disk at all falls back to the real, current DEFAULT_POLICIES shape, byte-identical to what every actual clean install's console process does at startup", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-iam-clean-install-"));
  try {
    // Deliberately create the runtime/generated directory structure but
    // NOT the iam-policies.json file itself -- this is exactly what a
    // genuinely fresh install's directory tree looks like before this
    // feature (or any IAM mutation) has ever run.
    mkdirSync(join(repoRoot, "runtime", "generated"), { recursive: true });

    loadPolicies(repoRoot);
    const store = getAllPolicies();

    assert.equal(store.schemaVersion, 2);
    // Every one of the 5 real built-in tiers must resolve exactly as
    // DEFAULT_POLICIES defines them -- this is what a brand-new install
    // with zero prior IAM configuration actually gets.
    assert.equal(evaluate({ tier: "owner" }, "settings:write"), true);
    assert.equal(evaluate({ tier: "admin" }, "settings:write"), false, "admin's built-in Deny on settings:* must be intact on a clean install");
    assert.equal(evaluate({ tier: "admin" }, "server:restart"), true);
    assert.equal(evaluate({ tier: "moderator" }, "players:read"), true);
    assert.equal(evaluate({ tier: "moderator" }, "settings:write"), false);
    assert.equal(evaluate({ tier: "player" }, "server:read"), true);
    assert.equal(evaluate({ tier: "player" }, "players:mutate"), false);
    assert.equal(evaluate({ tier: "observer" }, "server:read"), true);
    assert.equal(evaluate({ tier: "observer" }, "server:restart"), false);
    // A clean install has no named policies and no attachments.
    assert.deepEqual(store.policies, {});
    for (const tier of Object.keys(store.tiers)) {
      assert.deepEqual(store.tiers[tier].attached, [], `clean install's ${tier} tier must have no attached policies`);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("operator scenario -- upgrade: loadPolicies() reading a REAL legacy-shape file from disk (not a direct migrateIfLegacyShape() call) migrates it to schema v2 with byte-identical evaluate() results", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-iam-upgrade-"));
  try {
    const legacy = {
      owner: { tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
      admin: { tier: "admin", statements: [{ Effect: "Allow", Action: "server:*" }] },
      moderator: { tier: "moderator", statements: [{ Effect: "Allow", Action: "players:read" }] },
      player: { tier: "player", statements: [{ Effect: "Allow", Action: "server:read" }] },
      observer: { tier: "observer", statements: [{ Effect: "Allow", Action: "server:read" }] }
    };
    const filePath = join(repoRoot, "runtime", "generated", "iam-policies.json");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(legacy, null, 2));

    loadPolicies(repoRoot);
    const store = getAllPolicies();

    assert.equal(store.schemaVersion, 2, "the real file-based entry point must migrate a legacy-shape file to schema v2, not just accept it as-is");
    for (const tier of Object.keys(legacy)) {
      assert.deepEqual(store.tiers[tier].inline.statements, legacy[tier].statements, `${tier}'s customized statements must survive the real file-based migration byte-identical`);
      assert.deepEqual(store.tiers[tier].attached, []);
    }
    // Re-evaluate a representative action through the migrated,
    // in-memory store to confirm evaluation behavior, not just the raw
    // shape, survived the real file-read path.
    assert.equal(evaluate({ tier: "admin" }, "server:restart"), true);
    assert.equal(evaluate({ tier: "moderator" }, "settings:write"), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("operator scenario -- broken upgrade (i): process killed mid-write leaves a truncated, unparseable JSON file on disk -- loadPolicies() falls back to DEFAULT_POLICIES rather than crashing the console process", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-iam-broken-truncated-"));
  try {
    const filePath = join(repoRoot, "runtime", "generated", "iam-policies.json");
    mkdirSync(dirname(filePath), { recursive: true });
    // A real truncated-mid-write artifact: valid JSON syntax up to an
    // arbitrary cut point, simulating a process killed by the OOM killer
    // or a power loss between writeFileSync() and renameSync() in
    // writeJsonAtomic() (the atomic-rename itself protects against this
    // specific file ending up at the FINAL path in a truncated state in
    // real production use -- this test exists to confirm loadPolicies()
    // is ALSO safe even if that atomicity is ever somehow defeated, e.g.
    // a corrupted filesystem, a manual edit gone wrong, or a restored
    // backup taken mid-write).
    writeFileSync(filePath, '{"schemaVersion": 2, "tiers": {"owner": {"inline": {"statements": [{"Effect": "Allow"');

    loadPolicies(repoRoot);
    const store = getAllPolicies();

    assert.equal(store.schemaVersion, 2);
    assert.equal(evaluate({ tier: "owner" }, "settings:write"), true, "must fall back to real DEFAULT_POLICIES, not crash or leave owner locked out");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("operator scenario -- broken upgrade (ii): a file that is syntactically valid JSON but structurally corrupted (schemaVersion 2 shaped, but validPolicyStore()-invalid) falls back to DEFAULT_POLICIES rather than loading unsafe/malformed state", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-iam-broken-invalid-shape-"));
  try {
    const filePath = join(repoRoot, "runtime", "generated", "iam-policies.json");
    mkdirSync(dirname(filePath), { recursive: true });
    // Valid JSON, claims schemaVersion 2, but "owner" is missing entirely
    // (validPolicyStore() requires owner to exist) -- a real, plausible
    // corruption if e.g. a disk-full condition truncated a write at a
    // syntactically-convenient point, or a manual edit removed the wrong
    // key.
    writeFileSync(filePath, JSON.stringify({
      schemaVersion: 2,
      tiers: { admin: { inline: { statements: [{ Effect: "Allow", Action: "server:*" }] }, attached: [] } },
      policies: {}
    }));

    loadPolicies(repoRoot);
    const store = getAllPolicies();

    assert.equal(store.schemaVersion, 2);
    assert.equal(evaluate({ tier: "owner" }, "settings:write"), true, "must fall back to real DEFAULT_POLICIES when the on-disk store fails validPolicyStore(), not silently operate with no owner tier");
    // Confirms this is genuinely the DEFAULT_POLICIES fallback, not a
    // partial/patched version of the corrupted file.
    assert.equal(evaluate({ tier: "admin" }, "settings:write"), false, "admin's built-in Deny on settings:* must be present -- this is the real fallback, not the corrupted file's admin-only content");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("operator scenario -- broken upgrade (iii): a dangling attached-policy reference on disk (references a policyId that does not exist in the same file) is REJECTED by validPolicyStore(), falling back to DEFAULT_POLICIES rather than loading a store whose aggregation would silently fail closed at evaluation time", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-iam-broken-dangling-ref-"));
  try {
    const filePath = join(repoRoot, "runtime", "generated", "iam-policies.json");
    mkdirSync(dirname(filePath), { recursive: true });
    // A real, plausible corruption: a policy was deleted (or its file
    // section was manually edited out) but the tier's `attached` array
    // still references its old ID -- validPolicyStore()'s referential-
    // integrity check (L1-C3) must reject this at LOAD time, not defer
    // to aggregateStatements()'s runtime fail-closed behavior (L1-C2,
    // a different, already-covered layer of defense for a mutation that
    // happens AFTER a valid store is already loaded, not for what gets
    // loaded from disk in the first place).
    writeFileSync(filePath, JSON.stringify({
      schemaVersion: 2,
      tiers: {
        owner: { inline: { statements: [{ Effect: "Allow", Action: "*" }] }, attached: [] },
        admin: { inline: { statements: [{ Effect: "Allow", Action: "server:*" }] }, attached: ["nonexistent-policy-id"] }
      },
      policies: {}
    }));

    loadPolicies(repoRoot);
    const store = getAllPolicies();

    assert.equal(store.schemaVersion, 2);
    assert.equal(evaluate({ tier: "owner" }, "settings:write"), true, "must fall back to real DEFAULT_POLICIES when the on-disk store has a dangling policy reference, per validPolicyStore()'s referential-integrity check");
    assert.deepEqual(store.tiers.admin.attached, [], "the fallback's admin tier must have the real, empty DEFAULT_POLICIES attachment list, not the corrupted file's dangling reference");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("operator scenario -- downgrade round trip: an OLDER console binary's pre-schema-v2 validPolicyStore() rejects a schemaVersion-2 file (falling back to that older binary's own hardcoded defaults), and a subsequent re-upgrade correctly reads the SAME, still-intact file with all custom tiers/policies preserved", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-iam-downgrade-roundtrip-"));
  try {
    // Step 1: current (schema v2) console creates a custom tier and a
    // named policy -- exactly what an operator using this feature would
    // have on disk before downgrading.
    assert.equal(createTier("custom-ops", repoRoot).ok, true);
    const policy = createPolicy({ name: "ops-grant", statements: [{ Effect: "Allow", Action: "server:restart" }] }, "owner", repoRoot);
    assert.equal(policy.ok, true);
    assert.equal(attachPolicy("custom-ops", policy.policyId, "owner", repoRoot).ok, true);
    assert.equal(evaluate({ tier: "custom-ops" }, "server:restart"), true, "sanity: the custom tier's grant is live before simulating a downgrade");

    const filePath = join(repoRoot, "runtime", "generated", "iam-policies.json");
    const onDiskAfterUpgrade = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(onDiskAfterUpgrade.schemaVersion, 2);

    // Step 2: simulate an OLDER console binary's own validPolicyStore()
    // (copied verbatim from this fork's commit 6c5e2f37^ -- the last
    // commit before schema v2 landed -- not reconstructed from memory,
    // so this is the REAL older validation logic, not an approximation).
    // That older binary's own shape requires every top-level key to be
    // exactly one of the 5 built-in tier names with a flat
    // {tier, statements} shape -- a schemaVersion-2 document's actual
    // top-level keys ("schemaVersion", "tiers", "policies") do not match
    // that shape at all, so the older binary's validPolicyStore() must
    // reject it and fall back to ITS OWN hardcoded defaults.
    function olderBinaryValidPolicyStore(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const tiers = Object.keys(value);
      if (!tiers.length || tiers.some((tier) => !["owner", "admin", "moderator", "player", "observer"].includes(tier))) return false;
      return tiers.every((tier) => {
        const document = value[tier];
        if (!document || document.tier !== tier || !Array.isArray(document.statements)) return false;
        return document.statements.every((statement) => {
          if (!statement || !["Allow", "Deny"].includes(statement.Effect)) return false;
          const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
          return actions.length > 0 && actions.every((action) => typeof action === "string" && action.trim().length > 0);
        });
      });
    }
    assert.equal(
      olderBinaryValidPolicyStore(onDiskAfterUpgrade),
      false,
      "the real older binary's own validation logic must reject a schemaVersion-2 file's top-level shape -- this is the documented, accepted downgrade behavior (design doc §6), not a hypothetical"
    );
    // Confirms the file on disk is genuinely untouched by this
    // (read-only) downgrade simulation -- the older binary's own
    // loadPolicies() falls through to ITS hardcoded DEFAULT_POLICIES in
    // memory; it never rewrites the file just because validation failed.
    const onDiskDuringDowngrade = JSON.parse(readFileSync(filePath, "utf8"));
    assert.deepEqual(onDiskDuringDowngrade, onDiskAfterUpgrade, "the schema-v2 file on disk must be completely untouched while an older binary is running against it -- a downgrade must never destructively overwrite it");

    // Step 3: re-upgrading (the current, schema-v2-aware binary reads
    // the SAME file again) must recover the custom tier/policy exactly
    // as they were, confirming the round trip's data-preservation
    // guarantee -- the file was never actually lost or rewritten, only
    // unreadable to the older binary in between.
    _resetPolicyStoreForTests();
    loadPolicies(repoRoot);
    const storeAfterReupgrade = getAllPolicies();
    assert.equal(storeAfterReupgrade.schemaVersion, 2);
    assert.equal(evaluate({ tier: "custom-ops" }, "server:restart"), true, "the custom tier's grant must be fully recovered after re-upgrading -- the file was never destructively touched during the simulated downgrade window");
    assert.deepEqual(storeAfterReupgrade.tiers["custom-ops"].attached, [policy.policyId]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---- Requirement 26 production-data migration test (Layer 3 re-audit
// finding, GRC hat -- L3-H5, HIGH) ----
//
// See console/api/test/fixtures/README.md for this fixture's full
// provenance and the correction of the original (false) L3-H5 finding's
// premise that real, operator-customized production iam-policies.json
// data exists on dune-dev -- verified directly and found not to exist.
// This fixture is instead the real, current DEFAULT_POLICIES shape every
// actual install (including dune-dev) is genuinely running today,
// copied verbatim from policy.js's own DEFAULT_POLICIES constant --
// itself real, current production data, just not operator-customized
// data. This test loads it through the REAL file-based loadPolicies()
// entry point, closing the DBA hat's original gap that only an inline,
// hand-typed copy of this same shape had ever been exercised, and only
// via a direct migrateIfLegacyShape() call, not the real file path.
test("Requirement 26: the committed production-representative fixture (real, current DEFAULT_POLICIES shape) migrates correctly through the REAL file-based loadPolicies() entry point, with byte-identical evaluate() results for every of the 5 real built-in tiers", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-iam-req26-fixture-"));
  try {
    const filePath = join(repoRoot, "runtime", "generated", "iam-policies.json");
    mkdirSync(dirname(filePath), { recursive: true });
    const fixtureContent = readFileSync(PRODUCTION_REPRESENTATIVE_FIXTURE_PATH, "utf8");
    writeFileSync(filePath, fixtureContent);
    const fixtureLegacyDoc = JSON.parse(fixtureContent);

    loadPolicies(repoRoot);
    const migrated = getAllPolicies();

    assert.equal(migrated.schemaVersion, 2);
    const actionsToCheck = [
      "server:read", "server:restart", "settings:write", "settings:read",
      "database:mutate", "players:read", "players:kick-all", "logs:read",
      "admin:broadcast", "carepackage:grant", "landsraad:read"
    ];
    for (const tier of Object.keys(fixtureLegacyDoc)) {
      for (const action of actionsToCheck) {
        const before = evaluate({ tier }, action, fixtureLegacyDoc);
        const after = evaluate({ tier }, action, migrated);
        assert.equal(after, before, `production-representative fixture: tier=${tier} action=${action} expected ${before}, got ${after} after real file-based migration`);
      }
    }
    // Explicit assertions on the real, currently-shipped default ladder
    // (not just before/after parity) -- confirms this fixture genuinely
    // represents the real DEFAULT_POLICIES ladder, not a stale or
    // hand-edited copy that happens to be internally self-consistent.
    assert.equal(evaluate({ tier: "owner" }, "settings:write", migrated), true);
    assert.equal(evaluate({ tier: "admin" }, "settings:write", migrated), false, "admin's Deny on settings:* is a real, security-relevant default -- this fixture must reflect it accurately");
    assert.equal(evaluate({ tier: "admin" }, "carepackage:grant", migrated), true);
    assert.equal(evaluate({ tier: "moderator" }, "admin:broadcast", migrated), true);
    assert.equal(evaluate({ tier: "moderator" }, "carepackage:grant", migrated), false);
    assert.equal(evaluate({ tier: "player" }, "players:kick-all", migrated), false);
    assert.equal(evaluate({ tier: "observer" }, "players:read", migrated), true);
    assert.equal(evaluate({ tier: "observer" }, "storage:mutate", migrated), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
