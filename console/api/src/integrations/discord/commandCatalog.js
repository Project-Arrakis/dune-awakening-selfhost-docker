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

export const CATALOG_VERSION = 1;

// One entry per DISCORD_LIVE_ADAPTER_ROUTES member. Keys are route path
// strings (DISCORD_ADAPTER_ROUTES.* values), not route constant names, so
// buildCommandCatalog() can validate coverage by iterating
// DISCORD_LIVE_ADAPTER_ROUTES directly.
//
// capability: the exact capability string routes.js/adapter.js actually
// checks for this route (verified by direct reading of both files, not
// inferred) -- diagnostic-mode STATUS uses LOGS_READ instead of
// STATUS_READ; that distinction is preserved here via diagnosticCapability.
const COMMAND_METADATA = Object.freeze({
  [DISCORD_ADAPTER_ROUTES.HEALTH]: {
    group: "server", subcommand: "health",
    description: "Check the console Discord adapter.",
    capability: DISCORD_CAPABILITIES.STATUS_READ,
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
      { name: "character", type: "STRING", required: true, description: "Your character name." }
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
  [DISCORD_ADAPTER_ROUTES.PLAYERS_INVENTORY]: {
    group: "player", subcommand: "inventory",
    description: "View your personal inventory.",
    capability: DISCORD_CAPABILITIES.INVENTORY_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_STORAGE]: {
    group: "player", subcommand: "storage",
    description: "View your storage containers grouped by map.",
    capability: DISCORD_CAPABILITIES.STORAGE_READ,
    params: [
      { name: "scope", type: "STRING", required: false, description: 'Storage scope: "owned" (default) or "guild".', choices: ["owned", "guild"] }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_FIND]: {
    group: "player", subcommand: "find",
    description: "Search for items across your containers.",
    capability: DISCORD_CAPABILITIES.INVENTORY_READ,
    params: [
      { name: "query", type: "STRING", required: true, description: "Item name to search for." },
      { name: "scope", type: "STRING", required: false, description: 'Search scope: "owned" (default) or "guild".', choices: ["owned", "guild"] }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_INVENTORY_SEARCH]: {
    group: "player", subcommand: "inventory",
    description: "View your personal inventory, filtered by item name.",
    capability: DISCORD_CAPABILITIES.INVENTORY_READ,
    params: [
      { name: "search", type: "STRING", required: false, description: "Filter by item name (optional)." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.GUILD_STORAGE]: {
    group: "player", subcommand: "storage",
    description: "View guild-scoped storage containers.",
    capability: DISCORD_CAPABILITIES.GUILD_READ,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.GUILD_FIND]: {
    group: "player", subcommand: "find",
    description: "Search for items across guild containers.",
    capability: DISCORD_CAPABILITIES.GUILD_READ,
    params: [
      { name: "query", type: "STRING", required: true, description: "Item name to search for." }
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

  const groups = new Map();
  for (const route of liveRoutes) {
    const meta = metadata[route];
    if (!groups.has(meta.group)) groups.set(meta.group, []);
    groups.get(meta.group).push({
      name: meta.subcommand,
      description: meta.description,
      route,
      capability: meta.capability,
      minTier: resolveMinTier(meta.capability),
      requiresWritesEnabled: Boolean(meta.requiresWritesEnabled),
      routeEnforcesCapability: meta.routeEnforcesCapability !== false,
      params: meta.params || []
    });
  }

  const result = {
    version: CATALOG_VERSION,
    groups: [...groups.entries()].map(([name, subcommands]) => ({ name, subcommands }))
  };
  if (isProductionCall) cachedProductionCatalog = result;
  return result;
}
