// Discord command catalog -- Phase 1 of the automated command-discovery
// design (docs/rfc-command-discovery.md, merged upstream as docs-only via
// Red-Blink/dune-awakening-selfhost-docker#141).
//
// Purpose: give the Discord bot (arrakis-control-panel) a single,
// mechanically verifiable source of truth for which read-only Discord
// adapter routes are live, what capability/tier each one requires, and what
// Discord-facing metadata (name, description, params) each one needs --
// replacing the bot's own hand-maintained route classification, which has
// required several separate manual reconciliations to date purely because
// there was no automated way to detect drift between this file's real route
// table and the bot's own copy.
//
// Deliberately Phase 1 only (see the RFC's own §4 migration path): this
// file composes catalog entries from data that ALREADY exists as code
// (DISCORD_LIVE_ADAPTER_ROUTES, DISCORD_CAPABILITIES, the per-route
// capability checks in routes.js/adapter.js, and policy.js's
// minTierForCapability() for the effective minimum tier per capability)
// plus newly-authored Discord-facing metadata (group/subcommand name,
// description, param shape) that does not exist as code anywhere today and
// must be authored once per route.
//
// NOTE on scope of the drift-safety claim below: buildCommandCatalog()'s
// coverage assertion (the missing/stale checks) makes ROUTE coverage
// drift-proof -- it throws if a live route lacks a COMMAND_METADATA entry,
// or if an entry references a route that's no longer live. It does NOT make
// the hand-authored fields WITHIN each entry (like `description`) drift-
// proof -- those still require a human to keep them accurate against the
// real route behavior.
//
// Phases 2 (bot-side generator script), 3 (bot runtime loads from the
// generated registry), and 4 (dynamic refresh, per-guild catalogs,
// autocomplete) are explicitly out of scope here.
//
// Metadata sourced from the Discord bot's own real, currently-registered
// command definitions (buildDuneCommand() in the bot repo's src/commands.js)
// so this catalog describes what Discord users actually see today, not a
// fresh, independently-invented naming scheme.

import { DISCORD_ADAPTER_ROUTES, DISCORD_LIVE_ADAPTER_ROUTES } from "./adapter.js";
import { DISCORD_CAPABILITIES, minTierForCapability } from "./policy.js";

// Bumped from 1 to 2 for this revision: subcommand.route (a single string)
// became subcommand.routes (an array) for every (group, subcommand) pair
// that fans out to more than one backing adapter route -- a breaking shape
// change for any future consumer that assumed one route per subcommand, per
// this constant's own original design intent (see adapter.js's
// DISCORD_CATALOG_PROTOCOL_VERSION comment: bump on "a field is removed or
// its meaning changes", not on ordinary additions). No live consumer exists
// yet (Phase 2/3 bot-side generator is still unimplemented -- confirmed via
// grep across arrakis-control-panel's src/ for buildCommandCatalog/
// DISCORD_CATALOG_PROTOCOL_VERSION, zero hits), so this bump is forward
// hygiene, not a fix for an active breakage.
export const CATALOG_VERSION = 2;

