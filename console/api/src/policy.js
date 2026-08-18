// Console IAM — AWS IAM-style policy evaluation engine, with AWS-mirrored
// policy/role editing and maintenance (named, versioned, reusable Policy
// objects; roles/tiers attach zero or more, plus one optional inline
// policy of their own).
//
// Implements: Deny > Allow > default Deny with wildcard matching.
// Policies are loaded from runtime/generated/iam-policies.json at
// startup; if the file is missing or invalid, hardcoded defaults
// (equivalent to the current CAPABILITY_BY_TIER model) are used.
//
// Schema v2 store shape:
//   {
//     "schemaVersion": 2,
//     "tiers": {
//       "owner": { "inline": { "statements": [...] } | null, "attached": ["<policyId>", ...] },
//       ...
//     },
//     "policies": {
//       "<policyId>": {
//         "name": "read-only-metrics",
//         "managed": false,
//         "defaultVersionId": "v2",
//         "versions": {
//           "v1": { "statements": [...], "createdAt": "...", "createdBy": "owner" },
//           "v2": { "statements": [...], "createdAt": "...", "createdBy": "owner" }
//         }
//       }
//     }
//   }
//
// Statement format (unchanged from the pre-schema-v2 engine):
//   { "Effect": "Deny",  "Action": ["players:reset-progression"] }
//   { "Effect": "Allow", "Action": ["players:*", "server:read"] }
//
// Evaluation: for each statement in order (across the tier's inline
// policy, if any, followed by every attached policy's DEFAULT version,
// concatenated -- attachment order does not affect the result, since an
// explicit Deny anywhere always wins per the loop below),
//   if action matches statement AND Effect=Deny  -> DENY immediately
//   if action matches statement AND Effect=Allow -> mark ALLOWED
//   if no statement matched                        -> DENY (default)
//
// See docs/design/console-custom-iam-roles-l1-design-2026-08-17.md for
// the full L1 design and its Layer 1 eight-hats audit findings register
// (§9) -- several of the invariants enforced below (fail-closed
// aggregation, referential integrity, the single mutation choke point)
// exist specifically because that audit found a naive implementation of
// this exact file would violate them.

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ROUTE_ACTIONS, REGEX_ACTIONS, REGEX_ACTIONS_BY_METHOD, REGEX_ACTIONS_BY_METHOD_PATTERN } from "./actions.js";
import { writeJsonAtomic } from "./jsonStore.js";
import { redact } from "./redact.js";

// ---- Constants ----

export const WILDCARD = "*";

// Tier/role names are slug-like identifiers (closer to this project's own
// branch/addon-naming conventions than to actions.js's fixed, hand-curated
// namespace enum) -- lowercase, 2-32 chars, hyphens/underscores allowed.
// Decided explicitly during the Layer 1 design review (§8 item 1); no hat
// raised a security or consistency objection to this shape.
export const RESERVED_TIER_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

// Resource bounds, decided during the Layer 1 design review (§8 item 2) in
// response to the Network hat's finding that GET .../policies' response
// size was otherwise unbounded. Owner-only, human-paced feature -- these
// are generous-for-real-usage-but-bounded numbers, not a tight limit.
export const MAX_NAMED_POLICIES = 50;
export const MAX_CUSTOM_TIERS = 20;
export const MAX_POLICY_VERSIONS = 5;

const BUILT_IN_TIER_NAMES = new Set(["owner", "admin", "moderator", "player", "observer"]);

// ---- Policy evaluation ----

export function matchAction(pattern, action) {
  if (pattern === WILDCARD) return true;
  if (pattern.endsWith(":*")) {
    const ns = pattern.slice(0, -2);
    return action === ns || action.startsWith(ns + ":");
  }
  if (pattern.endsWith("-*")) {
    const prefix = pattern.slice(0, -1);
    return action.startsWith(prefix);
  }
  // Exact match or wildcard segment
  if (pattern === action) return true;
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return regex.test(action);
  }
  return false;
}

