// Discord command catalog -- Phase 1 of the automated command-discovery
// design (docs/rfc-command-discovery.md, merged upstream as docs-only via
// Red-Blink/dune-awakening-selfhost-docker#141). Tracked by
// yacketrj/dune-awakening-selfhost-docker#337.
//
// Purpose: give the Discord bot (Mentat) a single,
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
// capability checks in routes.js/adapter.js, and policy.js's
// minTierForCapability() for the effective minimum tier per capability)
// plus newly-authored Discord-facing metadata (group/subcommand name,
// description, param shape) that does not exist as code anywhere today and
// must be authored once per route.
//
// NOTE on scope of the drift-safety claim below: buildCommandCatalog()'s
// coverage assertion (the missing/stale checks) makes ROUTE coverage
// drift-proof -- it throws if a live route lacks a COMMAND_METADATA entry,
// or if an entry references a route that's no longer live, so this file
// cannot silently drift from adapter.js's route table the way the bot's
// LIVE_ROUTES/PLANNED_ROUTES/UNMERGED_ROUTES/MISSING_ROUTES classification
// did. It does NOT make the hand-authored fields WITHIN each entry (like
// `description`) drift-proof -- those still require a human to keep them
// accurate against the real route behavior (see e.g. the MAINTENANCE
// entry's own comment below for a known, tracked case of this).
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
import { DISCORD_CAPABILITIES, SELF_SCOPED_CAPABILITIES, minTierForCapability as policyMinTierForCapability } from "./policy.js";

// Bumped from 1 to 2: subcommand.route (a single string) became
// subcommand.routes (an array) for every (group, subcommand) pair that
// fans out to more than one backing adapter route -- a breaking shape
// change for any future consumer that assumed one route per subcommand
// (see the DISCORD_CATALOG_PROTOCOL_VERSION comment in adapter.js: bump on
// "a field is removed or its meaning changes", not on ordinary additions).
// Ports the same fix already merged upstream via
// Red-Blink/dune-awakening-selfhost-docker#171 (issue #358) to this fork's
// `main`, which has its own superset of routes (the multi-account
// players/accounts/* family) not present on that upstream PR branch --
// see issue #360. No live consumer exists yet (Phase 2/3 bot-side
// generator is still unimplemented -- confirmed via grep across
// the bot repo's src/), so this bump is forward hygiene, not a
// fix for an active breakage.
export const CATALOG_VERSION = 2;

// Minimum Discord role tier able to invoke each capability. Delegates
// directly to policy.js's minTierForCapability() (added alongside this file
// specifically so this catalog would not need to hand-maintain a second,
// parallel copy of CAPABILITY_BY_TIER's shape -- see policy.js's own
// comment on minTierForCapability for why). This function exists only to
// add the one behavior policy.js's version deliberately does NOT have:
// self-scoped capabilities (PLAYER_LINK_WRITE, ACCOUNT_LINK_WRITE) are
// excluded from every tier's CAPABILITY_BY_TIER set (they're authorized by
// identity via requireSelfScopedCapability(), not the tier ladder -- see
// policy.js's SELF_SCOPED_CAPABILITIES comment), so
// policyMinTierForCapability() correctly returns null for them. For catalog
// display purposes, null would be misleading (it could read as "no tier
// requirement / public"), so self-scoped capabilities are reported as
// "observer" here -- the actual floor requireSelfScopedCapability() itself
// enforces (rejects "public"-tier actors, i.e. any actor with zero
// configured roles) -- so catalog consumers don't mistake these for
// anonymous-accessible routes. This is a presentation-layer decision made
// once, here, not a second source of truth for tier-grant data itself.
function minTierForCapability(capability) {
  // VERSION is the one live route with no real capability check at all
  // (routeEnforcesCapability: false below) -- capability is recorded as
  // null rather than a guessed value, and null has no meaningful tier.
  if (!capability) return null;
  if (SELF_SCOPED_CAPABILITIES.has(capability)) return "observer";
  return policyMinTierForCapability(capability);
}

