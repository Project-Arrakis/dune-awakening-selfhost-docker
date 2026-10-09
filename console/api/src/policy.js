// Console IAM — AWS IAM-style policy evaluation engine.
//
// Implements: Deny > Allow > default Deny with wildcard matching.
// Policies are loaded from runtime/generated/iam-policies.json at
// startup; if the file is missing or invalid, hardcoded defaults
// (equivalent to the current CAPABILITY_BY_TIER model) are used.
//
// Policy document format (per tier):
//   { "version": 1, "tier": "moderator",
//     "statements": [
//       { "Effect": "Deny",  "Action": ["bases:delete"] },
//       { "Effect": "Allow", "Action": ["bases:*", "server:read"] }
//     ]}
//
// Every Action must be a REAL action, or a wildcard matching at least one; a
// name matching nothing denies nothing while reading like a restriction.
// setPolicies refuses those (unknownActions). A name the catalog USED to have
// is a separate case: REMOVED_ACTION_ALIASES keeps its old meaning at
// evaluation time, and setPolicies refuses it on save so the operator migrates.
//
// Evaluation: for each statement in order,
//   if action matches statement AND Effect=Deny  → DENY immediately
//   if action matches statement AND Effect=Allow → mark ALLOWED
//   if no statement matched                        → DENY (default)

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROUTE_ACTIONS, REGEX_ACTIONS, REGEX_ACTIONS_BY_METHOD, REGEX_ACTIONS_BY_METHOD_PATTERN, CONTENT_CONDITIONAL_ACTIONS, REMOVED_ACTION_ALIASES } from "./actions.js";
import { writeJsonAtomic } from "./jsonStore.js";

// ---- Policy evaluation ----

export const WILDCARD = "*";

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
    return wildcardRegex(pattern).test(action);
  }
  // A name this catalog used to have. Checked LAST so it can never shadow a
  // live action. See REMOVED_ACTION_ALIASES in actions.js for why a split
  // cannot simply delete the old name.
  const successors = REMOVED_ACTION_ALIASES[pattern];
  if (successors) return successors.includes(action);
  return false;
}

// Every regex metacharacter EXCEPT `*` is escaped before compiling (#242).
//
// This used to be `pattern.replace(/\*/g, ".*")` alone, so everything else in an
// operator-supplied policy pattern reached the RegExp constructor raw. Measured,
// not theorised:
//
//   "players.*" matched "playersXread"  -- `.` acted as a wildcard, so a pattern
//                                          an operator wrote as literal text
//                                          silently granted more than it reads
//   "(a+)+$*"   took 15,173ms on a 29-char action -- catastrophic backtracking,
//                                          on Node's single thread, inside
//                                          evaluate(), which runs on EVERY
//                                          authenticated request
//   "[*"        threw SyntaxError out of evaluate() -- and validPolicyStore
//                                          accepted it, so it persisted to
//                                          iam-policies.json and bricked the
//                                          console on every boot thereafter
//
// Escaping removes all three at once: no operator-supplied quantifier, group or
// character class survives to be compiled, so the pattern language is exactly
// "literal text plus `*`" -- which is what the policy docs always said it was.
const REGEX_METACHARACTERS = /[.+?^${}()|[\]\\]/g;
const wildcardCache = new Map();
export function wildcardRegex(pattern) {
  let cached = wildcardCache.get(pattern);
  if (!cached) {
    const source = "^" + pattern.replace(REGEX_METACHARACTERS, "\\$&").replace(/\*/g, ".*") + "$";
    cached = new RegExp(source);
    wildcardCache.set(pattern, cached);
  }
  return cached;
}

// Patterns naming an action the catalog used to have. Unlike unknownActions
// these still mean something, but a save should name the successors explicitly.
export function deprecatedActions(docs) {
  const found = [];
  for (const [tier, document] of Object.entries(docs || {})) {
    for (const statement of document?.statements || []) {
      const patterns = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      for (const pattern of patterns) {
        if (typeof pattern !== "string") continue;
        if (REMOVED_ACTION_ALIASES[pattern]) found.push({ tier, pattern, successors: [...REMOVED_ACTION_ALIASES[pattern]] });
      }
    }
  }
  return found;
}