// Aggregates a tier's inline statements with every attached policy's
// DEFAULT version's statements, per the L1 design's §4.1. This is the
// single place "what statements apply to this tier" is computed, used by
// both evaluate() and the owner-lockout guard in the mutation choke point
// below -- both must see the exact same aggregate, or the lockout guard
// could pass/fail on a different view of reality than evaluate() itself.
//
// Fail-closed requirement (L1 audit finding L1-C2, Architect hat): if an
// attached policyId does not resolve to a real policy, or a policy's
// defaultVersionId does not resolve to a real version, that reference
// contributes an implicit `{Effect: "Deny", Action: "*"}` statement to
// the aggregate rather than silently contributing nothing. A naive
// "just skip it" implementation was traced by the audit to fail OPEN
// (silently dropping a Deny re-grants whatever it was blocking) -- this
// is the opposite, deliberate behavior. In steady-state operation this
// branch should never be reached at all, because validPolicyStore()'s
// referential-integrity check (added per L1-C3) rejects a store with a
// dangling reference before it is ever loaded -- this is a defense-in-
// depth backstop for a state validPolicyStore() failed to catch (e.g.
// direct file corruption bypassing normal load), not the primary
// integrity mechanism.
export function aggregateStatements(tierRecord, policies) {
  const statements = [];
  if (!tierRecord) return statements;

  if (tierRecord.inline && Array.isArray(tierRecord.inline.statements)) {
    statements.push(...tierRecord.inline.statements);
  }

  for (const policyId of tierRecord.attached || []) {
    const policy = policies[policyId];
    const version = policy && policy.versions ? policy.versions[policy.defaultVersionId] : null;
    if (!policy || !version || !Array.isArray(version.statements)) {
      // Dangling/unresolvable reference -- fail closed (see comment above).
      statements.push({ Effect: "Deny", Action: WILDCARD });
      continue;
    }
    statements.push(...version.statements);
  }

  return statements;
}

export function evaluate(session, action, policies = null) {
  // No action to check — public route
  if (!action) return true;

  const tier = resolveSessionTier(session, policies);
  if (!tier) return false;

  const store = policies || _policies || wrapDefaultPolicies();
  const tierRecord = store.tiers ? store.tiers[tier] : store[tier];

  // Legacy (pre-schema-v2) shape support: a bare { tier: {statements} }
  // document, as used throughout this file's own test fixtures and any
  // caller that hasn't migrated a passed-in `policies` override to the v2
  // shape. Treated as a tier with only an inline policy and nothing
  // attached -- byte-identical to today's evaluation for that shape.
  const effectiveTierRecord = store.schemaVersion === 2
    ? tierRecord
    : (tierRecord ? { inline: { statements: tierRecord.statements || [] }, attached: [] } : null);

  if (!effectiveTierRecord) return false;

  const effectivePolicies = store.schemaVersion === 2 ? (store.policies || {}) : {};
  const statements = aggregateStatements(effectiveTierRecord, effectivePolicies);

  let allowed = false;
  for (const stmt of statements) {
    const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
    const effect = stmt.Effect;

    for (const pattern of actions) {
      if (matchAction(pattern, action)) {
        if (effect === "Deny") return false;
        if (effect === "Allow") allowed = true;
      }
    }
  }

  return allowed;
}

export function resolveSessionTier(session, policies = null) {
  if (!session) return "";
  const tier = typeof session.tier === "string" ? session.tier : "";
  if (!tier) return "";
  const store = policies || _policies || wrapDefaultPolicies();
  const tiers = store.schemaVersion === 2 ? store.tiers : store;
  return tiers && tiers[tier] ? tier : "";
}

// ---- Policy store ----

let _policies = null;

export function loadPolicies(repoRoot = null) {
  const filePath = repoRoot
    ? resolve(repoRoot, "runtime/generated/iam-policies.json")
    : resolve(process.cwd(), "../..", "runtime/generated/iam-policies.json");

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const migrated = migrateIfLegacyShape(parsed);
      if (migrated && validPolicyStore(migrated)) {
        _policies = migrated;
        return;
      }
    } catch {
      // Fall through to defaults
    }
  }

  // Hardcoded fallback defaults
  _policies = wrapDefaultPolicies();
}

