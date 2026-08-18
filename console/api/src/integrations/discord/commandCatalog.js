// Discord command catalog -- Phase 1 of the automated command-discovery
// design (docs/rfc-command-discovery.md, merged upstream as docs-only via
// Red-Blink/dune-awakening-selfhost-docker#141). Tracked by
// yacketrj/dune-awakening-selfhost-docker#337.
//
// Purpose: give the Discord bot (arrakis-control-panel) a single,
// mechanically verifiable source of truth for which read-only Discord
// adapter routes are live, what capability/tier each one requires, and what
// Discord-facing metadata (name, description, params) each one needs --
// replacing the bot's own hand-maintained LIVE_ROUTES/PLANNED_ROUTES/
// UNMERGED_ROUTES/MISSING_ROUTES classification in adapterClient.js, which
// has required five separate manual reconciliations to date (2026-07-26,
// 2026-07-27, 2026-08-06, 2026-08-08, 2026-08-16) purely because there was
// no automated way to detect drift between this file's real route table and
// the bot's own copy.
//
// Deliberately Phase 1 only (see the RFC's own §4 migration path): this
// file composes catalog entries from data that ALREADY exists as code
// (DISCORD_LIVE_ADAPTER_ROUTES, DISCORD_CAPABILITIES, the per-route
// capability checks in routes.js/adapter.js, and CAPABILITY_BY_TIER's
// effective minimum tier per capability) plus newly-authored Discord-facing
// metadata (group/subcommand name, description, param shape) that does not
// exist as code anywhere today and must be authored once per route. It does
// NOT introduce a second, independently-hand-maintained metadata object the
// way the RFC's own illustrative example risked -- COMMAND_CATALOG_ASSERT
// below fails loudly (throws) if a live route is missing an entry, or if an
// entry references a route that isn't actually live, so this file cannot
// silently drift from adapter.js the way the bot's classification did.
//
// Phases 2 (bot-side generator script), 3 (bot runtime loads from the
// generated registry), and 4 (dynamic refresh, per-guild catalogs,
// autocomplete) are explicitly out of scope here -- see issue #337.
//
// Metadata sourced from arrakis-control-panel's src/commands.js
// buildDuneCommand() (the bot's own real, currently-registered Discord
// command definitions) so this catalog describes what Discord users
// actually see today, not a fresh, independently-invented naming scheme.
// Verified directly against arrakis-control-panel @ 8f3d3ed (2026-08-18).

import { DISCORD_ADAPTER_ROUTES, DISCORD_LIVE_ADAPTER_ROUTES } from "./adapter.js";
import { DISCORD_CAPABILITIES } from "./policy.js";

export const CATALOG_VERSION = 1;

// Minimum Discord role tier able to invoke each capability, derived
// directly from adapter.js's CAPABILITY_BY_TIER (public/observer/moderator
// grant sets are enumerated there explicitly; admin and owner both receive
// every non-self-scoped capability). This is NOT a second copy of that
// table -- it is a one-time derivation recorded here as data because
// policy.js does not export an inverse (capability -> min tier) lookup.
// If policy.js's CAPABILITY_BY_TIER ever changes, this map must be updated
// to match -- the catalogContractTest.js drift check (see this file's test
// counterpart) intentionally does NOT re-derive this automatically, since
// doing so would require importing policy.js's private CAPABILITY_BY_TIER
// object, which isn't exported. Reviewers: cross-check any capability
// added/moved in policy.js against this map by hand.
const MIN_TIER_BY_CAPABILITY = Object.freeze({
  [DISCORD_CAPABILITIES.STATUS_READ]: "public",
  [DISCORD_CAPABILITIES.READINESS_READ]: "observer",
  [DISCORD_CAPABILITIES.SERVICES_READ]: "observer",
  [DISCORD_CAPABILITIES.POPULATION_READ]: "moderator",
  [DISCORD_CAPABILITIES.LOGS_READ]: "admin",
  [DISCORD_CAPABILITIES.MAPS_READ]: "moderator",
  [DISCORD_CAPABILITIES.BACKUPS_READ]: "moderator",
  [DISCORD_CAPABILITIES.INVENTORY_READ]: "moderator",
  [DISCORD_CAPABILITIES.STORAGE_READ]: "moderator",
  [DISCORD_CAPABILITIES.GUILD_READ]: "moderator",
  [DISCORD_CAPABILITIES.OPS_ACTIVITY_READ]: "admin",
  [DISCORD_CAPABILITIES.OPS_COMBAT_READ]: "admin",
  [DISCORD_CAPABILITIES.OPS_RESOURCES_READ]: "admin",
  [DISCORD_CAPABILITIES.OPS_ECONOMY_READ]: "admin",
  [DISCORD_CAPABILITIES.OPS_INVENTORY_READ]: "admin",
  [DISCORD_CAPABILITIES.OPS_SOC_READ]: "admin",
  [DISCORD_CAPABILITIES.OPS_PROMETHEUS_READ]: "admin",
  [DISCORD_CAPABILITIES.BROADCAST_SEND]: "admin",
  // Self-scoped capabilities (see policy.js's SELF_SCOPED_CAPABILITIES):
  // authorized via requireSelfScopedCapability(), not the tier ladder --
  // any authenticated actor (observer tier or above) may always act on
  // their own Discord identity. Recorded here as "observer" (the floor
  // requireSelfScopedCapability() itself enforces), not "public", so
  // catalog consumers don't mistake these for anonymous-accessible routes.
  [DISCORD_CAPABILITIES.PLAYER_LINK_WRITE]: "observer",
  [DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE]: "observer"
});