export function evaluate(session, action, policies = null) {
  // No action to check — public route
  if (!action) return true;

  const tier = resolveSessionTier(session);
  if (!tier) return false;

  const policy = getPolicy(tier, policies);
  if (!policy) return false;

  let allowed = false;

  for (const stmt of policy.statements || []) {
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

// `observer` was the pre-rename name of the (now stricter) `player` tier. It is
// aliased, never honoured as a tier of its own: a stale session, a signed handoff
// from an older bot, or a saved policy that still says "observer" must land on
// the strict tier, not on a broader one or on nothing.
export function normalizeTier(tier) {
  return tier === "observer" ? "player" : tier;
}

// Actions a saved `player` document grants that the player tier can never use,
// because playerTierGate caps the tier at players:read + guilds:read. Reported so an
// operator whose stored policy predates the strict tier is told why a grant does nothing.
export function playerCappedActions(docs) {
  const player = docs && docs.player;
  if (!player) return [];
  const capped = [];
  for (const action of allKnownActions()) {
    if (action === "players:read" || action === "guilds:read") continue;
    if (evaluate({ tier: "player" }, action, docs)) capped.push(action);
  }
  return capped;
}

export function resolveSessionTier(session) {
  if (!session) return "";
  const tier = typeof session.tier === "string" ? normalizeTier(session.tier) : "";
  const VALID_TIERS = new Set(["owner", "admin", "moderator", "player"]);
  return VALID_TIERS.has(tier) ? tier : "";
}

// A saved iam-policies.json written before the rename may carry an `observer`
// document. validPolicyStore rejects unknown tiers wholesale, which would drop
// the operator's owner/admin/moderator customisation back to defaults, so the
// legacy key is removed first and a missing `player` is filled from the
// defaults (the strict ones; an operator's explicit `player` document is kept).
function sanitizePolicyStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (!Object.hasOwn(value, "observer")) return value;
  const { observer: _legacy, ...rest } = value;
  return Object.hasOwn(rest, "player") ? rest : { ...rest, player: DEFAULT_POLICIES.player };
}

// ---- Policy store ----

let _policies = null;

export function loadPolicies(repoRoot = null) {
  const filePath = repoRoot
    ? resolve(repoRoot, "runtime/generated/iam-policies.json")
    : resolve(process.cwd(), "../..", "runtime/generated/iam-policies.json");

  _allowedActions = {};

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = sanitizePolicyStore(JSON.parse(raw));
      if (validPolicyStore(parsed)) {
        _policies = parsed;
        // Reported, not rejected: discarding the document would silently
        // revert the operator's whole policy to defaults, a bigger surprise
        // than the dead pattern. setPolicies refuses these on save, so a stored
        // file can only acquire one by hand-editing. The caller logs this.
        return { source: "file", path: filePath, unknownActions: unknownActions(parsed), deprecatedActions: deprecatedActions(parsed), playerCappedActions: playerCappedActions(parsed) };
      }
      _policies = DEFAULT_POLICIES;
      return { source: "defaults", path: filePath, invalid: true, unknownActions: [], deprecatedActions: [] };
    } catch {
      _policies = DEFAULT_POLICIES;
      return { source: "defaults", path: filePath, invalid: true, unknownActions: [], deprecatedActions: [] };
    }
  }

  // Hardcoded fallback defaults
  _policies = DEFAULT_POLICIES;
  return { source: "defaults", unknownActions: [], deprecatedActions: [] };
}

let _allowedActions = {};