// Migrates a legacy (pre-schema-v2) flat `{ tierName: {tier, statements} }`
// store into schema v2. Runs on every loadPolicies() call, which -- per
// the L1 audit's Architect hat, verified directly against the real call
// graph -- happens exactly once per process start (server.js's single
// `loadPolicies(config.repoRoot)` call site), never per-request. This
// closes the design's own §8 Open Item #4 with no further action needed:
// there is no repeated migration cost and no race with concurrent writes
// via this call path specifically.
//
// Per-tier salvage (L1 audit finding L1-H5, DBA hat, verified by direct
// execution against the original whole-file-reject draft): a single
// malformed tier entry no longer discards every other, individually-valid
// tier's customizations. Only a genuinely malformed tier is dropped (or
// defaulted, if it's one of the 5 built-ins); every tier that validates
// cleanly survives migration untouched.
export function migrateIfLegacyShape(parsed) {
  if (parsed && parsed.schemaVersion === 2) return parsed; // already current

  // Whole-file rejection is reserved for genuinely unparseable/structurally
  // alien input (not an object, or an array) -- there is no partial signal
  // worth salvaging in that case. This is NOT the same code path as "one
  // tier among several is malformed" (handled below).
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const tiers = {};
  const failedTiers = [];
  for (const [tierName, doc] of Object.entries(parsed)) {
    if (!doc || doc.tier !== tierName || !Array.isArray(doc.statements)) {
      failedTiers.push(tierName);
      continue; // salvage every other tier; do not abort the whole migration
    }
    tiers[tierName] = { inline: { statements: doc.statements }, attached: [] };
  }

  if (failedTiers.length) {
    console.warn(redact(
      `IAM policy migration: ${failedTiers.length} tier document(s) failed ` +
      `validation and were ${failedTiers.filter((t) => DEFAULT_POLICIES[t]).length ? "reset to defaults" : "dropped"} ` +
      `during migration to schema v2: ${failedTiers.join(", ")}`
    ));
    for (const tierName of failedTiers) {
      if (DEFAULT_POLICIES[tierName]) {
        tiers[tierName] = { inline: { statements: DEFAULT_POLICIES[tierName].statements }, attached: [] };
      }
      // else: unrecognized custom tier name with malformed data -- dropped,
      // not defaulted. A session claiming this tier will fail to resolve,
      // matching this design's existing "no policy for this tier" behavior.
    }
  }

  if (!tiers.owner) return null; // owner must always exist post-migration -- if even
                                   // the fallback couldn't produce one, this IS the
                                   // alien-input case; caller falls through to full
                                   // DEFAULT_POLICIES.
  return { schemaVersion: 2, tiers, policies: {} };
}

let _allowedActions = {};

// A parameterized route (e.g. DELETE /api/bases/{baseId}) has no exact
// ROUTE_ACTIONS entry -- actionForRoute resolves it through one of three
// other tiers instead (see actions.js). bases:delete is the reason this
// enumerates all four: it exists only in REGEX_ACTIONS_BY_METHOD_PATTERN, so
// a version of this that only read ROUTE_ACTIONS would never surface it.
function allKnownActionsSet() {
  const actions = new Set(Object.values(ROUTE_ACTIONS));
  for (const [, action] of REGEX_ACTIONS) actions.add(action);
  for (const action of Object.values(REGEX_ACTIONS_BY_METHOD)) actions.add(action);
  for (const { action } of REGEX_ACTIONS_BY_METHOD_PATTERN) actions.add(action);
  return actions;
}

// Exported (per the L1 design's §4.5) so server.js's Policy Simulator
// route can reuse this enumeration rather than duplicating it.
export function allKnownActions() {
  return allKnownActionsSet();
}

export function resolveAllowedActions(tier) {
  if (!tier) return [];
  if (_allowedActions[tier]) return _allowedActions[tier];

  const allActions = allKnownActionsSet();
  const mockSession = { tier };
  const allowed = [];

  for (const action of allActions) {
    if (evaluate(mockSession, action)) {
      allowed.push(action);
    }
  }

  _allowedActions[tier] = allowed;
  return allowed;
}

function invalidateAllowedActionsCache() {
  _allowedActions = {};
}