// One entry per DISCORD_LIVE_ADAPTER_ROUTES member. Keys are route path
// strings (DISCORD_ADAPTER_ROUTES.* values), not route constant names, so
// COMMAND_CATALOG_ASSERT can validate coverage by iterating
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
    description: "Show current maintenance note or window (read-only).",
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
    // the bot's own DISCORD_CAPABILITIES.BACKUPS_READ exists to describe,
    // but this is NOT enforced per-actor by this specific route today --
    // flagged here rather than silently assumed, so a future reviewer can
    // decide whether that's intentional (metadata-only, low sensitivity)
    // or a gap to close in a separate issue.
    capability: DISCORD_CAPABILITIES.BACKUPS_READ,
    routeEnforcesCapability: false,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.ANNOUNCEMENTS]: {
    group: "ops", subcommand: "announcements",
    description: "Show recent in-game player announcements.",
    // routes.js checks MAPS_READ for this route (verified directly,
    // console/api/src/integrations/discord/routes.js:245) -- not a new
    // ANNOUNCEMENTS-specific capability. Recorded as-is, not "corrected",
    // since changing it is out of this issue's scope.
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
    selfScoped: true,
    params: [
      { name: "character", type: "STRING", required: true, description: "Your character name." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_LINK_VERIFY]: {
    group: "player", subcommand: "verify",
    description: "Verify a pending character link with a code.",
    capability: DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
    selfScoped: true,
    params: [
      { name: "code", type: "STRING", required: true, description: "Verification code from in-game whisper." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_UNLINK]: {
    group: "player", subcommand: "unlink",
    description: "Unlink your character from your Discord (single-link flow).",
    capability: DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
    selfScoped: true,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK]: {
    group: "player", subcommand: "link",
    description: "Link an additional character to your Discord (multi-account).",
    capability: DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
    selfScoped: true,
    params: [
      { name: "character", type: "STRING", required: true, description: "Character name to link." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK_VERIFY]: {
    group: "player", subcommand: "verify",
    description: "Verify a pending additional-account link with a code.",
    capability: DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
    selfScoped: true,
    params: [
      { name: "code", type: "STRING", required: true, description: "Verification code from in-game whisper." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_UNLINK]: {
    group: "player", subcommand: "unlink",
    description: "Unlink one additional character from your Discord.",
    capability: DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
    selfScoped: true,
    params: [
      { name: "character", type: "STRING", required: false, description: "Player controller ID from /dune player characters." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LIST]: {
    group: "player", subcommand: "characters",
    description: "List your verified characters.",
    capability: DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
    selfScoped: true,
    params: []
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_SET_DEFAULT]: {
    group: "player", subcommand: "default",
    description: "Set your default character for this guild.",
    capability: DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
    selfScoped: true,
    params: [
      { name: "character", type: "STRING", required: true, description: "Character link ID." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK_STEAM]: {
    group: "player", subcommand: "link-steam",
    description: "Link a character via Steam OAuth (currently disabled -- see route handler).",
    capability: DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
    selfScoped: true,
    // Route currently returns a static "disabled" response unconditionally
    // (security review 2026-08-08, pending OAuth binding) -- included here
    // because it IS in DISCORD_LIVE_ADAPTER_ROUTES and has a real handler,
    // but callers should not expect this to perform an actual link today.
    disabledPendingSecurityReview: true,
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
    // config.version unconditionally (routes.js:482-484). No capability
    // is actually checked; recorded as null rather than guessing one.
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

function minTierForCapability(capability) {
  if (!capability) return null;
  return MIN_TIER_BY_CAPABILITY[capability] || null;
}

// Builds the catalog payload, asserting full, exact coverage against
// DISCORD_LIVE_ADAPTER_ROUTES in both directions:
//   1. every live route has a COMMAND_METADATA entry (nothing silently
//      missing from the catalog), and
//   2. every COMMAND_METADATA entry corresponds to a currently-live route
//      (nothing stale left behind after a route is retired).
// Throws synchronously on either violation -- this is the mechanism that
// replaces the bot's manual reconciliation process with a build-time/
// request-time failure Core's own test suite catches immediately.
export function buildCommandCatalog() {
  const liveSet = new Set(DISCORD_LIVE_ADAPTER_ROUTES);
  const metadataRoutes = Object.keys(COMMAND_METADATA);

  const missing = DISCORD_LIVE_ADAPTER_ROUTES.filter((route) => !(route in COMMAND_METADATA));
  if (missing.length > 0) {
    throw new Error(`commandCatalog.js: ${missing.length} live route(s) missing catalog metadata: ${missing.join(", ")}`);
  }

  const stale = metadataRoutes.filter((route) => !liveSet.has(route));
  if (stale.length > 0) {
    throw new Error(`commandCatalog.js: ${stale.length} catalog entry(ies) reference route(s) no longer in DISCORD_LIVE_ADAPTER_ROUTES: ${stale.join(", ")}`);
  }

  const groups = new Map();
  for (const route of DISCORD_LIVE_ADAPTER_ROUTES) {
    const meta = COMMAND_METADATA[route];
    if (!groups.has(meta.group)) groups.set(meta.group, []);
    groups.get(meta.group).push({
      name: meta.subcommand,
      description: meta.description,
      route,
      capability: meta.capability,
      minTier: minTierForCapability(meta.capability),
      selfScoped: Boolean(meta.selfScoped),
      requiresWritesEnabled: Boolean(meta.requiresWritesEnabled),
      routeEnforcesCapability: meta.routeEnforcesCapability !== false,
      params: meta.params || []
    });
  }

  return {
    version: CATALOG_VERSION,
    groups: [...groups.entries()].map(([name, subcommands]) => ({ name, subcommands }))
  };
}