// A parameterized route (e.g. DELETE /api/bases/{baseId}) has no exact
// ROUTE_ACTIONS entry -- actionForRoute resolves it through one of three
// other tiers instead (see actions.js). bases:delete is the reason this
// enumerates all four: it exists only in REGEX_ACTIONS_BY_METHOD_PATTERN, so
// a version of this that only read ROUTE_ACTIONS would never surface it.
//
// CONTENT_CONDITIONAL_ACTIONS is the fifth source and the only one no route
// resolves to: those actions are decided from the request body inside the
// handler, so nothing in the four route tables above mentions them.
export function allKnownActions() {
  const actions = new Set(Object.values(ROUTE_ACTIONS));
  for (const [, action] of REGEX_ACTIONS) actions.add(action);
  for (const action of Object.values(REGEX_ACTIONS_BY_METHOD)) actions.add(action);
  for (const { action } of REGEX_ACTIONS_BY_METHOD_PATTERN) actions.add(action);
  for (const action of CONTENT_CONDITIONAL_ACTIONS) actions.add(action);
  return actions;
}

export function resolveAllowedActions(tier) {
  if (!tier) return [];
  if (_allowedActions[tier]) return _allowedActions[tier];

  const allActions = allKnownActions();
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

export function getPolicy(tier, policies = null) {
  const store = policies || _policies || DEFAULT_POLICIES;
  return store[tier] || null;
}

export function getAllPolicies(policies = null) {
  const store = policies || _policies || DEFAULT_POLICIES;
  return { ...store };
}

// Every Action pattern that matches NO action in the catalog, as
// [{ tier, pattern }]. Dead weight in an Allow; a silent lie in a Deny.
// "Deny players:reset-progression" is the shape -- no route resolves to it
// (players:reset does), so it withholds nothing while the policy reads as safe.
//
// Removed names are NOT reported here: matchAction still honours them, so they
// are not dead. deprecatedActions() reports those, since the fix is migration
// rather than a typo.
//
// The test is "does this pattern match at least one real action", not "is this
// string in the catalog", so wildcards stay legal -- and it runs through the
// same matchAction the engine uses, so validation and runtime cannot disagree.
export function unknownActions(docs) {
  const known = [...allKnownActions()];
  const dead = [];
  for (const [tier, document] of Object.entries(docs || {})) {
    for (const statement of document?.statements || []) {
      const patterns = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      for (const pattern of patterns) {
        if (typeof pattern !== "string") continue;
        if (!known.some((action) => matchAction(pattern, action))) dead.push({ tier, pattern });
      }
    }
  }
  return dead;
}

export function setPolicies(inputDocs, repoRoot = null) {
  const docs = sanitizePolicyStore(inputDocs);
  if (!validPolicyStore(docs)) {
    return { ok: false, error: "Policies must contain valid tier documents and Allow/Deny statements." };
  }
  if (!evaluate({ tier: "owner" }, "settings:write", docs)) {
    return { ok: false, error: "The owner policy must retain settings:write access." };
  }
  // Both checks REFUSE rather than warn. A save that "succeeded with warnings"
  // is how an operator ends up believing a restriction is in force when it is
  // not.
  //
  // Deprecated names are refused on save even though matchAction still honours
  // them at evaluation time. That asymmetry is deliberate: a stored document
  // keeps its meaning through an upgrade, and the operator migrates on their
  // next edit instead of the console refusing to start. The message names the
  // successors so the edit is mechanical.
  const deprecated = deprecatedActions(docs);
  if (deprecated.length) {
    const listed = deprecated
      .map(({ tier, pattern, successors }) => `${tier}: ${pattern} (now ${successors.join(", ")})`)
      .join("; ");
    return {
      ok: false,
      error: `These actions were split and no longer exist. Name the actions you actually want instead: ${listed}.`,
      deprecatedActions: deprecated
    };
  }

  const dead = unknownActions(docs);
  if (dead.length) {
    const listed = dead.map(({ tier, pattern }) => `${tier}: ${pattern}`).join(", ");
    return {
      ok: false,
      error: `These actions do not exist and would have no effect: ${listed}. Check GET /api/settings/iam/policies for the full list of valid actions.`,
      unknownActions: dead
    };
  }
  _policies = docs;
  _allowedActions = {};
  if (repoRoot) writeJsonAtomic(resolve(repoRoot, "runtime/generated/iam-policies.json"), docs, 0o600);
  // A grant beyond players:read/guilds:read on `player` is accepted but inert (playerTierGate
  // caps it); say so, as loadPolicies does at startup, so the save does not look effective.
  return { ok: true, policies: getAllPolicies(), playerCappedActions: playerCappedActions(docs) };
}

function validPolicyStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tiers = Object.keys(value);
  if (!tiers.length || tiers.some((tier) => !["owner", "admin", "moderator", "player"].includes(tier))) return false;
  return tiers.every((tier) => {
    const document = value[tier];
    if (!document || document.tier !== tier || !Array.isArray(document.statements)) return false;
    return document.statements.every((statement) => {
      if (!statement || !["Allow", "Deny"].includes(statement.Effect)) return false;
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.length > 0 && actions.every((action) => {
        if (typeof action !== "string" || action.trim().length === 0) return false;
        // Belt and braces alongside the escaping above (#242): refuse anything
        // that cannot compile, so a malformed store is rejected at PUT rather
        // than persisted and re-loaded into every subsequent boot.
        try { wildcardRegex(action); return true; } catch { return false; }
      });
    });
  });
}