// Matches this codebase's existing `_resetXForTests()` convention (see
// duneDb.js's `_resetPlayerTargetCacheForTests`) -- resets the in-memory
// store to the wrapped hardcoded defaults, discarding any custom
// tiers/policies a previous test created. Test-only; not called anywhere
// in production code paths.
export function _resetPolicyStoreForTests() {
  _policies = wrapDefaultPolicies();
  _allowedActions = {};
}

export function getPolicy(tier, policies = null) {
  const store = policies || _policies || wrapDefaultPolicies();
  return store.tiers ? store.tiers[tier] || null : store[tier] || null;
}

// Returns the full store (tiers + policies), matching the pre-schema-v2
// return shape's role as "the whole thing" for GET .../iam/policies. The
// L1 design's §8 item 2 resolution (list route returns default-version-
// only) is implemented in server.js's route handler, not here -- this
// function returns the true, complete in-memory state; summarization for
// the list response is the caller's job, so any other future caller that
// needs the full detail (e.g. the Policy Simulator's `mode: "tier"`) isn't
// short-changed by a summarization decision made for one specific route.
export function getAllPolicies(policies = null) {
  const store = policies || _policies || wrapDefaultPolicies();
  return {
    schemaVersion: 2,
    tiers: { ...(store.tiers || {}) },
    policies: { ...(store.policies || {}) }
  };
}

// ---- Referential integrity + shape validation ----

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validStatementList(statements) {
  if (!Array.isArray(statements)) return false;
  return statements.every((statement) => {
    if (!statement || !["Allow", "Deny"].includes(statement.Effect)) return false;
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return actions.length > 0 && actions.every((action) => typeof action === "string" && action.trim().length > 0);
  });
}

function validPolicyObject(policy) {
  if (!isPlainObject(policy)) return false;
  if (typeof policy.name !== "string" || !policy.name.trim()) return false;
  if (typeof policy.managed !== "boolean") return false;
  if (typeof policy.defaultVersionId !== "string" || !policy.defaultVersionId) return false;
  if (!isPlainObject(policy.versions) || !Object.keys(policy.versions).length) return false;
  if (Object.keys(policy.versions).length > MAX_POLICY_VERSIONS) return false;

  // Referential integrity (L1 audit finding L1-C3, DBA hat): defaultVersionId
  // must resolve to a real entry in this policy's own versions map.
  if (!policy.versions[policy.defaultVersionId]) return false;

  return Object.values(policy.versions).every((version) => {
    if (!isPlainObject(version)) return false;
    if (typeof version.createdAt !== "string" || !version.createdAt) return false;
    if (typeof version.createdBy !== "string" || !version.createdBy) return false;
    return validStatementList(version.statements);
  });
}

function validTierRecord(tierRecord, policyIds) {
  if (!isPlainObject(tierRecord)) return false;
  if (tierRecord.inline !== null) {
    if (!isPlainObject(tierRecord.inline) || !validStatementList(tierRecord.inline.statements)) return false;
  }
  if (!Array.isArray(tierRecord.attached)) return false;

  // Referential integrity (L1 audit finding L1-C3, DBA hat): every
  // attached policyId must resolve to a real entry in the top-level
  // policies map. A dangling reference here is treated the same as any
  // other invalid shape -- reject the whole store, do not silently patch
  // it, since at validation time (as opposed to the resolution-time gap
  // aggregateStatements()'s fail-closed guard exists for) a dangling
  // reference indicates file corruption, not a normal runtime state.
  return tierRecord.attached.every((policyId) => typeof policyId === "string" && policyIds.has(policyId));
}

