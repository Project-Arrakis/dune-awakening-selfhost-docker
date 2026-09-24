// Route/action mapping table for the Discord write bridge (docs/rw-architecture.md
// section 3.5). Each entry maps a dot-namespaced write action to the real Core
// mutation route it must invoke via the internal loopback -- write/execute never
// reimplements mutation logic, it only dispatches to these already-real handlers.
import { actionForRoute } from "../../actions.js";
import { grantCarePackage, grantEligibleCarePackages } from "../../carePackage.js";
import { WRITE_ACTION_MIN_TIER } from "./writeActionMinTier.js";

// Player/base identifiers seen in this codebase (server.js's own Funcom-style
// funcomId/hexFlsId examples: "Server#4242", "5E121CE000000001") are alphanumeric
// plus "#" only -- deliberately excludes "." and "/" so a value of exactly ".."
// can never shift which real route is requested after URL normalization
// (docs/rw-architecture.md 3.5, round-2 Security finding #740). encodeURIComponent
// alone is not sufficient shape validation: it escapes "/" but not ".".
//
// [Layer 3 integration audit fix, LOW, issue #1051] Widened to also allow
// "_" and ":" (real Steam-style/Funcom id characters this pattern was
// otherwise silently rejecting -- the identical action would be accepted via
// the admin CLI path in runner.js but rejected here) -- but this pattern
// deliberately does NOT adopt runner.js's own validatePlayerId as-is
// (`/^[A-Za-z0-9_:#.-]{1,128}$/`, which also allows "." and a bare "*"
// wildcard): runner.js's validated value becomes a CLI argument passed to a
// subprocess, where "." has no special meaning at all, while this
// function's value becomes a URL PATH SEGMENT via encodeURIComponent()
// above -- exactly the context #740's own "." exclusion protects. Blindly
// matching runner.js's pattern here would silently reintroduce that
// CRITICAL finding. "-" is safe to add in either context (never
// traversal-meaningful on its own).
const PLAYER_ID_PATTERN = /^[A-Za-z0-9#_:-]{1,128}$/;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]*$/;
const GUILD_ID_PATTERN = /^[A-Za-z0-9]{1,128}$/;

export function validatePlayerId(value) {
  if (typeof value !== "string" || !PLAYER_ID_PATTERN.test(value)) {
    throw new Error(`Invalid playerId shape: ${JSON.stringify(value)}`);
  }
  return value;
}

export function validateBaseId(value) {
  if (typeof value !== "string" || !NUMERIC_ID_PATTERN.test(value)) {
    throw new Error(`Invalid baseId shape: ${JSON.stringify(value)}`);
  }
  return value;
}

export function validateGuildId(value) {
  if (typeof value !== "string" || !GUILD_ID_PATTERN.test(value)) {
    throw new Error(`Invalid guildId shape: ${JSON.stringify(value)}`);
  }
  return value;
}

// confirmPhrase is a UX safeguard, not an independent security boundary
// (docs/rw-architecture.md 3.5, round-3 Security finding, batch #747): these
// values are static constants auto-injected into the loopback body for any
// request that already has a valid nonce, actor signature, and passed
// capability/tier checks -- never compared against anything the Discord user
// actually typed. The real security boundary is the nonce + actor-signature +
// capability + tier + rate-limit stack, identical regardless of confirmation
// style.
//
// auditAction: null for 4 entries is deliberate, not an oversight -- these
// handlers emit one of several literals depending on runtime state
// (server.restart/server.restart-service/map.respawn's restart-queue
// interception; map.teleport's body.online branch; player.give-item's
// item-grant-vs-task fork) that cannot be reduced to one fixed string without
// fabricating a value Layer 2's mechanical consistency check would then
// incorrectly treat as authoritative.
//
// auditAction is documentation, not a second audit call site (Layer 2 audit,
// Architect MEDIUM finding, issue #1020): Hop B dispatches to the real,
// unmodified target route handler, which already calls the codebase's real
// audit() with the real event name and real request-derived attribution --
// duplicating that here would double-write the audit log, not fix a gap.
// This field exists so a reader of this table alone can see what audit event
// a given write action produces, without having to trace into server.js.
//
// requiresDualConfirmation (issue #1019): originally true for server.stop --
// this workstream's single most destructive write-bridge action (stops the
// live game server outright). write/execute's own state machine (see
// routes.js) requires two DISTINCT actors to each independently pass every
// other gate (tier, capability, fresh actor signature) before Hop B is ever
// reached -- entirely a write-bridge-internal control, layered on top of, not
// a replacement for, the real target route's own behavior. Deliberately a
// per-action boolean on this table (matching every other per-action
// mechanism here) rather than a hardcoded action-name check inside
// writeExecuteRoute, so a future action needing the same control is a
// one-line table change, not new branching logic.
//
// NO LONGER THE CURRENT STATE -- server.stop deliberately no longer sets this
// field (operator decision): the companion Discord bot's own RBAC model makes
// owner tier exactly one account per guild, so a "second, genuinely different
// owner-tier admin" cannot exist in practice, making the gate impossible to
// satisfy rather than merely strict. No production action currently sets this
// field, so `resolveWriteActionRoute` resolves it to `false` everywhere by
// the absent-field default below. The MECHANISM itself is untouched, real,
// and still fully exercised end-to-end over real HTTP -- via the test-only
// override further down this file, which forces the flag on for an already-
// real action for the duration of one test. Turning it back on for any
// action, now or in the future, remains the same one-line table change it was
// designed to be.
const RAW_WRITE_ACTION_ROUTES = {
  "player.kick": { method: "POST", path: (p) => `/api/players/${encodeURIComponent(validatePlayerId(p.playerId))}/kick`, policyAction: "players:moderate", auditAction: "task.adminKick" },
  "player.ban": { method: "POST", path: (p) => `/api/players/${encodeURIComponent(validatePlayerId(p.playerId))}/ban`, confirmPhrase: "BAN PLAYER", policyAction: "players:moderate", auditAction: "players.ban" },
  "player.unban": { method: "DELETE", path: (p) => `/api/players/${encodeURIComponent(validatePlayerId(p.playerId))}/ban`, policyAction: "players:moderate", auditAction: "players.unban" },
  "player.warn": { method: "POST", path: () => "/api/admin/map-chat", policyAction: "admin:map-chat", auditAction: "admin.map-chat" },
  "player.give-item": { method: "POST", path: (p) => `/api/players/${encodeURIComponent(validatePlayerId(p.playerId))}/give-item`, policyAction: "players:give-item", auditAction: null },
  "player.clear-backpack": { method: "POST", path: (p) => `/api/players/${encodeURIComponent(validatePlayerId(p.playerId))}/clean-inventory`, confirmPhrase: "CLEAN INVENTORY", policyAction: "players:reset", auditAction: "task.adminCleanInventory" },
  "player.fill-water": { method: "POST", path: (p) => `/api/players/${encodeURIComponent(validatePlayerId(p.playerId))}/refill-water`, policyAction: "players:repair", auditAction: "task.adminRefillWater" },
  "base.refill-generators": { method: "POST", path: (p) => `/api/bases/${encodeURIComponent(validateBaseId(p.baseId))}/refill-generators`, policyAction: "bases:mutate", auditAction: "bases.refill-generators" },
  "base.refill-water": { method: "POST", path: (p) => `/api/bases/${encodeURIComponent(validateBaseId(p.baseId))}/refill-water`, policyAction: "bases:mutate", auditAction: "bases.refill-water" },
  "server.restart": { method: "POST", path: () => "/api/server/restart", policyAction: "server:restart", auditAction: null },
  // confirmPhrase added (issue #1048): server.stop is this workstream's
  // single most destructive write-bridge action -- stopping the live game
  // server outright -- and previously had NO confirmPhrase at all, unlike
  // every other comparably risky action (player.ban, map.spawn,
  // carepackage.*). This is the same UX-safeguard-not-independent-security-
  // boundary pattern documented above -- the real target handler (server.js's
  // task()) does not itself check this phrase; write/execute's own dispatch
  // relies on the bot's preview/confirm UX reading this field from
  // write/preview's response before it ever calls write/execute.
  "server.stop": { method: "POST", path: () => "/api/server/stop", confirmPhrase: "STOP SERVER", policyAction: "server:stop", auditAction: "task.stop" },
  "server.start": { method: "POST", path: () => "/api/server/start", policyAction: "server:start", auditAction: "task.start" },
  "server.restart-service": { method: "POST", path: () => "/api/server/restart-service", policyAction: "server:restart-service", auditAction: null },
  "map.spawn": { method: "POST", path: () => "/api/maps/spawn", confirmPhrase: "SPAWN MAP", policyAction: "maps:spawn", auditAction: "task.mapsSpawn" },
  "map.despawn": { method: "POST", path: () => "/api/maps/despawn", confirmPhrase: "DESPAWN MAP", policyAction: "maps:despawn", auditAction: "task.mapsDespawn" },
  "map.respawn": { method: "POST", path: () => "/api/maps/respawn", confirmPhrase: "RESTART MAP", policyAction: "maps:restart", auditAction: null },
  "map.teleport": { method: "POST", path: () => "/api/map/teleport-player", policyAction: "maps:teleport", auditAction: null },
  "carepackage.grant": { method: "POST", path: (p) => `/api/care-package/grant/${encodeURIComponent(validatePlayerId(p.playerId))}`, confirmPhrase: "GRANT CARE PACKAGE", policyAction: "carepackage:grant", auditAction: "care-package.grant" },
  // policyAction is "carepackage:grant" here, not "carepackage:grant-all":
  // fork's own actions.js has a narrower, dedicated policy action for this
  // exact route (issue #219 -- per-player grants stay at carepackage:grant,
  // this one hits every eligible player at once, so it's kept separate and
  // more restricted at the Core policy layer). Upstream's actions.js does
  // not yet have that split; this table's own meetsMinTier() check below
  // (owner tier) still independently enforces the stricter gate this action
  // needs regardless of what Core's own policyAction resolves to -- the
  // selfCheckWriteActionRoutes() boot check just needs this field to match
  // whatever Core's actual, current routing table says for this exact
  // (method, path), which is "carepackage:grant" upstream today.
  "carepackage.grant-all": { method: "POST", path: () => "/api/care-package/grant-eligible", confirmPhrase: "GRANT CARE PACKAGE TO ELIGIBLE PLAYERS", policyAction: "carepackage:grant", auditAction: "care-package.grant-eligible" },
  "carepackage.enable": { method: "POST", path: () => "/api/care-package/enable", confirmPhrase: "ENABLE CARE PACKAGE", policyAction: "carepackage:write-config", auditAction: "care-package.enable" },
  "carepackage.disable": { method: "POST", path: () => "/api/care-package/disable", confirmPhrase: "DISABLE CARE PACKAGE", policyAction: "carepackage:write-config", auditAction: "care-package.disable" },
  "carepackage.scan": { method: "POST", path: () => "/api/care-package/run", confirmPhrase: "RUN CARE PACKAGE SCAN", policyAction: "carepackage:scan", auditAction: "care-package.run" },
  "carepackage.history-clear": { method: "POST", path: () => "/api/care-package/history/clear", confirmPhrase: "CLEAR GRANT HISTORY", policyAction: "carepackage:clear-history", auditAction: "care-package.history-clear" },
  "guild.add": { method: "POST", path: (p) => `/api/guilds/${encodeURIComponent(validateGuildId(p.guildId))}/members`, policyAction: "guilds:membership", auditAction: "guilds.add-member" },
  "guild.remove": { method: "DELETE", path: (p) => `/api/guilds/${encodeURIComponent(validateGuildId(p.guildId))}/members/${encodeURIComponent(validatePlayerId(p.playerId))}`, policyAction: "guilds:membership", auditAction: "guilds.remove-member" },
  "backup.create": { method: "POST", path: () => "/api/backups/create", policyAction: "backups:create", auditAction: "task.backupCreate" },
  "updates.apply-game": { method: "POST", path: () => "/api/updates/apply-game", policyAction: "updates:apply", auditAction: "task.updateApply" },
  "updates.fix-steamcmd": { method: "POST", path: () => "/api/updates/fix-steamcmd", policyAction: "updates:fix", auditAction: "task.updateFixSteamcmd" }
};

// Object.freeze() is shallow -- freezing only the outer table would still let
// a caller mutate one entry's own fields (e.g. WRITE_ACTION_ROUTES["player.kick"].method
// = "GET"). Every entry is frozen individually before the outer table itself
// is frozen, so the whole structure is genuinely immutable at every level.
export const WRITE_ACTION_ROUTES = Object.freeze(
  Object.fromEntries(Object.entries(RAW_WRITE_ACTION_ROUTES).map(([action, entry]) => [action, Object.freeze(entry)]))
);

// broadcast.* is intentionally absent -- see Group F's note in the design doc;
// it never goes through this table or the internal loopback.

// Test-only escape hatch, following the exact pattern
// writeBridgeState.js's resetWriteNonceStoreForTests() already establishes in
// this module family: a narrowly-scoped, explicitly-named-for-tests export
// that temporarily mutates module state and MUST be reset between tests (see
// writeBridge.integration.test.js's beforeEach/afterEach).
//
// Why it exists: no production action sets requiresDualConfirmation any more
// (see the note above server.stop's entry), but the dual-confirmation state
// machine in routes.js is real, reusable, already-audited infrastructure that
// must stay genuinely tested end-to-end over real HTTP -- not silently
// downgraded to unit-test-only coverage just because nothing currently opts
// in. This lets a test force the flag on for ONE already-real action
// (server.restart in the current tests) so the whole multi-actor flow runs
// through the real route handler, real nonce store, real tier/capability
// gates, and real Hop-B dispatch boundary.
//
// Deliberately narrow: it overrides exactly one boolean field on an action
// that must already exist in WRITE_ACTION_ROUTES (unknown names throw rather
// than inventing a fake action), so every other consumer -- path resolution,
// policyAction, min-tier, audit, matchesWriteActionTarget -- still sees a
// completely real, unmodified action. It is never consulted by anything but
// resolveWriteActionRoute, and is empty (a no-op) unless a test explicitly
// sets it.
const REQUIRES_DUAL_CONFIRMATION_TEST_OVERRIDES = new Map();

// [Audit fix, LOW, round 2] `value` used to coerce anything non-`true` to
// `false` -- today that's harmless (no production action opts in, so
// writing `false` is a no-op), but that safety was a coincidence of the
// current production state, not a structural property of this function.
// Requiring exactly `true` makes "this override can only ever TIGHTEN a
// gate, never weaken one" true regardless of what any future action's
// table entry says.
export function setRequiresDualConfirmationForTests(action, value) {
  if (!Object.hasOwn(WRITE_ACTION_ROUTES, action)) {
    throw new Error(`Cannot override requiresDualConfirmation for unknown write action: ${JSON.stringify(action)}`);
  }
  if (value !== true) {
    throw new Error(`setRequiresDualConfirmationForTests only ever tightens a gate -- call resetRequiresDualConfirmationOverridesForTests() to clear it, don't pass false.`);
  }
  REQUIRES_DUAL_CONFIRMATION_TEST_OVERRIDES.set(action, true);
}

export function resetRequiresDualConfirmationOverridesForTests() {
  REQUIRES_DUAL_CONFIRMATION_TEST_OVERRIDES.clear();
}

export function resolveWriteActionRoute(action, params) {
  if (!Object.hasOwn(WRITE_ACTION_ROUTES, action)) {
    // Lookup safety (round-2 audit, Security MEDIUM #740): action arrives
    // directly in an actor-signed request body -- a bare index risks resolving
    // "constructor"/"__proto__"/"toString" to a truthy inherited value instead
    // of undefined.
    return null;
  }
  const entry = WRITE_ACTION_ROUTES[action];
  return {
    method: entry.method,
    path: entry.path(params || {}),
    confirmPhrase: entry.confirmPhrase || null,
    policyAction: entry.policyAction,
    auditAction: entry.auditAction,
    requiresDualConfirmation: REQUIRES_DUAL_CONFIRMATION_TEST_OVERRIDES.has(action)
      ? REQUIRES_DUAL_CONFIRMATION_TEST_OVERRIDES.get(action)
      : entry.requiresDualConfirmation === true
  };
}

// Exact-match (method, path) verification for Hop B (docs/rw-architecture.md
// 3.2's CRITICAL #728 fix): the internal loopback credential must only ever
// be recognized for a request whose (method, path) is an exact match against
// ONE specific WRITE_ACTION_ROUTES entry -- never a broader match (e.g. by
// IAM action class alone, which would be too coarse: player.kick and
// player.ban share the same real policyAction, "players:moderate", so a
// policyAction-level check would let a credential scoped to one silently
// authorize the other). Patterns are derived mechanically from the same
// single source of truth (WRITE_ACTION_ROUTES's own path() functions) rather
// than hand-duplicated as a second table, which this project's own history
// shows drifts (policyAction's own #1012 staleness, found the same day this
// was written).
const PLAYER_ID_SENTINEL = "XXXPLAYERIDSENTINELXXX";
const BASE_ID_SENTINEL = "999999999";
const GUILD_ID_SENTINEL = "XXXGUILDIDSENTINELXXX";
const SENTINEL_PARAMS = { playerId: PLAYER_ID_SENTINEL, baseId: BASE_ID_SENTINEL, guildId: GUILD_ID_SENTINEL };

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPathPattern(entry) {
  const sentinelPath = entry.path(SENTINEL_PARAMS);
  const encodedPlayerSentinel = encodeURIComponent(PLAYER_ID_SENTINEL);
  const encodedGuildSentinel = encodeURIComponent(GUILD_ID_SENTINEL);
  let patternSource = escapeRegExp(sentinelPath);
  patternSource = patternSource.split(escapeRegExp(encodedPlayerSentinel)).join("[^/]+");
  patternSource = patternSource.split(escapeRegExp(encodedGuildSentinel)).join("[^/]+");
  patternSource = patternSource.split(BASE_ID_SENTINEL).join("[1-9][0-9]*");
  return new RegExp(`^${patternSource}$`);
}

const ACTION_PATH_PATTERNS = Object.freeze(
  Object.fromEntries(Object.entries(WRITE_ACTION_ROUTES).map(([action, entry]) => [action, { method: entry.method, pattern: buildPathPattern(entry) }]))
);

// Returns true only if `action` is a real WRITE_ACTION_ROUTES entry AND the
// given (method, path) is an exact structural match for THAT SPECIFIC
// entry's own path shape -- not merely "some" entry, and not merely "the
// same IAM action class." This is the real, load-bearing check Hop B's
// credential-resolution branch must use before ever trusting a claimed
// action name.
// Contract: `path` must already be normalized via
// `new URL(req.url, "http://localhost").pathname` (the convention this
// codebase uses everywhere) before being passed here -- normalization
// collapses ".."/percent-encoded-".." segments before this function would
// ever see them in real use. The explicit ".." guard below is redundant
// defense-in-depth for that real call path (verified: a `[^/]+` wildcard
// segment technically matches a literal ".." string, which would only
// matter if some future caller ever passed an un-normalized path), not a
// substitute for correct normalization at the real call site.
export function matchesWriteActionTarget(action, method, path) {
  if (typeof path !== "string" || path.includes("..")) return false;
  if (!Object.hasOwn(ACTION_PATH_PATTERNS, action)) return false;
  const { method: expectedMethod, pattern } = ACTION_PATH_PATTERNS[action];
  return method === expectedMethod && pattern.test(path);
}

// Startup self-check (docs/rw-architecture.md 3.5): resolves every path()
// template against a representative param set and confirms the resulting
// (method, path) matches a real entry in actions.js's own route catalog.
// Failure scope is deliberately narrow (round-2 UI/UX CRITICAL #737): this
// must never crash Core's boot -- only disable the RW write-bridge subsystem
// and let the rest of the console serve normally. Returns a list of problems
// (empty = clean); the caller decides what "disable the subsystem" means.
const REPRESENTATIVE_PARAMS = { playerId: "Server#4242", baseId: "1", guildId: "1" };

export function selfCheckWriteActionRoutes() {
  const problems = [];
  for (const [action, entry] of Object.entries(WRITE_ACTION_ROUTES)) {
    // [Layer 3 integration audit fix, MEDIUM, issue #1039] Before this
    // check, a WRITE_ACTION_ROUTES entry with no matching WRITE_ACTION_MIN_TIER
    // entry passed boot silently -- meetsMinTier() only discovered the gap
    // at request time via a bare thrown Error (an opaque 500 for the first
    // Discord actor unlucky enough to hit it), not a startup warning. This
    // is the exact hand-duplicated-table drift class issue #1012
    // (policyAction staleness) already burned this codebase on once.
    if (!Object.hasOwn(WRITE_ACTION_MIN_TIER, action)) {
      problems.push(`"${action}": present in WRITE_ACTION_ROUTES but has no matching WRITE_ACTION_MIN_TIER entry`);
    }
    let resolvedPath;
    try {
      resolvedPath = entry.path(REPRESENTATIVE_PARAMS);
    } catch (error) {
      problems.push(`"${action}": path() threw against representative params: ${error.message}`);
      continue;
    }
    const realAction = actionForRoute(resolvedPath, entry.method);
    if (!realAction) {
      problems.push(`"${action}": (${entry.method} ${resolvedPath}) does not resolve to any real Core route in actions.js`);
      continue;
    }
    if (entry.policyAction && realAction !== entry.policyAction) {
      problems.push(`"${action}": declared policyAction "${entry.policyAction}" does not match actions.js's real resolved action "${realAction}" for (${entry.method} ${resolvedPath})`);
    }
  }
  return problems;
}

// Mechanical confirmPhrase check (issue #1020, closing the exact gap that let
// #1016/#1018 both ship): for the subset of confirmPhrase-bearing actions
// whose real confirmation check lives in an EXPORTED service function (as
// opposed to a private route wrapper inside server.js, which nothing outside
// server.js can call), actually invoke the real function with a deliberately
// wrong confirmation and confirm it rejects with the exact phrase this table
// declares. Both functions checked here throw on a bad `confirmation` as
// their literal first line, before touching `config`/`playerId`/`players` in
// any way -- confirmed by reading carePackage.js directly -- so this is safe
// to run at boot with placeholder arguments; it can never reach a real
// mutation, a DB call, or an RMQ publish.
//
// This does NOT cover every confirmPhrase entry: several (player.ban,
// player.clear-backpack, map.spawn/despawn/respawn, carepackage.history-clear,
// carepackage.enable/disable/scan) have their confirmation check inside a
// private, non-exported server.js route-wrapper function, which nothing
// outside server.js can invoke without a larger refactor (exporting route
// handlers) that's out of scope here. Those remain covered only by the
// hand-maintained completeness test in writeActionRoutes.test.js -- a real,
// documented, narrower gap, not a silent one.
const REAL_HANDLER_CONFIRM_CHECKS = {
  "carepackage.grant": (badPhrase) => grantCarePackage(null, REPRESENTATIVE_PARAMS.playerId, { confirmation: badPhrase }),
  "carepackage.grant-all": (badPhrase) => grantEligibleCarePackages(null, [], { confirmation: badPhrase })
};

export async function checkConfirmPhrasesAgainstRealHandlers(routes = WRITE_ACTION_ROUTES) {
  const problems = [];
  for (const [action, invoke] of Object.entries(REAL_HANDLER_CONFIRM_CHECKS)) {
    const entry = routes[action];
    const expectedPhrase = entry?.confirmPhrase;
    if (!expectedPhrase) {
      problems.push(`"${action}": has a real-handler confirmation check but no confirmPhrase set in WRITE_ACTION_ROUTES`);
      continue;
    }
    let threw = false;
    let message = "";
    try {
      // Deliberately the WRONG phrase -- if the real handler doesn't reject
      // this, either the handler's confirmation gate was removed/weakened,
      // or (impossible by construction here, but checked anyway) the wrong
      // phrase happens to equal the real one.
      await invoke(`${expectedPhrase}-DEFINITELY-WRONG`);
    } catch (error) {
      threw = true;
      message = String(error?.message || "");
    }
    if (!threw) {
      problems.push(`"${action}": real handler accepted a deliberately wrong confirmation phrase -- its confirmation gate may have been removed`);
      continue;
    }
    if (!message.includes(expectedPhrase)) {
      problems.push(`"${action}": real handler's rejection message ("${message}") does not mention the table's declared confirmPhrase ("${expectedPhrase}") -- they may have drifted apart`);
    }
  }
  return problems;
}