// ---- Default policies (mirror the CAPABILITY_BY_TIER ladder) ----

// Exported so a test can assert what the tier ladder SHIPS, independently of
// whatever a previous test left in the mutable store -- setPolicies(null) is
// rejected rather than a reset, so an assertion that relies on it is vacuous.
export const DEFAULT_POLICIES = {
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
        "realtime:*",
      ]},
      { Effect: "Deny", Action: [
        "settings:*",
        "database:write-config",
        "database:mutate",
        // Destructive/irreversible actions kept at owner (#218/#219/#220, from
        // the 2026-08-08 Layer 1 security audit). Its finding: assigning these
        // to `admin` "concentrates too much destructive power at the most
        // broadly-assigned write role."
        //
        // The audit was written against Discord slash commands that were never
        // built, but the same actions are live console routes and `admin`
        // reached all of them via the wildcards above -- verified with
        // evaluate() before this change, not assumed from the issue text.
        "server:restart",          // disconnects every player on the server
        "carepackage:clear-history",  // destroys care-package audit evidence
        "admin:history:clear",     // destroys admin-command audit evidence
        "carepackage:grant-all",   // server-wide economy injection in one call
        // The write half of POST /api/database/query, without which the two
        // denials above are decorative: database:query is granted just above
        // and that route takes UPDATE/DELETE/DROP as readily as SELECT.
        //
        // Redundant today -- the Allow list names database:read/query/export
        // individually, so default-deny already refuses this. It is here for
        // the plausible tidy-up that widens the Allow to database:*, which
        // would otherwise hand the write half back. Pinned by "the deny
        // survives a widened allow list" in databaseQueryAuthz.test.js.
        "database:execute",
        // A system backup is not a bigger database backup. The archive holds
        // runtime/secrets (the console's own admin password, the session
        // secret, api-keys.json) and runtime/generated/iam-policies.json, and
        // a restore overwrites both wholesale. Without these three, "backups:*"
        // above quietly hands admin every credential owner has:
        //   download-system  -- create with a passphrase you chose, download,
        //                       decrypt at leisure.
        //   import-system    -- upload an archive with a rewritten
        //   restore-system      iam-policies.json, then apply it.
        // That defeats the settings:* and database:* denials in this very
        // list, so it has to be denied here rather than left to the wildcard.
        //
        // create-system and delete-system stay with admin: taking and pruning
        // archives is ordinary custodial work, and neither reads an archive
        // back nor writes one into the host.
        "backups:download-system",
        "backups:import-system",
        "backups:restore-system",
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
  // Strict, own-record-scoped read tier (replaces the former `observer`, which
  // held the same server-wide read grants). Everything a player may read is
  // narrowed to their own characters/items and guild by playerTierGate.js and
  // listPlayers/listGuilds scoping; only actions that have such scoping are
  // granted. Further reads (bases, storage, vehicles, ...) stay off until each
  // has its own ownership scoping.
  player: {
    version: 1,
    tier: "player",
    statements: [
      { Effect: "Allow", Action: [
        "players:read",
        "guilds:read",
      ]},
    ]
  },
};