// Replaces the pre-schema-v2 validPolicyStore(): validates the
// {schemaVersion, tiers, policies} shape directly, including bidirectional
// referential integrity between tiers[].attached and the policies map
// (L1 audit finding L1-C3). "owner" remains the one tier name that must
// always exist -- not specially validated beyond presence, but relied
// upon by setPolicies()'s existing lockout check, which this validator
// does not duplicate.
function validPolicyStore(value) {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== 2) return false;
  if (!isPlainObject(value.tiers)) return false;
  if (!isPlainObject(value.policies)) return false;

  const tierNames = Object.keys(value.tiers);
  if (!tierNames.length) return false;
  if (!tierNames.includes("owner")) return false;
  if (!tierNames.every((tier) => RESERVED_TIER_NAME_PATTERN.test(tier))) return false;

  const customTierCount = tierNames.filter((t) => !BUILT_IN_TIER_NAMES.has(t)).length;
  if (customTierCount > MAX_CUSTOM_TIERS) return false;

  const policyIds = new Set(Object.keys(value.policies));
  if (policyIds.size > MAX_NAMED_POLICIES) return false;

  if (!tierNames.every((tier) => validTierRecord(value.tiers[tier], policyIds))) return false;
  if (!Object.values(value.policies).every((policy) => validPolicyObject(policy))) return false;

  return true;
}

// Exported for the mutation choke point below and for direct testing.
export { validPolicyStore };

// ---- Single mutation choke point (L1 audit finding L1-C1) ----
//
// EVERY mutating operation on the policy store -- creating/editing/rolling
// back/deleting a named policy, creating a tier, setting a tier's inline
// policy, attaching/detaching a policy -- MUST go through applyMutation().
// This is not a style preference: the L1 audit (independently, via
// Security, DBA, and QA hats) found that a per-route-reimplemented
// owner-lockout guard has a real, provable bypass, because a policy edit
// or rollback never touches `tiers.owner` directly even when it changes
// owner's effective aggregate. Funneling every mutation through one
// function that re-validates the RESULTING store's shape, referential
// integrity, and owner's settings:write aggregate -- regardless of which
// specific field changed -- closes that gap structurally rather than
// trusting each of 7 independently-implemented handlers to remember to
// re-derive it.
//
// `mutator` receives a deep-enough mutable copy of the current store and
// must return the fully mutated store (or throw/return an error marker;
// see callers below for the exact per-operation contracts).
function applyMutation(mutatorFn) {
  const current = getAllPolicies();
  const next = mutatorFn(current);
  if (next && next.error) return next; // mutator reported a domain-specific rejection

  if (!validPolicyStore(next)) {
    return { ok: false, error: "The resulting policy store is invalid." };
  }
  if (!evaluate({ tier: "owner" }, "settings:write", next)) {
    return { ok: false, error: "This change would remove the owner tier's settings:write access, including through its attached policies. Rejected to prevent lockout." };
  }

  _policies = next;
  invalidateAllowedActionsCache();
  return { ok: true, policies: getAllPolicies() };
}

function deepCopyStore(store) {
  return {
    schemaVersion: 2,
    tiers: Object.fromEntries(Object.entries(store.tiers).map(([name, rec]) => [
      name,
      { inline: rec.inline ? { statements: [...rec.inline.statements] } : null, attached: [...rec.attached] }
    ])),
    policies: Object.fromEntries(Object.entries(store.policies).map(([id, policy]) => [
      id,
      {
        name: policy.name,
        managed: policy.managed,
        defaultVersionId: policy.defaultVersionId,
        versions: Object.fromEntries(Object.entries(policy.versions).map(([vid, v]) => [
          vid,
          { statements: [...v.statements], createdAt: v.createdAt, createdBy: v.createdBy }
        ]))
      }
    ]))
  };
}

function persist(repoRoot) {
  if (repoRoot) writeJsonAtomic(resolve(repoRoot, "runtime/generated/iam-policies.json"), _policies, 0o600);
}

