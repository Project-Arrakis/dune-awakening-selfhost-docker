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
//       { "Effect": "Deny",  "Action": ["players:reset-progression"] },
//       { "Effect": "Allow", "Action": ["players:*", "server:read"] }
//     ]}
//
// Evaluation: for each statement in order,
//   if action matches statement AND Effect=Deny  → DENY immediately
//   if action matches statement AND Effect=Allow → mark ALLOWED
//   if no statement matched                        → DENY (default)

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROUTE_ACTIONS, REGEX_ACTIONS, REGEX_ACTIONS_BY_METHOD, REGEX_ACTIONS_BY_METHOD_PATTERN } from "./actions.js";
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

export function resolveSessionTier(session) {
  if (!session) return "";
  const tier = typeof session.tier === "string" ? session.tier : "";
  const VALID_TIERS = new Set(["owner", "admin", "moderator", "player", "observer"]);
  return VALID_TIERS.has(tier) ? tier : "";
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
      if (validPolicyStore(parsed)) {
        _policies = parsed;
        return;
      }
    } catch {
      // Fall through to defaults
    }
  }

  // Hardcoded fallback defaults
  _policies = DEFAULT_POLICIES;
}

let _allowedActions = {};

// A parameterized route (e.g. DELETE /api/bases/{baseId}) has no exact
// ROUTE_ACTIONS entry -- actionForRoute resolves it through one of three
// other tiers instead (see actions.js). bases:delete is the reason this
// enumerates all four: it exists only in REGEX_ACTIONS_BY_METHOD_PATTERN, so
// a version of this that only read ROUTE_ACTIONS would never surface it.
function allKnownActions() {
  const actions = new Set(Object.values(ROUTE_ACTIONS));
  for (const [, action] of REGEX_ACTIONS) actions.add(action);
  for (const action of Object.values(REGEX_ACTIONS_BY_METHOD)) actions.add(action);
  for (const { action } of REGEX_ACTIONS_BY_METHOD_PATTERN) actions.add(action);
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

export function setPolicies(docs, repoRoot = null) {
  if (!validPolicyStore(docs)) {
    return { ok: false, error: "Policies must contain valid tier documents and Allow/Deny statements." };
  }
  if (!evaluate({ tier: "owner" }, "settings:write", docs)) {
    return { ok: false, error: "The owner policy must retain settings:write access." };
  }
  _policies = docs;
  _allowedActions = {};
  if (repoRoot) writeJsonAtomic(resolve(repoRoot, "runtime/generated/iam-policies.json"), docs, 0o600);
  return { ok: true, policies: getAllPolicies() };
}

function validPolicyStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tiers = Object.keys(value);
  if (!tiers.length || tiers.some((tier) => !["owner", "admin", "moderator", "player", "observer"].includes(tier))) return false;
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