// One entry per DISCORD_LIVE_ADAPTER_ROUTES member. Keys are route path
// strings (DISCORD_ADAPTER_ROUTES.* values), not route constant names, so
// COMMAND_CATALOG_ASSERT can validate coverage by iterating
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
// explicitly.
//
// params[].bodyField: the real JSON body field name routes.js actually
// reads for this param, when it differs from the param's own Discord-
// facing `name`. Defaults to the param's own `name` when omitted. Found
// via upstream PR #171's review (issue #358): PLAYERS_LINK
// ("character" -> body.characterName) and PLAYERS_INVENTORY_SEARCH
// ("search" -> body.query); ALSO applies to two multi-account-only
// entries this fork's main has beyond that upstream branch:
// PLAYERS_ACCOUNTS_LINK ("character" -> body.characterName) and
// PLAYERS_ACCOUNTS_UNLINK/PLAYERS_ACCOUNTS_SET_DEFAULT ("character" ->
// body.playerControllerId) -- see each entry's own comment below.
//
// Six (group, subcommand) pairs intentionally fan out to two backing
// routes each -- three shared with the upstream PR #171 branch
// (storage/find/inventory, confirmed live against the bot repo's
// real commands.js) plus three specific to this fork's multi-account
// superset (link/verify/unlink). Each fanned-out route entry carries its
// own `selector` describing which param/value or param-presence picks it;
// the entry with `selector: null` is the default used when no other
// selector in the pair matches. See issue #360 for the full audit of
// which of the multi-account routes are genuinely live vs. dead
// (PLAYERS_ACCOUNTS_LINK/LINK_VERIFY/SET_DEFAULT have NO live bot caller
// today -- routeHasNoCurrentBotCaller: true, unchanged from #342 -- but
// are kept in the catalog per this file's own Phase 1 scope of
// "describe what's live on Core," and are NOT given a fan-out `selector`
// since there is no real single subcommand picking between them and
// their single-account counterpart).
// Exported (not just module-private) so discordCommandCatalog.test.js can
// cross-check every declared field/bodyField against buildCommandCatalog()'s
// real output and against routes.js's real body.<field> reads, without
// re-deriving or hand-retyping this table a second time inside the test.
export const COMMAND_METADATA = Object.freeze({
  [DISCORD_ADAPTER_ROUTES.HEALTH]: {
    group: "server", subcommand: "health",
    description: "Check the console Discord adapter.",
    // HEALTH has no requireDiscordCapability() call -- discordAdapterHealth()
    // (adapter.js) never checks a capability. Recorded as STATUS_READ for
    // display purposes (matching the bot's own health command's stated
    // minimum role), but routeEnforcesCapability: false makes clear that
    // is not actually enforced by this specific route -- the same L3
    // integration-audit finding already fixed on the upstream PR #171
    // branch (Red-Blink/dune-awakening-selfhost-docker#171), ported here
    // since main's discordAdapterHealth() has the identical gap.
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
    // Description corrected 2026-08-18 (Layer 2 audit, UI hat finding): the
    // route handler (routes.js) runs `dune ready` -- the exact same
    // underlying command READINESS already runs -- and returns raw
    // readiness output. It does NOT read a maintenance note/window from
    // anywhere. The bot's own commands.js carries the same inaccurate
    // "(read-only)" maintenance-note/window description (verified against
    // arrakis-control-panel @ 8f3d3ed) -- this is a pre-existing, cross-repo
    // description/behavior mismatch, not introduced by this file. Recorded
    // here as what the route ACTUALLY does, not what its name/prior
    // description implied, since this catalog entry is now the mechanically
    // asserted source of truth Phase 2/3 will eventually surface to users.
    // Tracked: yacketrj/dune-awakening-selfhost-docker#338 (bot-side
    // commands.js description also needs the same correction).
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
    // the bot's own DISCORD_CAPABILITIES.BACKUPS_READ exists to describe,
    // but this is NOT enforced per-actor by this specific route today --
    // flagged here rather than silently assumed, so a future reviewer can
    // decide whether that's intentional (metadata-only, low sensitivity)
    // or a gap to close in a separate issue.
    capability: DISCORD_CAPABILITIES.BACKUPS_READ,
    routeEnforcesCapability: false,
    method: "GET",
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
      // routes.js reads body.characterName, not body.character -- same
      // mismatch upstream PR #171's review found (issue #358).
      { name: "character", bodyField: "characterName", type: "STRING", required: true, description: "Your character name." }
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
  // Fan-out pair (issue #360): the bot registers ONE real "unlink"
  // subcommand under group "player" (commands.js) with an OPTIONAL
  // "character" option ("Player controller ID... omit to unlink your
  // single-link character"); at runtime it calls PLAYERS_UNLINK when
  // omitted (the default) or PLAYERS_ACCOUNTS_UNLINK when a
  // playerControllerId is given (verified directly against
  // the bot repo's real commands.js key "player:unlink"). This
  // is a genuine one-subcommand-fans-out-to-two-routes case, the same
  // shape as the storage/find/inventory pairs already fixed on the
  // upstream PR #171 branch (issue #358) -- NOT a naming collision to
  // rename away.
  [DISCORD_ADAPTER_ROUTES.PLAYERS_UNLINK]: {
    group: "player", subcommand: "unlink",
    description: "Unlink your character from your Discord (single-link flow).",
    capability: DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
    selfScoped: true,
    selector: null,
    params: []
  },
  // routeHasNoCurrentBotCaller (issue #342, found during an independent
  // re-audit of #337/PR #341): this route is genuinely live on Core (a
  // real handler, a real provider -- see linkAccountProvider() in
  // routes.js) but no slash command in the bot repo calls it
  // today (verified directly against arrakis-control-panel @ 8f3d3ed --
  // grep for "players-accounts-link" across that repo's src/ finds no
  // caller, re-confirmed during issue #360's audit). UNLIKE
  // PLAYERS_ACCOUNTS_UNLINK below, there is no real bot subcommand that
  // ever fans out to this route, so it is NOT modeled as a fan-out pair
  // with PLAYERS_LINK -- it would collide on subcommand "link" with no
  // genuine picking mechanism behind it. Renamed to "link-account",
  // following the exact precedent PLAYERS_ACCOUNTS_LINK_STEAM below
  // already sets (subcommand "link-steam", not "link") for a
  // same-group, no-live-caller, no-fan-out multi-account variant.
  [DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK]: {
    group: "player", subcommand: "link-account",
    description: "(Not yet exposed as a bot command.) Core route to link an additional character to a Discord account (multi-account).",
    capability: DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
    selfScoped: true,
    routeHasNoCurrentBotCaller: true,
    params: [
      // routes.js reads body.characterName, not body.character.
      { name: "character", bodyField: "characterName", type: "STRING", required: true, description: "Character name to link." }
    ]
  },
  // See PLAYERS_ACCOUNTS_LINK's comment above -- same finding (#342),
  // same verification method, no bot-side caller for this route either.
  // Renamed to "verify-account" for the same reason ("verify" would
  // otherwise collide with PLAYERS_LINK_VERIFY's real, live subcommand
  // with no genuine fan-out behind it).
  [DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK_VERIFY]: {
    group: "player", subcommand: "verify-account",
    description: "(Not yet exposed as a bot command.) Core route to verify a pending additional-account link with a code.",
    capability: DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
    selfScoped: true,
    routeHasNoCurrentBotCaller: true,
    params: [
      { name: "code", type: "STRING", required: true, description: "Verification code from in-game whisper." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_UNLINK]: {
    group: "player", subcommand: "unlink",
    description: "Unlink one additional character from your Discord.",
    capability: DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
    selfScoped: true,
    selector: { param: "character", present: true },
    params: [
      // routes.js reads body.playerControllerId, not body.character --
      // the Discord-facing option is still named "character" (it accepts
      // a player-controller ID string, per the description), but the
      // wire field name differs.
      { name: "character", bodyField: "playerControllerId", type: "STRING", required: false, description: "Player controller ID from /dune player characters." }
    ]
  },
  [DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LIST]: {
    group: "player", subcommand: "characters",
    description: "List your verified characters.",
    capability: DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
    selfScoped: true,
    params: []
  },
  // routeHasNoCurrentBotCaller (issue #342): unlike PLAYERS_ACCOUNTS_LINK/
  // LINK_VERIFY above, this one is not merely uncalled -- the bot's real,
  // live "/dune player default" command (commands.js, key "player:default")
  // calls a DIFFERENT route entirely: guildGrantsDefault() ->
  // "guild-grants-default" -> /api/integrations/discord/guild-character-grants/default,
  // which does not exist anywhere in Core today (see linkProvider.js's own
  // comment: "Core's currently-nonexistent guild-character-grants
  // feature"). An earlier version of this entry's description was
  // verbatim-identical to that unrelated bot command's real description
  // ("Set your default character for this guild"), which would have made
  // a future Phase 2 generator conflate this uncalled multi-account route
  // with the bot's real, differently-routed default-character command.
  // Corrected to describe only what THIS route actually does.
  [DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_SET_DEFAULT]: {
    group: "player", subcommand: "default",
    description: "(Not yet exposed as a bot command -- do not confuse with the live \"/dune player default\" command, which calls a separate, currently-nonexistent-on-Core guild-character-grants route.) Core route to change which linked character is the default for a Discord account.",
    capability: DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
    selfScoped: true,
    routeHasNoCurrentBotCaller: true,
    params: [
      // routes.js reads body.playerControllerId, not body.character.
      { name: "character", bodyField: "playerControllerId", type: "STRING", required: true, description: "Character link ID." }
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
  // Fan-out pair (shared with upstream PR #171/issue #358): the bot
  // registers ONE real "storage" subcommand under group "player"
  // (commands.js) with a scope choice ("owned"/"guild"); at runtime it
  // calls PLAYERS_STORAGE for scope=owned (the default) or GUILD_STORAGE
  // for scope=guild. Two different capabilities/tiers are genuinely
  // enforced depending on which route is selected (STORAGE_READ vs
  // GUILD_READ).
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
  // Fan-out pair (shared with upstream PR #171/issue #358): same pattern
  // as storage above -- one real "find" subcommand, scope-selected
  // between PLAYERS_FIND (owned, default) and GUILD_FIND (guild).
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
  // Fan-out pair (shared with upstream PR #171/issue #358): one real
  // "inventory" subcommand under group "player" with an optional "search"
  // string option. The bot calls PLAYERS_INVENTORY_SEARCH when search is
  // present, else PLAYERS_INVENTORY -- selected by param PRESENCE, not a
  // value match (`present: true` instead of `equals`). Same capability
  // either way (INVENTORY_READ).
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
      // routes.js reads body.query, not body.search.
      { name: "search", bodyField: "query", type: "STRING", required: false, description: "Filter by item name (optional)." }
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

// Builds the catalog payload, asserting full, exact coverage against the
// live-route list in both directions:
//   1. every live route has a metadata entry (nothing silently missing
//      from the catalog), and
//   2. every metadata entry corresponds to a currently-live route (nothing
//      stale left behind after a route is retired).
// Throws synchronously on either violation -- this is the mechanism that
// replaces the bot's manual reconciliation process with a build-time/
// request-time failure Core's own test suite catches immediately.
//
// liveRoutes/metadata parameters default to the real, production data
// (DISCORD_LIVE_ADAPTER_ROUTES, COMMAND_METADATA) and exist ONLY so
// discordCommandCatalog.test.js can inject a deliberately mismatched pair
// and assert the throw actually fires -- see that file's "throws when a
// live route is missing metadata" / "throws when a metadata entry is
// stale" tests. No production call site should ever pass these explicitly;
// the route handler in routes.js calls buildCommandCatalog() with no
// arguments, exactly as before.
//
// The zero-argument (production) call path is memoized -- DISCORD_LIVE_
// ADAPTER_ROUTES and COMMAND_METADATA are both frozen, load-time-constant
// module data that never changes for the lifetime of a running process, so
// recomputing the coverage assertion and group composition on every GET
// /catalog request is pure wasted work. Memoization is skipped entirely
// when either argument is explicitly passed (the test-injection path),
// so injected test data is never cached across calls.
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

  // groups: group name -> (subcommand name -> array of route entries). A
  // subcommand normally has exactly one route entry; the 6 documented
  // fan-out pairs above (storage/find/inventory shared with upstream PR
  // #171, plus link/verify/unlink specific to this fork's multi-account
  // superset -- see issue #360) produce two.
  const groups = new Map();
  for (const route of liveRoutes) {
    // Destructure-and-spread (not a hand-picked allowlist): every field
    // NOT explicitly named below survives into the output route entry
    // automatically via `...rest` -- this is the fix for the
    // diagnosticCapability-silently-dropped bug already fixed upstream
    // (Red-Blink/dune-awakening-selfhost-docker#171, issue #358), ported
    // here since main's version of buildCommandCatalog() had the same
    // allowlist bug -- confirmed it was ALSO silently dropping
    // disabledPendingSecurityReview (defined on PLAYERS_ACCOUNTS_LINK_STEAM,
    // a field that doesn't exist at all on the upstream PR #171 branch).
    // Only fields that need renaming (group/subcommand, consumed into the
    // Map keys below rather than copied verbatim) or type coercion
    // (selfScoped, requiresWritesEnabled, routeEnforcesCapability,
    // routeHasNoCurrentBotCaller -- all intentionally normalized to a
    // real boolean, undefined -> false, not left as undefined) are named
    // explicitly and excluded from `rest`.
    const {
      group, subcommand, capability, selfScoped, requiresWritesEnabled,
      routeEnforcesCapability, routeHasNoCurrentBotCaller, method, params, ...rest
    } = metadata[route];
    const routeEntry = {
      ...rest,
      route,
      capability,
      minTier: minTierForCapability(capability),
      // Conditional capabilities need their own tier on the wire. A bot
      // cannot derive this from diagnosticCapability alone because the
      // Core policy table is not otherwise part of the catalog response.
      // Ports Red-Blink's post-merge fix on the upstream PR #171 branch
      // (commit 144aa84d, recorded in issue #370) to main's copy of this
      // function, which has the identical gap.
      ...(rest.diagnosticCapability
        ? { diagnosticMinTier: minTierForCapability(rest.diagnosticCapability) }
        : {}),
      method: method || "POST",
      selfScoped: Boolean(selfScoped),
      requiresWritesEnabled: Boolean(requiresWritesEnabled),
      routeEnforcesCapability: routeEnforcesCapability !== false,
      routeHasNoCurrentBotCaller: Boolean(routeHasNoCurrentBotCaller),
      // bodyField defaults to the param's own Discord-facing name when
      // not explicitly overridden.
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