// ---- Legacy single-route entry point (kept for the existing PUT
// /api/settings/iam/policy route's backward-compatible shape) ----
//
// Accepts EITHER a legacy flat `{tierName: {tier, statements}}` document
// (auto-migrated) OR an already-schema-v2 `{schemaVersion, tiers, policies}`
// document, replacing the tiers' inline policies wholesale. This is the
// direct successor of the pre-schema-v2 setPolicies() and is what today's
// single IAM route (`PUT /api/settings/iam/policy`) continues to call --
// preserved so existing tests/API-clients using the legacy per-tier-map
// shape keep working, per the L1 audit's QA hat finding (L1-M-contract)
// that this codebase's existing tests exercise setPolicies() with the
// legacy shape.
export function setPolicies(docs, repoRoot = null) {
  const migrated = migrateIfLegacyShape(docs) || (docs && docs.schemaVersion === 2 ? docs : null);
  if (!migrated) {
    return { ok: false, error: "Policies must contain valid tier documents and Allow/Deny statements." };
  }

  const result = applyMutation((current) => {
    // Wholesale-replace tiers' inline policies with whatever was supplied,
    // preserving any already-attached policies for tiers not mentioned in
    // the incoming document (matches the pre-schema-v2 behavior of a full
    // per-tier-map replace, extended to not silently drop attachments this
    // route was never designed to know about).
    const next = deepCopyStore(current);
    for (const [tierName, tierRecord] of Object.entries(migrated.tiers)) {
      next.tiers[tierName] = {
        inline: tierRecord.inline,
        attached: next.tiers[tierName] ? next.tiers[tierName].attached : []
      };
    }
    return next;
  });

  if (result.ok) persist(repoRoot);
  return result;
}

// ---- Named policy lifecycle (§4.2) ----

export function createPolicy({ name, statements }, actorTier, repoRoot = null) {
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, error: "A policy name is required." };
  }
  if (!validStatementList(statements)) {
    return { ok: false, error: "statements must be a non-empty, valid Allow/Deny statement list." };
  }

  // Generated up front rather than inside the mutator, so the ID is known
  // to this function without needing to search the committed store for it
  // afterward -- randomUUID() collision odds are astronomically low, and
  // even a collision would be caught deterministically as a validation
  // failure (an already-existing key silently overwritten would still
  // satisfy validPolicyStore(), so this is a correctness note, not a
  // safety-relevant one: the store is owner-only, human-paced, and a
  // UUIDv4 collision here is not a realistic operational concern).
  const policyId = randomUUID();
  const versionId = "v1";

  const result = applyMutation((current) => {
    if (Object.keys(current.policies).length >= MAX_NAMED_POLICIES) {
      return { error: `Cannot create another named policy -- the limit of ${MAX_NAMED_POLICIES} named policies has been reached. Delete an unused policy first.` };
    }
    const next = deepCopyStore(current);
    next.policies[policyId] = {
      name: name.trim(),
      managed: false,
      defaultVersionId: versionId,
      versions: { [versionId]: { statements, createdAt: new Date().toISOString(), createdBy: actorTier || "owner" } }
    };
    return next;
  });

  if (result.error && !result.ok) return { ok: false, error: result.error };
  if (repoRoot && result.ok) persist(repoRoot);
  return result.ok ? { ok: true, policyId, defaultVersionId: versionId } : result;
}

export function editPolicy(policyId, { statements }, actorTier, repoRoot = null) {
  if (!validStatementList(statements)) {
    return { ok: false, error: "statements must be a non-empty, valid Allow/Deny statement list." };
  }

  const result = applyMutation((current) => {
    const policy = current.policies[policyId];
    if (!policy) return { error: "No such policy." };

    const versionCount = Object.keys(policy.versions).length;
    if (versionCount >= MAX_POLICY_VERSIONS) {
      // Name the oldest NON-DEFAULT version, per the L1 design's §4.2 UX
      // requirement (and §7's test coverage for this exact error content,
      // added per L1 audit finding L1-H4, QA hat). "Oldest" is unambiguous
      // even after a rollback: it is the version with the earliest
      // createdAt among all versions that are not the current default --
      // not simply the numerically-first version ID, since a rollback can
      // make an old version the current default again.
      const oldestNonDefault = Object.entries(policy.versions)
        .filter(([vid]) => vid !== policy.defaultVersionId)
        .sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt))[0];
      const oldestId = oldestNonDefault ? oldestNonDefault[0] : null;
      return {
        error: `This policy already has the maximum of ${MAX_POLICY_VERSIONS} versions. Delete version "${oldestId}" (the oldest non-default version) before creating a new one.`
      };
    }

    const next = deepCopyStore(current);
    // Derived from the highest existing numeric suffix, not
    // Object.keys(...).length + 1 -- a version in the middle (e.g. v2)
    // can be deleted while v1 and v3 remain, and versionCount+1 would
    // then collide with the still-existing v3. Monotonic-highest-plus-one
    // is collision-safe regardless of deletion history.
    const highestSeq = Object.keys(current.policies[policyId].versions)
      .map((vid) => Number(vid.replace(/^v/, "")) || 0)
      .reduce((max, n) => Math.max(max, n), 0);
    const newVersionId = `v${highestSeq + 1}`;
    next.policies[policyId].versions[newVersionId] = { statements, createdAt: new Date().toISOString(), createdBy: actorTier || "owner" };
    next.policies[policyId].defaultVersionId = newVersionId;
    return next;
  });

  if (result.error && !result.ok) return { ok: false, error: result.error };
  if (repoRoot && result.ok) persist(repoRoot);
  return result.ok ? { ok: true, defaultVersionId: _policies.policies[policyId]?.defaultVersionId } : result;
}

