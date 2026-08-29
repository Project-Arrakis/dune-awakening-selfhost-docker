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
    // Only `*` is special. Every other character is matched literally -- a
    // pattern like "players:(*" must never reach RegExp unescaped, where it
    // throws SyntaxError on every evaluate() for that tier (a persisted policy
    // would turn every request by that tier into a 500 until hand-edited).
    // validPolicyStore() refuses such patterns at save time; this is the
    // second line of defence for a hand-edited iam-policies.json.
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const regex = new RegExp("^" + escaped + "$");
    return regex.test(action);
  }
  return false;
}

// The IAM action vocabulary: lowercase letters, digits, ':' namespace
// separators, '-' inside a segment, and '*' as the only wildcard. Anything
// else is refused at save time -- see matchAction() for why.
export const ACTION_PATTERN = /^[a-z0-9:*-]+$/;

// First action pattern in the store that is not a valid IAM action pattern,
// or null. Reported by name so the operator is told which string to fix
// instead of a generic "invalid policies".
export function invalidActionPattern(value) {
  if (!value || typeof value !== "object") return null;
  for (const document of Object.values(value)) {
    for (const statement of document?.statements || []) {
      const actions = Array.isArray(statement?.Action) ? statement.Action : [statement?.Action];
      for (const action of actions) {
        if (typeof action === "string" && action.trim().length > 0 && !ACTION_PATTERN.test(action)) return action;
      }
    }
  }
  return null;
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
      // A stored file that fails validation (e.g. an action pattern that
      // predates the ACTION_PATTERN tightening) used to fall through to the
      // defaults with no trace of it happening -- an operator's hand-authored
      // policy could be silently discarded on upgrade, replaced by whatever
      // this version's defaults are, and nothing would say so (review
      // finding). Fail loud, not silent.
      console.warn(
        `Stored IAM policy at ${filePath} failed validation and was NOT loaded -- ` +
        "falling back to the default policies. This usually means an action pattern " +
        "in the file predates a schema change (only lowercase letters, digits, ':', " +
        "'-' and '*' are valid). Check Access Control after this restart."
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unreadable or malformed";
      console.warn(
        `Stored IAM policy at ${filePath} could not be read (${reason}) -- ` +
        "falling back to the default policies. Check Access Control after this restart."
      );
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
export function allKnownActions() {
  const actions = new Set(Object.values(ROUTE_ACTIONS));
  for (const [, action] of REGEX_ACTIONS) actions.add(action);
  for (const action of Object.values(REGEX_ACTIONS_BY_METHOD)) actions.add(action);
  for (const { action } of REGEX_ACTIONS_BY_METHOD_PATTERN) actions.add(action);
  return actions;
}

// The HTTP methods that reach a given action, from the three tables that
// record a method at all -- REGEX_ACTIONS is genuinely method-agnostic by
// construction (a [prefix, action] pair with no method field), so it never
// contributes here. Memoized per-action since actions.js's tables are static
// for the lifetime of the process.
let _actionMethods = null;
function actionMethods(action) {
  if (!_actionMethods) {
    _actionMethods = new Map();
    const add = (key, act) => {
      const method = key.split(" ")[0];
      if (!_actionMethods.has(act)) _actionMethods.set(act, new Set());
      _actionMethods.get(act).add(method);
    };
    for (const [key, act] of Object.entries(ROUTE_ACTIONS)) add(key, act);
    for (const [key, act] of Object.entries(REGEX_ACTIONS_BY_METHOD)) add(key, act);
    for (const { method, action: act } of REGEX_ACTIONS_BY_METHOD_PATTERN) {
      if (!_actionMethods.has(act)) _actionMethods.set(act, new Set());
      _actionMethods.get(act).add(method);
    }
  }
  return _actionMethods.get(action) || new Set();
}

// #634 (AWS-IAM-Visual-Editor-style Access Control UI). Classification lives
// entirely server-side and is sent to the client pre-computed -- the client
// never re-derives it, avoiding a second, competing implementation that could
// drift (Eight Hats QA finding on the original design). "Permissions
// management" = a crown-jewel action (matched via matchAction, not literal
// membership -- see the CRITICAL fix in setPolicies() this mirrors) or the
// settings/setup namespace. "Write" = reachable by a mutating HTTP method.
// "Read" = everything else, including a method-agnostic REGEX_ACTIONS action
// (no method recorded at all), which falls back to its own naming convention.
const WRITE_NAME_SUFFIXES = ["-write", ":write", "-mutate", "-delete", "-ban", "-kick", "-teleport", "-restart", "-spawn", "-despawn"];
export function accessLevelForAction(action) {
  const ns = action.includes(":") ? action.split(":")[0] : action;
  if (ns === "settings" || ns === "setup") return "permissions";
  if (CROWN_JEWEL_DENY_ACTIONS.some((pattern) => matchAction(pattern, action))) return "permissions";
  const methods = actionMethods(action);
  const mutatingMethods = ["POST", "PUT", "PATCH", "DELETE"];
  if (mutatingMethods.some((m) => methods.has(m))) return "write";
  if (methods.size === 0 && WRITE_NAME_SUFFIXES.some((suffix) => action.endsWith(suffix))) return "write";
  return "read";
}

// The real, concrete actions covered by CROWN_JEWEL_DENY_ACTIONS's patterns
// (one of which, "settings:*", is a wildcard -- expanding it here means every
// caller works with concrete actions only, never a pattern that needs its own
// matching logic). Shared by setPolicies()'s save-time guard and the #634
// catalog endpoint (so the client's "select all" can exclude these for a
// non-owner tier without needing its own copy of the pattern list or
// matchAction). Distinct from accessLevelForAction()'s "permissions" bucket,
// which also covers non-crown-jewel actions like setup:read for UI-grouping
// purposes only -- conflating the two would wrongly treat a legitimately
// grantable action as owner-only.
let _crownJewelActions = null;
export function crownJewelActions() {
  if (!_crownJewelActions) {
    _crownJewelActions = [...allKnownActions()].filter((action) =>
      CROWN_JEWEL_DENY_ACTIONS.some((pattern) => matchAction(pattern, action))
    );
  }
  return _crownJewelActions;
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
  const badPattern = invalidActionPattern(docs);
  if (badPattern !== null) {
    return { ok: false, error: `Action pattern "${badPattern}" is not valid: use lowercase letters, digits, ':' and '-', with '*' as the only wildcard.` };
  }
  if (!validPolicyStore(docs)) {
    return { ok: false, error: "Policies must contain valid tier documents and Allow/Deny statements." };
  }
  // settings:read gates GET /api/settings and GET /api/settings/iam/policies --
  // an owner document that kept settings:write but lost settings:read would
  // pass the check above yet be unable to load the IAM editor or Settings
  // panel at all to fix its own mistake (found by review).
  if (!evaluate({ tier: "owner" }, "settings:write", docs) || !evaluate({ tier: "owner" }, "settings:read", docs)) {
    return { ok: false, error: "The owner policy must retain settings:read and settings:write access." };
  }
  // Crown-jewel actions (settings:*, database mutation/export, updates:apply,
  // backups:restore/import, addons:install/update, players:mutate, the
  // economy actions, etc. -- see CROWN_JEWEL_DENY_ACTIONS) must never resolve
  // to allowed for any tier but owner, no matter how the JSON got there --
  // an Allow that reaches one, a removed Deny, or both at once. Only owner
  // can save policies at all (settings:write is itself a crown jewel), so
  // this is specifically a backstop against an owner *accidentally* granting
  // one to a lower tier while hand-editing the JSON tab.
  //
  // CROWN_JEWEL_DENY_ACTIONS entries are PATTERNS (one of them, "settings:*",
  // is a wildcard), not necessarily real, concrete actions -- evaluate()
  // expects a concrete action to test against a tier's own patterns, so
  // calling evaluate({tier}, "settings:*", docs) directly checks whether the
  // tier's OWN statements contain a pattern matching the literal string
  // "settings:*" (they never do), not whether the tier can reach any real
  // settings:* action. That silently let a tier through if it was granted a
  // specific concrete action under a wildcard crown-jewel entry (e.g. a bare
  // "settings:write" Allow, with no wildcard anywhere in sight) -- found by
  // Eight Hats Layer 1 review of #634's design doc, empirically confirmed.
  // Fix: expand every crown-jewel PATTERN against the real action catalog
  // first, then evaluate() each matched CONCRETE action -- mirroring the
  // same expand-then-evaluate shape resolveAllowedActions() already uses.
  for (const tier of ["admin", "moderator", "player", "observer"]) {
    if (!docs[tier]) continue;
    const leaked = crownJewelActions().find((action) => evaluate({ tier }, action, docs));
    if (leaked) {
      return { ok: false, error: `The ${tier} policy would grant "${leaked}", a crown-jewel action reserved for owner. Add an explicit Deny for it, or remove the Allow that reaches it.` };
    }
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
      return actions.length > 0 && actions.every((action) => typeof action === "string" && ACTION_PATTERN.test(action));
    });
  });
}