// One entry per DISCORD_LIVE_ADAPTER_ROUTES member. Keys are route path
// strings (DISCORD_ADAPTER_ROUTES.* values), not route constant names, so
// buildCommandCatalog() can validate coverage by iterating
// DISCORD_LIVE_ADAPTER_ROUTES directly.
//
// capability: the exact capability string routes.js/adapter.js actually
// checks for this route (verified by direct reading of both files, not
// inferred) -- diagnostic-mode STATUS uses LOGS_READ instead of
// STATUS_READ; that distinction is preserved here via diagnosticCapability.
//
// method: the exact HTTP method routes.js's real dispatch table checks for
// this route (`req.method === "GET"|"POST"`) -- defaults to "POST" when
// omitted (buildCommandCatalog() below), since all but 3 live routes
// (HEALTH, VERSION, BACKUPS_LIST) are POST; those 3 set method: "GET"
// explicitly rather than every other entry repeating "POST".
//
// params[].bodyField: the real JSON body field name routes.js actually
// reads for this param (e.g. `body.characterName`), when it differs from
// the param's own Discord-facing `name` (e.g. "character"). Defaults to
// the param's own `name` when omitted -- most params match 1:1; only
// PLAYERS_LINK ("character" -> "characterName") and
// PLAYERS_INVENTORY_SEARCH ("search" -> "query") need an explicit
// override today (found via upstream PR #171's review; see
// discordCommandCatalog.test.js's cross-check against routes.js's real
// body.<field> reads for the mechanism that keeps this from silently
// drifting again).
//
// Three (group, subcommand) pairs intentionally fan out to two backing
// routes each -- confirmed against the real, live Discord bot
// (arrakis-control-panel/src/commands.js) that these are genuinely ONE
// Discord subcommand each, not two: the bot registers a single "storage"/
// "find"/"inventory" subcommand and picks which adapter route to call at
// runtime based on a param value (scope=guild, or search being present).
// Each fanned-out route entry below carries its own `selector` describing
// which param/value picks it; the entry with `selector: null` is the
// default used when no other selector in the pair matches. This is NOT a
// naming collision to rename away -- inventing distinct subcommand names
// (e.g. "guild-storage") would contradict this file's own design mandate
// (see the module header) that catalog names must match what Discord users
// actually see today, not a fresh naming scheme.
// Exported (not just module-private) so discordCommandCatalog.test.js can
// cross-check every declared field/bodyField against buildCommandCatalog()'s
// real output and against routes.js's real body.<field> reads, without
// re-deriving or hand-retyping this table a second time inside the test
// (which would be tautological -- see that test file's own comments).
export const COMMAND_METADATA = Object.freeze({
  [DISCORD_ADAPTER_ROUTES.HEALTH]: {
    group: "server", subcommand: "health",
    description: "Check the console Discord adapter.",
    // HEALTH has no requireDiscordCapability() call -- discordAdapterHealth()
    // (adapter.js) never checks a capability, identical in enforcement
    // posture to BACKUPS_LIST/VERSION below. Recorded as STATUS_READ for
    // display purposes (matching the bot's own health command's stated
    // minimum role), but routeEnforcesCapability: false makes clear that
    // is not actually enforced by this specific route -- found by an L3
    // integration audit (Red-Blink/dune-awakening-selfhost-docker#171)
    // that independently re-derived every route's real enforcement from
    // routes.js/adapter.js rather than trusting this table's own claims.
    capability: DISCORD_CAPABILITIES.STATUS_READ,
    routeEnforcesCapability: false,
    method: "GET",
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.STATUS]: {
    group: "server", subcommand: "status",
    description: "Show high-level server status.",
    capability: DISCORD_CAPABILITIES.STATUS_READ,
    // diagnostic=true switches the required capability to LOGS_READ
    // (admin-tier) -- see discordAdapterStatus() in adapter.js.
    diagnosticCapability: DISCORD_CAPABILITIES.LOGS_READ,
    params: [
      { name: "diagnostic", type: "BOOLEAN", required: false, description: "Admin-only: full diagnostic with containers table." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.READINESS]: {
    group: "server", subcommand: "readiness",
    description: "Show readiness and preflight state.",
    capability: DISCORD_CAPABILITIES.READINESS_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.SERVICES]: {
    group: "server", subcommand: "services",
    description: "Show service container state.",
    capability: DISCORD_CAPABILITIES.SERVICES_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.POPULATION]: {
    group: "data", subcommand: "population",
    description: "Show aggregate player count and server population.",
    capability: DISCORD_CAPABILITIES.POPULATION_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.LOGS]: {
    group: "logs", subcommand: "service",
    description: "Show recent logs from a specific game service container.",
    capability: DISCORD_CAPABILITIES.LOGS_READ,
    params: [
      { name: "service", type: "STRING", required: true, description: "Service/container name." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.MAP_STATE]: {
    group: "data", subcommand: "maps",
    description: "Show active game maps with state and uptime.",
    capability: DISCORD_CAPABILITIES.MAPS_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.MAINTENANCE]: {
    group: "server", subcommand: "maintenance",
    // The route handler (routes.js) runs `dune ready` -- the exact same
    // underlying command READINESS already runs -- and returns raw
    // readiness output. It does NOT read a maintenance note/window from
    // anywhere. Recorded here as what the route ACTUALLY does, not what
    // its name might otherwise imply.
    description: "Show current maintenance/readiness state (runs the same check as /dune server readiness).",
    capability: DISCORD_CAPABILITIES.READINESS_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.BACKUPS_LIST]: {
    group: "data", subcommand: "backups",
    description: "List recent backup metadata (read-only).",
    // BACKUPS_LIST has no requireDiscordCapability() call in routes.js --
    // it is unauthenticated at the route-handler level (relies on the
    // adapter's bearer-token auth only, checked earlier in the dispatch
    // pipeline via requireDiscordBotToken()). Recorded as BACKUPS_READ's
    // tier (moderator) for catalog/UX purposes since that's the capability
    // DISCORD_CAPABILITIES.BACKUPS_READ exists to describe, but this is NOT
    // enforced per-actor by this specific route today -- flagged here
    // rather than silently assumed.
    capability: DISCORD_CAPABILITIES.BACKUPS_READ,
    routeEnforcesCapability: false,
    method: "GET",
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.ANNOUNCEMENTS]: {
    group: "ops", subcommand: "announcements",
    description: "Show recent in-game player announcements.",
    // routes.js checks MAPS_READ for this route -- not a new
    // ANNOUNCEMENTS-specific capability. Recorded as-is.
    capability: DISCORD_CAPABILITIES.MAPS_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.OPS_ACTIVITY]: {
    group: "ops", subcommand: "activity",
    description: "Recent server activity summary.",
    capability: DISCORD_CAPABILITIES.OPS_ACTIVITY_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.OPS_COMBAT]: {
    group: "ops", subcommand: "combat",
    description: "Recent combat statistics summary.",
    capability: DISCORD_CAPABILITIES.OPS_COMBAT_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.OPS_RESOURCES]: {
    group: "ops", subcommand: "resources",
    description: "Deep Desert / Hagga Basin resource summary.",
    capability: DISCORD_CAPABILITIES.OPS_RESOURCES_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.OPS_ECONOMY]: {
    group: "ops", subcommand: "economy",
    description: "Server economy summary.",
    capability: DISCORD_CAPABILITIES.OPS_ECONOMY_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.OPS_INVENTORY]: {
    group: "ops", subcommand: "armory",
    description: "Aggregate armory/inventory summary.",
    capability: DISCORD_CAPABILITIES.OPS_INVENTORY_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.OPS_SOC]: {
    group: "ops", subcommand: "soc",
    description: "Security operations center bridge-request summary.",
    capability: DISCORD_CAPABILITIES.OPS_SOC_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.OPS_PROMETHEUS]: {
    group: "ops", subcommand: "prometheus",
    description: "Prometheus-backed metrics summary.",
    capability: DISCORD_CAPABILITIES.OPS_PROMETHEUS_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.BROADCAST]: {
    group: "admin", subcommand: "broadcast",
    description: "Send a message to all in-game players.",
    capability: DISCORD_CAPABILITIES.BROADCAST_SEND,
    // Also gated behind DUNE_DISCORD_WRITES_ENABLED at the route level
    // (discordWritesEnabled(config), routes.js) in addition to the
    // capability check -- this is the bot's one non-read-only live route.
    requiresWritesEnabled: true,
    params: [
      { name: "message", type: "STRING", required: true, description: "Message to broadcast.", maxLength: 500 }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_LINK]: {
    group: "player", subcommand: "link",
    description: "Link your Discord to your game character.",
    capability: DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
    params: [
      // routes.js:251 reads body.characterName, not body.character --
      // found by upstream PR #171's review (Red-Blink).
      { name: "character", bodyField: "characterName", type: "STRING", required: true, description: "Your character name." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_LINK_VERIFY]: {
    group: "player", subcommand: "verify",
    description: "Verify a pending character link with a code.",
    capability: DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
    params: [
      { name: "code", type: "STRING", required: true, description: "Verification code from in-game whisper." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_UNLINK]: {
    group: "player", subcommand: "unlink",
    description: "Unlink your character from your Discord.",
    capability: DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_ME]: {
    group: "player", subcommand: "whoami",
    description: "Show your linked game character info.",
    capability: DISCORD_CAPABILITIES.INVENTORY_READ,
    params: []
  },
  // Fan-out pair 1 of 3 (upstream PR #171 review): the bot registers ONE
  // real "storage" subcommand under group "player" (commands.js) with a
  // scope choice ("owned"/"guild"); at runtime it calls PLAYERS_STORAGE for
  // scope=owned (the default) or GUILD_STORAGE for scope=guild
  // (commands.js's own comment: "guild scope has a dedicated guild-scoped
  // route; do not silently fall back"). Two different capabilities/tiers
  // are genuinely enforced depending on which route is selected --
  // STORAGE_READ vs GUILD_READ -- so collapsing this into a single flat
  // catalog entry with one capability would misreport the guild path's
  // real authorization requirement. selector: null marks the default route
  // used when no other selector in this (group, subcommand) pair matches.
  [DISCORD_ADAPTER_ROUTES.PLAYERS_STORAGE]: {
    group: "player", subcommand: "storage",
    description: "View your storage containers grouped by map.",
    capability: DISCORD_CAPABILITIES.STORAGE_READ,
    selector: null,
    params: [
      { name: "scope", type: "STRING", required: false, description: 'Storage scope: "owned" (default) or "guild".', choices: ["owned", "guild"] }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.GUILD_STORAGE]: {
    group: "player", subcommand: "storage",
    description: "View guild-scoped storage containers.",
    capability: DISCORD_CAPABILITIES.GUILD_READ,
    selector: { param: "scope", equals: "guild" },
    params: []
  },
  // Fan-out pair 2 of 3: same pattern as storage above -- one real "find"
  // subcommand, scope-selected between PLAYERS_FIND (owned, default) and
  // GUILD_FIND (guild), with genuinely different capabilities
  // (INVENTORY_READ vs GUILD_READ).
  [DISCORD_ADAPTER_ROUTES.PLAYERS_FIND]: {
    group: "player", subcommand: "find",
    description: "Search for items across your containers.",
    capability: DISCORD_CAPABILITIES.INVENTORY_READ,
    selector: null,
    params: [
      { name: "query", type: "STRING", required: true, description: "Item name to search for." },
      { name: "scope", type: "STRING", required: false, description: 'Search scope: "owned" (default) or "guild".', choices: ["owned", "guild"] }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.GUILD_FIND]: {
    group: "player", subcommand: "find",
    description: "Search for items across guild containers.",
    capability: DISCORD_CAPABILITIES.GUILD_READ,
    selector: { param: "scope", equals: "guild" },
    params: [
      { name: "query", type: "STRING", required: true, description: "Item name to search for." }
    ]
  },
  // Fan-out pair 3 of 3: one real "inventory" subcommand under group
  // "player" with an optional "search" string option (commands.js). The
  // bot calls PLAYERS_INVENTORY_SEARCH when search is present, else
  // PLAYERS_INVENTORY -- selected by param PRESENCE, not a value match, so
  // the selector shape differs from the two pairs above (`present: true`
  // instead of `equals`). Same capability either way (INVENTORY_READ), so
  // this pair is a real UX fan-out, not a security-relevant one like the
  // two above -- still fixed the same way for structural consistency and
  // because a future capability change to either route must not silently
  // apply to only one side of a flattened entry.
  [DISCORD_ADAPTER_ROUTES.PLAYERS_INVENTORY]: {
    group: "player", subcommand: "inventory",
    description: "View your personal inventory.",
    capability: DISCORD_CAPABILITIES.INVENTORY_READ,
    selector: null,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_INVENTORY_SEARCH]: {
    group: "player", subcommand: "inventory",
    description: "View your personal inventory, filtered by item name.",
    capability: DISCORD_CAPABILITIES.INVENTORY_READ,
    selector: { param: "search", present: true },
    params: [
      // routes.js:339 reads body.query, not body.search -- found by
      // upstream PR #171's review (Red-Blink). "search" is what the bot's
      // own Discord-facing option is named (commands.js); "query" is the
      // wire field the adapter route actually reads.
      { name: "search", bodyField: "query", type: "STRING", required: false, description: "Filter by item name (optional)." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.VERSION]: {
    group: "infra", subcommand: "version",
    description: "Show Dune stack version.",
    // VERSION has no requireDiscordCapability() call -- GET-only, returns
    // config.version unconditionally. No capability is actually checked;
    // recorded as null rather than guessing one.
    capability: null,
    routeEnforcesCapability: false,
    method: "GET",
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.SERVERS]: {
    group: "infra", subcommand: "servers",
    description: "List game servers.",
    capability: DISCORD_CAPABILITIES.SERVICES_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.PORTS]: {
    group: "infra", subcommand: "ports",
    description: "Show network port and listener status.",
    capability: DISCORD_CAPABILITIES.SERVICES_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.DB]: {
    group: "infra", subcommand: "db",
    description: "Show database status and health.",
    capability: DISCORD_CAPABILITIES.SERVICES_READ,
    params: []
  }
});

function resolveMinTier(capability) {
  if (!capability) return null;
  return minTierForCapability(capability);
}

// Builds the catalog payload, asserting full, exact coverage against the
// live-route list in both directions:
//   1. every live route has a metadata entry (nothing silently missing
//      from the catalog), and
//   2. every metadata entry corresponds to a currently-live route (nothing
//      stale left behind after a route is retired).
// Throws synchronously on either violation -- this is the mechanism that
// replaces manual reconciliation with a build-time/request-time failure
// the test suite catches immediately.
//
// liveRoutes/metadata parameters default to the real, production data
// (DISCORD_LIVE_ADAPTER_ROUTES, COMMAND_METADATA) and exist ONLY so
// discordCommandCatalog.test.js can inject a deliberately mismatched pair
// and assert the throw actually fires. No production call site should ever
// pass these explicitly; the route handler in routes.js calls
// buildCommandCatalog() with no arguments.
//
// The zero-argument (production) call path is memoized -- DISCORD_LIVE_
// ADAPTER_ROUTES and COMMAND_METADATA are both frozen, load-time-constant
// module data that never changes for the lifetime of a running process, so
// recomputing the coverage assertion and group composition on every GET
// /catalog request is pure wasted work. Memoization is skipped entirely
// when either argument is explicitly passed (the test-injection path), so
// injected test data is never cached across calls.
let cachedProductionCatalog = null;
export function buildCommandCatalog(liveRoutes = DISCORD_LIVE_ADAPTER_ROUTES, metadata = COMMAND_METADATA) {
  const isProductionCall = liveRoutes === DISCORD_LIVE_ADAPTER_ROUTES && metadata === COMMAND_METADATA;
  if (isProductionCall && cachedProductionCatalog) return cachedProductionCatalog;

  const liveSet = new Set(liveRoutes);
  const metadataRoutes = Object.keys(metadata);

  const missing = liveRoutes.filter((route) => !(route in metadata));
  if (missing.length > 0) {
    throw new Error(`commandCatalog.js: ${missing.length} live route(s) missing catalog metadata: ${missing.join(", ")}`);
  }

  const stale = metadataRoutes.filter((route) => !liveSet.has(route));
  if (stale.length > 0) {
    throw new Error(`commandCatalog.js: ${stale.length} catalog entry(ies) reference route(s) no longer in DISCORD_LIVE_ADAPTER_ROUTES: ${stale.join(", ")}`);
  }

  // groups: group name -> (subcommand name -> array of route entries).
  // A subcommand normally has exactly one route entry; the 3 documented
  // fan-out pairs above (storage/find/inventory) produce two -- see this
  // file's header comment for why that's a real, intentional shape and not
  // a bug to flatten away.
  const groups = new Map();
  for (const route of liveRoutes) {
    // Destructure-and-spread (not a hand-picked allowlist): every field
    // NOT explicitly named below survives into the output route entry
    // automatically via `...rest` -- this is the fix for the
    // diagnosticCapability-silently-dropped bug (upstream PR #171 review):
    // a future metadata field added to COMMAND_METADATA reaches the
    // catalog's real JSON output without anyone having to remember to also
    // edit this block a second time. Only fields that need renaming
    // (group/subcommand, consumed into the Map keys below rather than
    // copied verbatim) or type coercion (requiresWritesEnabled,
    // routeEnforcesCapability -- both intentionally normalized to a real
    // boolean, undefined -> false, not left as undefined) are named
    // explicitly and excluded from `rest`.
    const { group, subcommand, capability, requiresWritesEnabled, routeEnforcesCapability, method, params, ...rest } = metadata[route];
    const routeEntry = {
      ...rest,
      route,
      capability,
      minTier: resolveMinTier(capability),
      // Conditional capabilities need their own tier on the wire. A bot
      // cannot derive this from diagnosticCapability alone because the
      // Core policy table is not otherwise part of the catalog response.
      ...(rest.diagnosticCapability
        ? { diagnosticMinTier: resolveMinTier(rest.diagnosticCapability) }
        : {}),
      method: method || "POST",
      requiresWritesEnabled: Boolean(requiresWritesEnabled),
      routeEnforcesCapability: routeEnforcesCapability !== false,
      // bodyField defaults to the param's own Discord-facing name when not
      // explicitly overridden -- most params match their real body field
      // 1:1; PLAYERS_LINK and PLAYERS_INVENTORY_SEARCH are the two
      // documented exceptions today (see their own entries above).
      params: (params || []).map((param) => ({ ...param, bodyField: param.bodyField || param.name }))
    };

    if (!groups.has(group)) groups.set(group, new Map());
    const subcommands = groups.get(group);
    if (!subcommands.has(subcommand)) subcommands.set(subcommand, []);
    subcommands.get(subcommand).push(routeEntry);
  }

  const result = {
    version: CATALOG_VERSION,
    groups: [...groups.entries()].map(([groupName, subcommands]) => ({
      name: groupName,
      subcommands: [...subcommands.entries()].map(([subcommandName, routes]) => ({
        name: subcommandName,
        routes
      }))
    }))
  };
  if (isProductionCall) cachedProductionCatalog = result;
  return result;
}