export function rollbackPolicy(policyId, versionId, repoRoot = null) {
  const result = applyMutation((current) => {
    const policy = current.policies[policyId];
    if (!policy) return { error: "No such policy." };
    if (!policy.versions[versionId]) return { error: "No such version on this policy." };

    const next = deepCopyStore(current);
    next.policies[policyId].defaultVersionId = versionId;
    return next;
  });

  if (result.error && !result.ok) return { ok: false, error: result.error };
  if (repoRoot && result.ok) persist(repoRoot);
  return result;
}

export function deletePolicyVersion(policyId, versionId, repoRoot = null) {
  const result = applyMutation((current) => {
    const policy = current.policies[policyId];
    if (!policy) return { error: "No such policy." };
    if (!policy.versions[versionId]) return { error: "No such version on this policy." };
    if (policy.defaultVersionId === versionId) {
      return { error: "Cannot delete the default version. Roll back to a different version first, then delete this one." };
    }

    const next = deepCopyStore(current);
    delete next.policies[policyId].versions[versionId];
    return next;
  });

  if (result.error && !result.ok) return { ok: false, error: result.error };
  if (repoRoot && result.ok) persist(repoRoot);
  return result;
}

export function deletePolicy(policyId, repoRoot = null) {
  const result = applyMutation((current) => {
    const policy = current.policies[policyId];
    if (!policy) return { error: "No such policy." };

    const attachingTiers = Object.entries(current.tiers)
      .filter(([, rec]) => rec.attached.includes(policyId))
      .map(([name]) => name);
    if (attachingTiers.length) {
      return { error: `Cannot delete this policy -- it is attached to: ${attachingTiers.join(", ")}. Detach it from every tier first.` };
    }

    const next = deepCopyStore(current);
    delete next.policies[policyId];
    return next;
  });

  if (result.error && !result.ok) return { ok: false, error: result.error };
  if (repoRoot && result.ok) persist(repoRoot);
  return result;
}

// ---- Tiers / roles (§4.3) ----

export function createTier(tierName, repoRoot = null) {
  if (typeof tierName !== "string" || !RESERVED_TIER_NAME_PATTERN.test(tierName)) {
    return { ok: false, error: "Tier name must be lowercase, 2-32 characters, letters/digits/hyphens/underscores only." };
  }

  const result = applyMutation((current) => {
    if (current.tiers[tierName]) return { error: "A tier with this name already exists." };
    const customCount = Object.keys(current.tiers).filter((t) => !BUILT_IN_TIER_NAMES.has(t)).length;
    if (customCount >= MAX_CUSTOM_TIERS) {
      return { error: `Cannot create another custom tier -- the limit of ${MAX_CUSTOM_TIERS} custom tiers has been reached.` };
    }
    const next = deepCopyStore(current);
    next.tiers[tierName] = { inline: null, attached: [] };
    return next;
  });

  if (result.error && !result.ok) return { ok: false, error: result.error };
  if (repoRoot && result.ok) persist(repoRoot);
  return result;
}