// ---- Default policies (mirror the CAPABILITY_BY_TIER ladder) ----

// "Crown jewel" actions that must stay unreachable by every tier below Owner,
// even if that tier's own Allow list is edited/widened later via the Access
// Control UI. Originally only Admin carried this Deny block (Admin's own Allow
// list is broad enough that a future widening edit is plausible); Moderator/
// Player/Observer's Allow lists don't touch any of these today either, but
// nothing stops an operator from widening THEIR Allow list too -- and unlike
// Admin, they had no backstop if that happened. Every non-owner tier now
// carries the identical Deny, purely as defense-in-depth: a no-op today
// against each tier's current Allow list, protective if one is ever widened.
export const CROWN_JEWEL_DENY_ACTIONS = [
  "settings:*",                                     // IAM policies, admin password, port, recovery codes
  "server:write-credentials",                       // Funcom game-server token + server IP change
  "database:write-config", "database:mutate",       // DB password + direct table edits
  "database:export",                                // full DB dump = whole-database exfiltration
  "admin:transfer-settings:write",                  // character/server-transfer policy (identity + economy)
  "updates:apply", "updates:fix", "updates:repair", // deploying / altering the running code
  "backups:restore", "backups:import",              // irreversible DB overwrite / untrusted import
  "addons:install", "addons:update",                // third-party code into the console process
  "setup:write",                                    // first-run provisioning
  "players:mutate",                                 // give-item / add-currency / reset-progression (economy)
  "carepackage:grant", "carepackage:write-config",  // minting in-game value
  "exchange:market", "exchange:market-write",       // seeding the market economy
];

const DEFAULT_POLICIES = {
  owner: {
    version: 1,
    tier: "owner",
    statements: [
      { Effect: "Allow", Action: "*" }
    ]
  },

  // ADMIN -- "operate the live server and moderate players; change nothing
  // persistent." Deliberately over-restrictive: admin holds an EXPLICIT allow
  // list, so any capability added to the catalog later defaults to owner-only
  // until an operator grants it; and a Deny block keeps the crown-jewel actions
  // unreachable even if a future edit widens the allow list. Everything an admin
  // lacks -- all *:write-config, credentials, update/addon deployment,
  // destructive backup/data ops, and the economy -- is owner-only by design.
  // Loosen per-deployment via the Access Control editor (tracked for revision).
  admin: {
    version: 1,
    tier: "admin",
    statements: [
      { Effect: "Allow", Action: [
        // Server lifecycle -- transient operations, no persistent config write
        "server:read", "server:start", "server:stop", "server:restart",
        "server:restart-service", "server:network-fix", "server:storage-cleanup",
        // Player moderation -- act on an individual griefer + mass kick
        "players:read", "players:kick-all", "players:kick", "players:ban", "players:teleport",
        // Live-ops -- bring a map shard up/down + in-world moderation movement
        "maps:read", "maps:spawn", "maps:despawn", "maps:teleport", "maps:restart", "maps:reconcile",
        // Communications / moderation tooling
        "admin:broadcast", "admin:broadcast-shutdown", "admin:map-chat",
        "admin:motd:read", "admin:motd:write",
        "admin:announcements:read", "admin:announcements:write",
        "admin:history:read", "admin:history:clear",
        "admin:transfer-settings:read", "admin:items:read",
        "admin:vehicles:read", "admin:skills:read",
        // Read-only visibility across the console
        "logs:read",
        "bases:read", "blueprints:read", "carepackage:read", "deepdesert:read", "exchange:read",
        "guilds:read", "landsraad:read", "sietches:read", "storage:read", "vehicles:read",
        "database:read", "database:query",   // query is read-only-enforced in the handler
        "updates:check", "updates:read", "updates:self-check",
        "backups:create", "backups:read",
        "setup:read",
        "addons:read",
      ]},
      { Effect: "Deny", Action: CROWN_JEWEL_DENY_ACTIONS }
    ]
  },

  // MODERATOR -- live moderation only: read everything, talk to players, and act
  // on individual griefers (kick/ban/teleport). No config, no economy, nothing
  // destructive or persistent.
  moderator: {
    version: 1,
    tier: "moderator",
    statements: [
      { Effect: "Allow", Action: [
        "server:read", "maps:read", "sietches:read", "deepdesert:read",
        "players:read", "players:kick-all", "players:kick", "players:ban", "players:teleport",
        "guilds:read", "bases:read", "storage:read", "blueprints:read",
        "vehicles:read", "exchange:read", "logs:read", "landsraad:read",
        "admin:broadcast", "admin:map-chat",
      ]},
      { Effect: "Deny", Action: CROWN_JEWEL_DENY_ACTIONS }
    ]
  },

  // PLAYER -- a tight read-only self-service view. Only Home (server health),
  // Players, Guilds, and the Live Map. Deliberately does NOT include the broad
  // game-world reads (bases/storage/blueprints/vehicles/exchange/landsraad/
  // sietches/deepdesert) an operator does not want ordinary players browsing.
  // NOTE: these grants are still tier-wide (players:read = all players); scoping
  // a player to *their own* player/guild is ownership-based access tracked
  // separately (follow-up), as is hiding the tabs a player cannot use.
  player: {
    version: 1,
    tier: "player",
    statements: [
      { Effect: "Allow", Action: [
        "server:read",   // Home: performance / readiness / health
        "players:read",  // Players (own-only scoping is a follow-up)
        "guilds:read",   // Guilds (own-only scoping is a follow-up)
        "maps:read",     // Live Map
      ]},
      { Effect: "Deny", Action: CROWN_JEWEL_DENY_ACTIONS }
    ]
  },

  // OBSERVER -- minimal server-status viewer ("is the server up?"). Deliberately
  // the tightest tier; a richer read-only ops/audit definition (logs + backup +
  // update health) is tracked as a follow-up revision.
  observer: {
    version: 1,
    tier: "observer",
    statements: [
      { Effect: "Allow", Action: [
        "server:read",
      ]},
      { Effect: "Deny", Action: CROWN_JEWEL_DENY_ACTIONS }
    ]
  },
};