export function setTierInline(tierName, statements, repoRoot = null) {
  if (!validStatementList(statements)) {
    return { ok: false, error: "statements must be a non-empty, valid Allow/Deny statement list." };
  }

  const result = applyMutation((current) => {
    if (!current.tiers[tierName]) return { error: "No such tier." };
    const next = deepCopyStore(current);
    next.tiers[tierName].inline = { statements };
    return next;
  });

  if (result.error && !result.ok) return { ok: false, error: result.error };
  if (repoRoot && result.ok) persist(repoRoot);
  return result;
}

export function attachPolicy(tierName, policyId, repoRoot = null) {
  const result = applyMutation((current) => {
    if (!current.tiers[tierName]) return { error: "No such tier." };
    if (!current.policies[policyId]) return { error: "No such policy." };
    if (current.tiers[tierName].attached.includes(policyId)) {
      return current; // idempotent -- already attached, nothing to change
    }
    const next = deepCopyStore(current);
    next.tiers[tierName].attached.push(policyId);
    return next;
  });

  if (result.error && !result.ok) return { ok: false, error: result.error };
  if (repoRoot && result.ok) persist(repoRoot);
  return result;
}

export function detachPolicy(tierName, policyId, repoRoot = null) {
  const result = applyMutation((current) => {
    if (!current.tiers[tierName]) return { error: "No such tier." };
    const next = deepCopyStore(current);
    next.tiers[tierName].attached = next.tiers[tierName].attached.filter((id) => id !== policyId);
    return next;
  });

  if (result.error && !result.ok) return { ok: false, error: result.error };
  if (repoRoot && result.ok) persist(repoRoot);
  return result;
}

// ---- Default policies (mirror the CAPABILITY_BY_TIER ladder) ----

const DEFAULT_POLICIES = {
  owner: {
    version: 1,
    tier: "owner",
    statements: [
      { Effect: "Allow", Action: "*" }
    ]
  },
  admin: {
    version: 1,
    tier: "admin",
    statements: [
      { Effect: "Allow", Action: [
        "setup:*",
        "server:*",
        "logs:*",
        "backups:*",
        "database:read",
        "database:query",
        "database:export",
        "updates:*",
        "players:*",
        "guilds:*",
        "bases:*",
        "storage:*",
        "blueprints:*",
        "vehicles:*",
        "exchange:*",
        "maps:*",
        "sietches:*",
        "deepdesert:*",
        "admin:*",
        "landsraad:*",
        "addons:*",
        "carepackage:*",
      ]},
      { Effect: "Deny", Action: [
        "settings:*",
        "database:write-config",
        "database:mutate",
      ]}
    ]
  },
  moderator: {
    version: 1,
    tier: "moderator",
    statements: [
      { Effect: "Allow", Action: [
        "server:read",
        "maps:read",
        "sietches:read",
        "deepdesert:read",
        "players:read",
        "players:kick-all",
        "guilds:read",
        "bases:read",
        "storage:read",
        "blueprints:read",
        "vehicles:read",
        "exchange:read",
        "logs:*",
        "landsraad:read",
        "admin:broadcast",
        "admin:map-chat",
      ]},
    ]
  },
  player: {
    version: 1,
    tier: "player",
    statements: [
      { Effect: "Allow", Action: [
        "server:read",
        "maps:read",
        "sietches:read",
        "deepdesert:read",
        "players:read",
        "guilds:read",
        "bases:read",
        "storage:read",
        "blueprints:read",
        "vehicles:read",
        "exchange:read",
        "landsraad:read",
      ]},
    ]
  },
  observer: {
    version: 1,
    tier: "observer",
    statements: [
      { Effect: "Allow", Action: [
        "server:read",
        "maps:read",
        "sietches:read",
        "deepdesert:read",
        "players:read",
        "guilds:read",
        "bases:read",
        "storage:read",
        "blueprints:read",
        "vehicles:read",
        "exchange:read",
        "landsraad:read",
      ]},
    ]
  },
};

function wrapDefaultPolicies() {
  const tiers = {};
  for (const [tierName, doc] of Object.entries(DEFAULT_POLICIES)) {
    tiers[tierName] = { inline: { statements: doc.statements }, attached: [] };
  }
  return { schemaVersion: 2, tiers, policies: {} };
}
