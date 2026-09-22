import { timingSafeEqual } from "node:crypto";
import { readPlayerAnnouncements } from "../../services/playerAnnouncements.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "../../audit.js";
import { parseBackupListRows } from "../../statusParsers.js";
import {
  discordAdapterEnabled, discordAdapterErrorResponse, discordAdapterHealth,
  discordAdapterPopulation, discordAdapterReadiness, discordAdapterServices,
  discordAdapterStatus, discordWritesEnabled, DISCORD_ADAPTER_ROUTES, DISCORD_PLANNED_ADAPTER_ROUTES,
  DISCORD_CATALOG_PROTOCOL_VERSION, validateDiscordActor, discordRoleMappingFromEnv
} from "./adapter.js";
import { buildCommandCatalog } from "./commandCatalog.js";
import { discordActorTier, policyError, requireDiscordCapability, requireSelfScopedCapability, DISCORD_CAPABILITIES } from "./policy.js";
import { discordStatusProvider } from "./statusProvider.js";
import { discordReadinessProvider, discordServicesProvider } from "./readOnlyProviders.js";
import {
  opsActivityProvider, opsCombatProvider, opsResourcesProvider,
  opsEconomyProvider, opsInventoryProvider, opsLocationProvider,
  opsSocProvider, opsPrometheusProvider, opsDashboardProvider
} from "./opsProvider.js";
import {
  linkPlayerProvider,
  verifyPlayerLinkProvider,
  unlinkProvider,
  whoamiProvider,
  playerFactionProvider,
  guildFactionSummaryProvider,
  requireLinkedPlayer
} from "./linkProvider.js";
import {
  linkAccountProvider,
  verifyAccountLinkProvider,
  unlinkAccountProvider,
  listAccountsProvider,
  setDefaultAccountProvider,
  linkAccountViaSteamProvider,
  guildGrantsEnableProvider,
  guildGrantsDisableProvider,
  guildGrantsDefaultProvider
} from "./multiAccountLinkProvider.js";
import { verifyActorSignature, actorSignatureRequired } from "./actorSignature.js";
import {
  playerInventoryProvider,
  playerStorageProvider,
  itemSearchProvider,
  inventorySearchProvider
} from "./inventoryProvider.js";
import { broadcastProvider } from "./broadcastProvider.js";
import { itemAuditLogProvider } from "./itemAuditLogProvider.js";
import { coriolisCycleProvider } from "./coriolisProvider.js";
import { resolveCoriolisCycle } from "../../services/coriolisSeed.js";
import { sietchAtlasProvider } from "./atlasProvider.js";
import { buildSietchAtlas } from "../../services/sietchAtlas.js";
import { cheaterTrackingProvider } from "./trustVettingProvider.js";
import { buildDuneArgs, runDockerLogs, runDune, validateServiceName } from "../../runner.js";
import { sanitizeDiscordValue } from "./sanitize.js";
import { initializeDiscordAdapterSchema } from "./schema.js";
import { WRITE_BRIDGE_SIGNED_ACTOR_FIELDS } from "./actorSignature.js";
import { meetsMinTier } from "./writeActionMinTier.js";
import { resolveWriteActionRoute } from "./writeActionRoutes.js";
import { getWriteNonceStore } from "./writeBridgeState.js";
import { callWriteBridgeInternalRoute } from "./writeBridgeInternalClient.js";

export const WRITE_BRIDGE_SOCKET_FILENAME = "discord-write-bridge.sock";

// Issue #1019: how long a dual-confirmation action's nonce stays valid after
// its FIRST confirmation, waiting for a second, distinct admin -- longer
// than the general single-confirmation TTL (60-90s) since coordinating a
// second human is slower than one person clicking a button.
const DUAL_CONFIRMATION_EXTENDED_TTL_SECONDS = 300;

const INFRA_OPERATIONS = Object.freeze({
  SERVERS: { operation: "servers", timeoutMs: 15000, capability: DISCORD_CAPABILITIES.SERVICES_READ },
  PORTS: { operation: "ports", timeoutMs: 15000, capability: DISCORD_CAPABILITIES.SERVICES_READ },
  DB: { operation: "dbStatus", timeoutMs: 15000, capability: DISCORD_CAPABILITIES.SERVICES_READ }
});

async function handleSecureInfraRoute({ key, config, json, res, actor }) {
  const op = INFRA_OPERATIONS[key];
  if (!op) throw policyError("not_found", "Unsupported infrastructure operation.", 404);
  const mapping = discordRoleMappingFromEnv();
  requireDiscordCapability(actor, mapping, op.capability);
  const result = await runDune(config, buildDuneArgs(op.operation), {
    timeoutMs: op.timeoutMs,
    allowedExitCodes: [0]
  });
  return json(res, 200, {
    ok: true,
    operation: op.operation,
    result: { output: (result.stdout || "").slice(0, 4000) }
  });
}

async function defaultPopulationProvider(config) {
  try {
    const status = await discordStatusProvider(config);
    const population = status?.population;
    if (population !== undefined) return parsePopulationValue(population);

    // Fallback: scan raw status for population-like fields
    if (status && typeof status === "object") {
      for (const [key, val] of Object.entries(status)) {
        if (/pop/i.test(key) && typeof val === "string") {
          return parsePopulationValue(val);
        }
        if (typeof val === "object" && val !== null) {
          for (const [k2, v2] of Object.entries(val)) {
            if (/pop/i.test(k2) && typeof v2 === "string") {
              return parsePopulationValue(v2);
            }
          }
        }
      }
    }
    return { onlinePlayers: "unknown", totalPlayers: "unknown", aggregate: true, detailsSuppressed: true };
  } catch {
    return { onlinePlayers: "unknown", totalPlayers: "unknown", aggregate: true, detailsSuppressed: true };
  }
}

function parsePopulationValue(value = "") {
  const text = String(value).trim();
  const match = text.match(/(\d+)\s*\/?\s*(\d+)/);
  if (match) return { onlinePlayers: Number(match[1]), totalPlayers: match[2] ? Number(match[2]) : 0, aggregate: true, detailsSuppressed: true };
  const num = Number(text);
  if (Number.isFinite(num)) return { onlinePlayers: num, totalPlayers: 0, aggregate: true, detailsSuppressed: true };
  return { onlinePlayers: "unknown", totalPlayers: "unknown", aggregate: true, detailsSuppressed: true };
}

function boundedEnvInt(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

async function runOpsProvider(db, timeoutMs, provider) {
  if (!db || typeof db.transaction !== "function") return provider(db);
  return db.transaction(async (tx) => {
    await tx.query("select set_config('statement_timeout', $1, true)", [`${timeoutMs}ms`]);
    return provider(tx);
  });
}

export function isDiscordAdapterRoute(path) {
  return Object.values(DISCORD_ADAPTER_ROUTES).includes(path);
}

export async function handleDiscordAdapterRoute({
  req, res, path, config, readJson, json, db,
  statusProvider, readinessProvider, servicesProvider, populationProvider,
  commandRunner = runDune,
  dockerLogsRunner = runDockerLogs,
  announcementsProvider = readPlayerAnnouncements,
  coriolisCycleResolver = resolveCoriolisCycle,
  sietchAtlasBuilder = buildSietchAtlas
}) {
  const safeStatusProvider = typeof statusProvider === "function" ? statusProvider : () => discordStatusProvider(config);
  const safeReadinessProvider = typeof readinessProvider === "function" ? readinessProvider : () => discordReadinessProvider(config);
  const safeServicesProvider = typeof servicesProvider === "function" ? servicesProvider : () => discordServicesProvider(config);
  const safePopulationProvider = typeof populationProvider === "function" ? populationProvider : () => defaultPopulationProvider(config);

  // Reads the JSON body for a Discord adapter POST route and, when
  // DUNE_DISCORD_ACTOR_SECRET is configured, verifies that body.actor
  // carries a valid HMAC signature before any route handler trusts
  // actor.userId/actor.roleIds. See actorSignature.js (FINDING-LINK-1).
  // When `required` is true, the actor signature MUST be present and valid
  // regardless of whether DUNE_DISCORD_ACTOR_SECRET is configured. Used for
  // mutation routes (link, verify, unlink, steam-link).
  //
  // Issue #691 code-review finding (confirmed by 3 independent review
  // passes): actor.guildOwnerId is NOT part of actorSignature.js's
  // SIGNED_ACTOR_FIELDS -- a real, non-hypothetical gap, not just a
  // theoretical one: once DUNE_DISCORD_ACTOR_SECRET is configured, a party
  // able to capture/replay one legitimately-signed low-privilege envelope
  // (the freshness window already tolerates same-body/same-route replay --
  // see actorSignature.js's own "Known Limitations") could inject or alter
  // the UNSIGNED guildOwnerId field to match their own (signed) userId and
  // self-escalate to owner tier, since the signature never covers that
  // field. Strip it here, in the one place every route already passes
  // through, whenever this deployment has signing configured at all --
  // "trusted at the same level roleIds already is" is only true when
  // NOTHING is signed (nothing is worse off); the moment signing is on,
  // roleIds/userId gain real integrity and guildOwnerId must not silently
  // ride along with a weaker guarantee. Real guild-ownership recognition
  // for a signed deployment needs guildOwnerId properly added to
  // SIGNED_ACTOR_FIELDS (a separate, coordinated, versioned rollout across
  // both repos -- tracked, not done here); until then, signed deployments
  // fall back to the pre-existing DISCORD_OWNER_ROLE_IDS role mapping,
  // exactly as they did before this PR.
  async function readJsonWithActorSignature(request, { requireActorSignature = false, fields } = {}) {
    const body = await readJson(request);
    try {
      verifyActorSignature({ actorPayload: body?.actor, headers: request.headers, config, route: path, required: requireActorSignature, ...(fields ? { fields } : {}) });
    } catch (error) {
      // When a secret is configured: always throw (even for read routes).
      // When no secret: only throw for mutation routes (requireActorSignature).
      if (requireActorSignature || actorSignatureRequired(config)) throw error;
    }
    if (actorSignatureRequired(config) && body?.actor && typeof body.actor === "object") {
      delete body.actor.guildOwnerId;
    }
    return body;
  }
  try {
    if (!discordAdapterEnabled(config)) throw policyError("adapter_disabled", "Discord adapter is disabled.", 404);
    requireDiscordBotToken(req, config);

    if (path.startsWith("/api/integrations/discord/players/") || path.startsWith("/api/integrations/discord/guilds/")) {
      if (!db) throw policyError("database_unavailable", "Discord player data is unavailable.", 503);
      await initializeDiscordAdapterSchema(db);
    }

    if (path === DISCORD_ADAPTER_ROUTES.HEALTH && req.method === "GET") {
      return json(res, 200, await discordAdapterHealth(config));
    }

    // Command catalog (Phase 1 of docs/rfc-command-discovery.md, issue
    // #337). Bearer-token auth only (requireDiscordBotToken() above,
    // matching HEALTH) -- no actor signature, no per-capability check: this
    // is read-only metadata about route/command shape, not game or player
    // data, so it does not need per-actor tier enforcement the way an
    // actual data route does.
    if (path === DISCORD_ADAPTER_ROUTES.CATALOG && req.method === "GET") {
      return json(res, 200, { ok: true, protocolVersion: DISCORD_CATALOG_PROTOCOL_VERSION, catalog: buildCommandCatalog() });
    }

    if (path === DISCORD_ADAPTER_ROUTES.STATUS && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      return json(res, 200, await discordAdapterStatus({
        config,
        actorPayload: body.actor,
        diagnostic: Boolean(body.diagnostic),
        statusProvider: safeStatusProvider
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.READINESS && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      return json(res, 200, await discordAdapterReadiness({
        config,
        actorPayload: body.actor,
        readinessProvider: safeReadinessProvider
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.SERVICES && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      return json(res, 200, await discordAdapterServices({
        config,
        actorPayload: body.actor,
        servicesProvider: safeServicesProvider
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.POPULATION && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      return json(res, 200, await discordAdapterPopulation({
        config,
        actorPayload: body.actor,
        populationProvider: safePopulationProvider
      }));
    }

    const opsRoutes = {
      [DISCORD_ADAPTER_ROUTES.OPS_ACTIVITY]: { capability: DISCORD_CAPABILITIES.OPS_ACTIVITY_READ, provider: opsActivityProvider },
      [DISCORD_ADAPTER_ROUTES.OPS_COMBAT]: { capability: DISCORD_CAPABILITIES.OPS_COMBAT_READ, provider: opsCombatProvider },
      [DISCORD_ADAPTER_ROUTES.OPS_RESOURCES]: { capability: DISCORD_CAPABILITIES.OPS_RESOURCES_READ, provider: opsResourcesProvider },
      [DISCORD_ADAPTER_ROUTES.OPS_ECONOMY]: { capability: DISCORD_CAPABILITIES.OPS_ECONOMY_READ, provider: opsEconomyProvider },
      [DISCORD_ADAPTER_ROUTES.OPS_INVENTORY]: { capability: DISCORD_CAPABILITIES.OPS_INVENTORY_READ, provider: opsInventoryProvider },
      // Issue #1001 (R0 completion): opsLocationProvider() is a permanent
      // placeholder (see its own comment) -- queryBound: false since it
      // never touches db, same as soc/prometheus below.
      [DISCORD_ADAPTER_ROUTES.OPS_LOCATION]: { capability: DISCORD_CAPABILITIES.OPS_LOCATION_READ, provider: opsLocationProvider, queryBound: false },
      [DISCORD_ADAPTER_ROUTES.OPS_SOC]: { capability: DISCORD_CAPABILITIES.OPS_SOC_READ, provider: opsSocProvider, queryBound: false },
      [DISCORD_ADAPTER_ROUTES.OPS_PROMETHEUS]: { capability: DISCORD_CAPABILITIES.OPS_PROMETHEUS_READ, provider: opsPrometheusProvider, queryBound: false },
      // queryBound defaults to true (real transaction + statement_timeout) --
      // matches activity/combat/resources/economy/inventory above, not
      // soc/prometheus. opsDashboardProvider aggregates all eight sub-providers
      // internally, including soc/prometheus, which ignore the db/tx argument
      // they're handed regardless (see their own signatures) -- passing them a
      // transaction-scoped client instead of the raw pool has no effect, and
      // the six DB-backed sub-providers need the timeout protection.
      [DISCORD_ADAPTER_ROUTES.OPS_DASHBOARD]: { capability: DISCORD_CAPABILITIES.OPS_DASHBOARD_READ, provider: opsDashboardProvider }
    };

    if (opsRoutes[path] && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      const mapping = discordRoleMappingFromEnv();
      const route = opsRoutes[path];
      requireDiscordCapability(actor, mapping, route.capability);
      const timeoutMs = boundedEnvInt("DUNE_OPS_QUERY_TIMEOUT_MS", 5000, 250, 30000);
      const maxBytes = boundedEnvInt("DUNE_OPS_MAX_RESPONSE_BYTES", 65536, 1024, 1048576);
      const result = route.queryBound === false
        ? await route.provider(config, db)
        : await runOpsProvider(db, timeoutMs, (queryDb) => route.provider(config, queryDb));
      const response = Buffer.byteLength(JSON.stringify(result), "utf8") <= maxBytes
        ? result
        : { ok: false, _truncated: true, _maxBytes: maxBytes, error: "OPS response exceeded the configured size limit." };
      audit(config, req, "discord.ops", { route: path, userId: actor.userId, tier: discordActorTier(actor, mapping), ok: response.ok !== false });
      return json(res, 200, response);
    }

    // Broadcast route — gated behind write enablement, actor identity, and admin/owner capability.
    if (path === DISCORD_ADAPTER_ROUTES.BROADCAST && req.method === "POST") {
      if (!discordWritesEnabled(config)) throw policyError("writes_disabled", "Write operations are not enabled.", 403);
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      const mapping = discordRoleMappingFromEnv();
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.BROADCAST_SEND);
      const result = await broadcastProvider(config, { message: body.message });
      return json(res, 200, result);
    }

    // Announcement settings used by the companion bot's read-only status command.
    if (path === DISCORD_ADAPTER_ROUTES.ANNOUNCEMENTS && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, discordRoleMappingFromEnv(), DISCORD_CAPABILITIES.MAPS_READ);
      const announcements = await announcementsProvider(config);
      return json(res, 200, { ok: true, announcements: sanitizeDiscordValue(announcements) });
    }

    // Backup metadata only. No create, restore, delete, or filesystem paths.
    if (path === DISCORD_ADAPTER_ROUTES.BACKUPS_LIST && req.method === "GET") {
      const result = await commandRunner(config, buildDuneArgs("backupList"), {
        timeoutMs: 15000,
        allowedExitCodes: [0]
      });
      return json(res, 200, { ok: true, backups: parseBackupListRows(result.stdout || "").slice(0, 100) });
    }

    const mapping = discordRoleMappingFromEnv();

    // World Coriolis cycle (mentat#370, issue #942) -- public tier, no
    // per-player target, just the farm-wide storm seed/next-cycle timing.
    if (path === DISCORD_ADAPTER_ROUTES.WORLD_CORIOLIS && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.CORIOLIS_READ);
      return json(res, 200, await coriolisCycleProvider({ resolveCycle: coriolisCycleResolver }));
    }

    // #the-atlas (mentat#376, issue #938) -- public tier, per-sietch PvP/PvE
    // + live sandstorm status + the farm-wide Coriolis cycle.
    if (path === DISCORD_ADAPTER_ROUTES.WORLD_ATLAS && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.ATLAS_READ);
      return json(res, 200, await sietchAtlasProvider(config, db, { buildAtlas: sietchAtlasBuilder }));
    }

    // Players link
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_LINK && req.method === "POST") {
      const body = await readJsonWithActorSignature(req, { requireActorSignature: true });
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE);
      const linkResult = await linkPlayerProvider(db, config, {
        discordUserId: actor.userId,
        characterName: body.characterName
      });
      audit(config, req, "discord.player.link", { actorId: actor.userId, characterName: body.characterName, ok: linkResult.ok });
      return json(res, 200, linkResult);
    }

    // Players link verify
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_LINK_VERIFY && req.method === "POST") {
      const body = await readJsonWithActorSignature(req, { requireActorSignature: true });
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE);
      const verifyResult = await verifyPlayerLinkProvider(db, {
        discordUserId: actor.userId,
        code: body.code
      });
      audit(config, req, "discord.player.link.verify", { actorId: actor.userId, ok: verifyResult.ok });
      return json(res, 200, verifyResult);
    }

    // Players unlink
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_UNLINK && req.method === "POST") {
      const body = await readJsonWithActorSignature(req, { requireActorSignature: true });
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE);
      const unlinkResult = await unlinkProvider(db, {
        discordUserId: actor.userId
      });
      audit(config, req, "discord.player.unlink", { actorId: actor.userId, ok: unlinkResult.ok });
      return json(res, 200, unlinkResult);
    }

    // Multi-account: link an additional character (FINDING-LINK-6).
    // Distinct from PLAYERS_LINK above: this is additive (a Discord user
    // may hold several linked characters at once) rather than overwrite,
    // and uses its own capability/rate limiter — see
    // multiAccountLinkProvider.js and docs/security/discord-player-link-hardening.md.
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK && req.method === "POST") {
      const body = await readJsonWithActorSignature(req, { requireActorSignature: true });
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      audit(config, req, "discord.account.link", { actorId: actor.userId, characterName: body.characterName });
      return json(res, 200, await linkAccountProvider(db, config, {
        discordUserId: actor.userId,
        characterName: body.characterName
      }));
    }

    // Multi-account: verify a pending additional-account link
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK_VERIFY && req.method === "POST") {
      const body = await readJsonWithActorSignature(req, { requireActorSignature: true });
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      return json(res, 200, await verifyAccountLinkProvider(db, {
        discordUserId: actor.userId,
        code: body.code
      }));
    }

    // Multi-account: unlink one additional character (does not affect the
    // legacy single-link flow's console.discord_player_links entry, if any).
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_UNLINK && req.method === "POST") {
      const body = await readJsonWithActorSignature(req, { requireActorSignature: true });
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      audit(config, req, "discord.account.unlink", { actorId: actor.userId, playerControllerId: body.playerControllerId });
      return json(res, 200, await unlinkAccountProvider(db, {
        discordUserId: actor.userId,
        playerControllerId: body.playerControllerId
      }));
    }

    // Multi-account: list all characters linked to the calling Discord user
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LIST && req.method === "POST") {
      const body = await readJsonWithActorSignature(req, { requireActorSignature: true });
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      return json(res, 200, await listAccountsProvider(db, {
        discordUserId: actor.userId
      }));
    }

    // Multi-account: change which linked character is the default
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_SET_DEFAULT && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      return json(res, 200, await setDefaultAccountProvider(db, {
        discordUserId: actor.userId,
        playerControllerId: body.playerControllerId
      }));
    }

    // Guild grants (issue #696): per-(Discord guild, linked character)
    // enable/disable/default -- distinct from PLAYERS_ACCOUNTS_SET_DEFAULT
    // above, which sets a global-across-all-guilds default. A user who
    // shares this bot with multiple guilds/communities may want a
    // different active character per guild (e.g. one house's alt vs.
    // another's). guildId comes from actor.guildId (already required and
    // signature-verified by validateDiscordActor/actorSignature.js), not
    // a separate body field -- a caller cannot claim to be acting on
    // behalf of a guild it isn't actually in.
    if (path === DISCORD_ADAPTER_ROUTES.GUILD_GRANTS_ENABLE && req.method === "POST") {
      const body = await readJsonWithActorSignature(req, { requireActorSignature: true });
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      return json(res, 200, await guildGrantsEnableProvider(db, {
        discordUserId: actor.userId,
        guildId: actor.guildId,
        playerControllerId: body.characterLinkId
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.GUILD_GRANTS_DISABLE && req.method === "POST") {
      const body = await readJsonWithActorSignature(req, { requireActorSignature: true });
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      return json(res, 200, await guildGrantsDisableProvider(db, {
        discordUserId: actor.userId,
        guildId: actor.guildId,
        playerControllerId: body.characterLinkId
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.GUILD_GRANTS_DEFAULT && req.method === "POST") {
      const body = await readJsonWithActorSignature(req, { requireActorSignature: true });
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      return json(res, 200, await guildGrantsDefaultProvider(db, {
        discordUserId: actor.userId,
        guildId: actor.guildId,
        playerControllerId: body.characterLinkId
      }));
    }

    // Multi-account, Steam-OAuth-based: match a character's on-file Steam
    // ID against the caller's already-completed Discord OAuth connections
    // list, and link if it matches -- see linkAccountViaSteamProvider()'s
    // own comment for why the match-check and the link happen together in
    // one discordUserId-bound call rather than as two separate routes.
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK_STEAM && req.method === "POST") {
      // Steam linking is disabled pending OAuth binding (security review 2026-08-08).
      // The current implementation accepts playerControllerId and steamId64List directly
      // without validating a Discord OAuth token, verifying the Steam connection, or
      // binding the selected character to an OAuth state. Revisit when bot-side OAuth
      // can bind the Discord user ↔ Steam identity ↔ target character in one flow.
      return json(res, 200, { ok: false, status: "disabled", reason: "steam_linking_pending_oauth_binding", message: "Steam linking is temporarily disabled pending a security review. Use /dune data link while your character is online." });
    }

    // Players me
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ME && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.INVENTORY_READ);
      return json(res, 200, await whoamiProvider(db, {
        discordUserId: actor.userId
      }));
    }

    // Players faction (issue #696) -- read-only, auto-detected from the
    // caller's linked character's real dune.player_faction row. There is
    // deliberately no argument to set/pick a faction; this route only
    // ever reflects real game state, never writes to it.
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_FACTION && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.INVENTORY_READ);
      return json(res, 200, await playerFactionProvider(db, {
        discordUserId: actor.userId
      }));
    }

    // Players inventory
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_INVENTORY && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.INVENTORY_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      return json(res, 200, await playerInventoryProvider(db, {
        playerPawnId: linked.player_pawn_id,
        characterName: linked.character_name
      }));
    }

    // Players storage
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_STORAGE && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.STORAGE_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      const scope = body.scope || "owned";
      if (scope !== "owned" && scope !== "guild") {
        throw policyError("invalid_scope", 'Storage scope must be "owned" or "guild".');
      }
      return json(res, 200, await playerStorageProvider(db, {
        playerControllerId: linked.player_controller_id,
        scope
      }));
    }

    // Players find (item search in containers)
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_FIND && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.INVENTORY_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      const scope = body.scope || "owned";
      if (scope !== "owned" && scope !== "guild") {
        throw policyError("invalid_scope", 'Search scope must be "owned" or "guild".');
      }
      return json(res, 200, await itemSearchProvider(db, {
        playerControllerId: linked.player_controller_id,
        query: body.query,
        scope
      }));
    }

    // Players inventory search
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_INVENTORY_SEARCH && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.INVENTORY_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      return json(res, 200, await inventorySearchProvider(db, {
        playerPawnId: linked.player_pawn_id,
        query: body.query
      }));
    }

    // Players cheater tracking (meta#64, mentat#361) -- staff-only trust-role
    // vetting signal, deliberately NOT self-scoped: body.actorId names the
    // applicant under review, not the calling staff member's own character.
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_CHEATER_TRACKING && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.CHEATER_TRACKING_READ);
      if (!body.actorId) {
        throw policyError("missing_actor_id", "actorId (the target player's dune.actors id) is required.");
      }
      const response = await cheaterTrackingProvider(db, { actorId: body.actorId });
      audit(config, req, "discord.trust.cheater_tracking_read", {
        actorId: actor.userId,
        targetActorId: body.actorId,
        flagCount: response.count
      });
      return json(res, 200, response);
    }

    // Players item-audit-log (meta#64, mentat#368) -- staff/system
    // stolen-goods cross-reference signal, deliberately NOT self-scoped:
    // body.actorId names the player under investigation, not the calling
    // actor's own character.
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ITEM_AUDIT_LOG && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.ITEM_AUDIT_LOG_READ);
      if (!body.actorId) {
        throw policyError("missing_actor_id", "actorId (the target player's dune.actors id) is required.");
      }
      const response = await itemAuditLogProvider(db, { actorId: body.actorId, windowHours: body.windowHours, limit: body.limit });
      audit(config, req, "discord.trust.item_audit_log_read", {
        actorId: actor.userId,
        targetActorId: body.actorId,
        windowHours: response.windowHours,
        rowCount: response.count
      });
      return json(res, 200, response);
    }

    // Guild storage
    if (path === DISCORD_ADAPTER_ROUTES.GUILD_STORAGE && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.GUILD_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      return json(res, 200, await playerStorageProvider(db, {
        playerControllerId: linked.player_controller_id,
        scope: "guild"
      }));
    }

    // Guild find (item search in guild containers)
    if (path === DISCORD_ADAPTER_ROUTES.GUILD_FIND && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.GUILD_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      return json(res, 200, await itemSearchProvider(db, {
        playerControllerId: linked.player_controller_id,
        query: body.query,
        scope: "guild"
      }));
    }

    // Guild faction summary (issue #699) -- tallies each linked player's
    // real IN-GAME GUILD's faction (not their own personal faction -- see
    // getGuildFactionTally()'s own comment in duneDb.js), for the bot's
    // own per-Discord-server themed-embed faction auto-sync. Same
    // GUILD_READ tier as guild storage/find above.
    if (path === DISCORD_ADAPTER_ROUTES.GUILD_FACTION_SUMMARY && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.GUILD_READ);
      if (!Array.isArray(body.discordUserIds)) {
        throw policyError("invalid_request", "discordUserIds must be an array.");
      }
      return json(res, 200, await guildFactionSummaryProvider(db, {
        discordUserIds: body.discordUserIds
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.SERVERS && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      return handleSecureInfraRoute({ key: "SERVERS", config, json, res, actor });
    }
    if (path === DISCORD_ADAPTER_ROUTES.PORTS && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      return handleSecureInfraRoute({ key: "PORTS", config, json, res, actor });
    }
    if (path === DISCORD_ADAPTER_ROUTES.DB && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      return handleSecureInfraRoute({ key: "DB", config, json, res, actor });
    }

    if (path === DISCORD_ADAPTER_ROUTES.VERSION && req.method === "GET") {
      return json(res, 200, { ok: true, version: config.version || "dev" });
    }

    if (path === DISCORD_ADAPTER_ROUTES.MAINTENANCE && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.READINESS_READ);
      const result = await commandRunner(config, buildDuneArgs("readiness"), {
        timeoutMs: 15000,
        allowedExitCodes: [0, 1]
      });
      return json(res, 200, { ok: result.code === 0, output: cappedOutput(result.stdout || result.stderr) });
    }

    if (path === DISCORD_ADAPTER_ROUTES.LOGS && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.LOGS_READ);
      const service = validateServiceName(body.service);
      const result = await dockerLogsRunner(service, { tail: 100, timeoutMs: 10000 });
      const lines = sanitizeDiscordValue(`${result.stdout || ""}${result.stderr || ""}`)
        .split(/\r?\n/).filter(Boolean).slice(-50);
      return json(res, 200, { ok: true, service, lines });
    }

    if (path === DISCORD_ADAPTER_ROUTES.MAP_STATE && req.method === "POST") {
      const body = await readJsonWithActorSignature(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.MAPS_READ);
      const result = await commandRunner(config, buildDuneArgs("mapsList"), {
        timeoutMs: 15000,
        allowedExitCodes: [0]
      });
      const output = cappedOutput(result.stdout || result.stderr);
      return json(res, 200, { ok: true, maps: output.split(/\r?\n/).filter(Boolean), output });
    }

    if (path === DISCORD_ADAPTER_ROUTES.WRITE_PREVIEW && req.method === "POST") {
      return await writePreviewRoute({ req, res, json, readJsonWithActorSignature, config });
    }

    if (path === DISCORD_ADAPTER_ROUTES.WRITE_EXECUTE && req.method === "POST") {
      return await writeExecuteRoute({ req, res, json, readJsonWithActorSignature, config });
    }

    throw policyError("not_found", "Discord adapter route not found.", 404);
  } catch (error) {
    const response = discordAdapterErrorResponse(error);
    return json(res, response.statusCode, response.body);
  }
}

// write/preview: validates actor + capability + per-action tier, mints a
// single-use nonce binding this specific (actor, action, params), and
// returns it plus a minimal preview. Never mutates anything -- safe to call
// repeatedly (docs/rw-architecture.md section 3.5's "cheap to call
// repeatedly" framing, section 3.8's Eviction policy note).
async function writePreviewRoute({ req, res, json, readJsonWithActorSignature, config }) {
  if (!discordWritesEnabled(config)) throw policyError("writes_disabled", "Write operations are not enabled.", 403);
  const body = await readJsonWithActorSignature(req, { requireActorSignature: true, fields: WRITE_BRIDGE_SIGNED_ACTOR_FIELDS });
  const actor = validateDiscordActor(body.actor);
  const mapping = discordRoleMappingFromEnv();
  requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS);

  const action = String(body.action || "");
  let resolved;
  try {
    resolved = resolveWriteActionRoute(action, body.params);
  } catch (error) {
    throw policyError("invalid_parameters", error.message, 400);
  }
  if (!resolved) throw policyError("unknown_write_action", `Unknown write action: ${action}`, 400);

  const actorTier = discordActorTier(actor, mapping);
  if (!meetsMinTier(actorTier, action)) {
    throw policyError("not_authorized", `Discord actor is not authorized for ${action}.`, 403);
  }

  const store = getWriteNonceStore();
  const { nonce, expiresAt } = store.create({ actorUserId: actor.userId, action, params: body.params || {} });

  return json(res, 200, {
    ok: true,
    nonce,
    expiresAt,
    preview: { action, confirmPhrase: resolved.confirmPhrase }
  });
}

// write/execute: consumes the nonce, re-verifies actor signature + capability
// + tier (never trusts write/preview's own decision alone -- a fresh
// interaction may have arrived with stale/tampered claims), then performs
// the real mutation via Core's own internal loopback (Hop B, issue #215;
// see docs/rw-architecture.md section 3.1-3.4 for the design). For a
// dual-confirmation action (currently only server.stop, issue #1019), the
// nonce is peeked rather than eagerly consumed, so a second, distinct actor
// can independently pass every gate below before Hop B is ever reached --
// see the requiresDualConfirmation branch further down.
async function writeExecuteRoute({ req, res, json, readJsonWithActorSignature, config }) {
  if (!discordWritesEnabled(config)) throw policyError("writes_disabled", "Write operations are not enabled.", 403);
  const body = await readJsonWithActorSignature(req, { requireActorSignature: true, fields: WRITE_BRIDGE_SIGNED_ACTOR_FIELDS });
  const actor = validateDiscordActor(body.actor);
  const mapping = discordRoleMappingFromEnv();
  requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.WRITE_BRIDGE_ACCESS);

  const nonceValue = String(body.nonce || "");
  if (!nonceValue) throw policyError("missing_nonce", "A nonce from write/preview is required.", 400);

  const store = getWriteNonceStore();
  // Non-destructive lookup: a dual-confirmation action's primary call must
  // not consume the nonce (a second, different actor still needs it), so
  // consumption is deferred until the point every gate has actually passed
  // and Hop B is genuinely about to be invoked, for both single- and
  // dual-confirmation actions alike.
  const peeked = store.peek(nonceValue);
  if (!peeked) throw policyError("nonce_not_found", "Confirmation expired or was already used. Please re-run the command.", 410);

  const action = String(body.action || "");
  if (action !== peeked.action) {
    throw policyError("nonce_action_mismatch", "The action does not match what was previewed.", 409);
  }

  let resolved;
  try {
    resolved = resolveWriteActionRoute(action, peeked.params);
  } catch (error) {
    throw policyError("invalid_parameters", error.message, 400);
  }
  if (!resolved) throw policyError("unknown_write_action", `Unknown write action: ${action}`, 400);

  // A nonce belongs to exactly the actor who requested the preview -- never
  // to whoever happens to present it next (docs/rw-architecture.md section
  // 3.2's exact-actor-binding requirement) -- UNLESS this is a
  // dual-confirmation action's second call, where a DIFFERENT actor
  // presenting the same nonce is the entire point. `secondConfirmationRequired`
  // is only ever set by this function's own dual-confirmation branch below,
  // never by write/preview, so it can't be forged by a client-supplied field.
  const isDualConfirmSecondStep = resolved.requiresDualConfirmation && peeked.secondConfirmationRequired;
  if (isDualConfirmSecondStep) {
    if (peeked.actorUserId === actor.userId) {
      throw policyError("second_confirmation_same_actor", "A second, different administrator must confirm this action. The admin who confirmed first cannot also provide the second confirmation.", 403);
    }
  } else if (peeked.actorUserId !== actor.userId) {
    throw policyError("nonce_actor_mismatch", "This confirmation was not issued to you.", 403);
  }

  const actorTier = discordActorTier(actor, mapping);
  if (!meetsMinTier(actorTier, action)) {
    throw policyError("not_authorized", `Discord actor is not authorized for ${action}.`, 403);
  }

  // roleSnapshotAt freshness (docs/rw-architecture.md section 3.8): proves
  // the actor's roleIds were re-derived from Discord at (or near) confirm
  // time, not replayed from the original interaction's cached payload.
  // Number.isSafeInteger check must run BEFORE the comparison -- a
  // malformed value (NaN, string, undefined) makes Math.abs(now - NaN) also
  // NaN, and `NaN > maxRoleAgeSeconds` is always false in JavaScript,
  // silently PASSING instead of rejecting if this order were reversed.
  const roleSnapshotAt = actor.roleSnapshotAt;
  if (!Number.isSafeInteger(roleSnapshotAt) || roleSnapshotAt <= 0) {
    throw policyError("invalid_actor_signature", "Discord actor role snapshot timestamp is invalid.", 403);
  }
  // Deliberately its own env var, not DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS
  // (issue #1022, Security MEDIUM): that var bounds the generic HMAC-signature
  // anti-replay window for every Discord adapter route, an unrelated property
  // to "is this actor's re-derived role snapshot still current." Sharing one
  // knob would let an operator widen the general replay window for an
  // unrelated reason (e.g. bot/host clock drift) and silently widen the
  // acceptance window for stale, possibly-since-revoked elevated roles on
  // this codebase's highest-risk mutation path, with no separate control.
  const maxRoleAgeSeconds = Number(process.env.DUNE_DISCORD_WRITE_BRIDGE_ROLE_MAX_AGE_SECONDS) || 30;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - roleSnapshotAt) > maxRoleAgeSeconds) {
    throw policyError("stale_actor_signature", "Your role info expired. Please re-run the command.", 403);
  }

  // Dual-confirmation gate (issue #1019): a qualifying action's FIRST
  // write/execute call, from any one authorized actor, marks the nonce
  // pending a second confirmation and stops here -- Hop B is not reached,
  // nothing has mutated. The nonce is deliberately NOT consumed, and its TTL
  // is extended to give a second, distinct admin realistic time to act. The
  // second call (isDualConfirmSecondStep, checked above) falls through to
  // the real consume + Hop B dispatch below like any other action.
  if (resolved.requiresDualConfirmation && !peeked.secondConfirmationRequired) {
    const marked = store.markPendingSecondConfirmation(nonceValue, DUAL_CONFIRMATION_EXTENDED_TTL_SECONDS);
    if (!marked) throw policyError("nonce_not_found", "Confirmation expired or was already used. Please re-run the command.", 410);
    return json(res, 202, {
      ok: true,
      code: "second_confirmation_required",
      nonce: nonceValue,
      expiresAt: marked.expiresAt,
      message: "A second, different administrator must confirm this action before it will run. Ask another owner-tier admin to confirm using this same reference."
    });
  }

  // Real, final consumption -- for a single-confirmation action, this is its
  // only call; for a dual-confirmation action, this is its second call. A
  // failure here (already expired between the peek above and now) is
  // possible but rare; report it the same way every other "gone" nonce is
  // reported rather than as a 500.
  const entry = store.consume(nonceValue);
  if (!entry) throw policyError("nonce_not_found", "Confirmation expired or was already used. Please re-run the command.", 410);

  // Hop B: the internal loopback that actually performs the mutation
  // (docs/rw-architecture.md section 3.1-3.4). Reuses the real target route
  // handler completely unchanged -- never reimplements mutation logic.
  // Everything above this point is real, tested validation; nothing has
  // mutated anything until this exact call.
  const socketPath = join(config.generatedDir, WRITE_BRIDGE_SOCKET_FILENAME);
  const requestBody = { ...(entry.params || {}) };
  if (resolved.confirmPhrase) requestBody.confirmation = resolved.confirmPhrase;

  let internalResponse;
  try {
    internalResponse = await callWriteBridgeInternalRoute({
      socketPath,
      method: resolved.method,
      path: resolved.path,
      action,
      tier: actorTier,
      discordUserId: actor.userId,
      discordUsername: actor.username,
      body: requestBody
    });
  } catch (error) {
    // The socket subsystem itself is unreachable (disabled at startup --
    // root-UID refusal, a live-listener collision, etc.) or the internal
    // connection genuinely failed -- a distinct, honest 503, never a
    // silent success and never a generic 500 that would hide which layer
    // failed.
    throw policyError("write_backend_unavailable", "Write execution backend is temporarily unavailable.", 503);
  }

  return json(res, internalResponse.statusCode, internalResponse.body ?? { ok: internalResponse.statusCode < 400 });
}

function cappedOutput(value, maxChars = 12000) {
  return sanitizeDiscordValue(String(value || "")).slice(0, maxChars);
}

export function requireDiscordBotToken(req, config) {
  const expected = readDiscordBotApiToken(config);
  if (!expected) throw policyError("bot_token_not_configured", "Adapter credential is not configured.", 503);

  const actual = bearerToken(req?.headers?.authorization || req?.headers?.Authorization || "");
  if (!actual) throw policyError("missing_bot_token", "Missing adapter credential.", 401);
  if (!constantTimeStringEqual(actual, expected)) throw policyError("invalid_bot_token", "Invalid adapter credential.", 401);
}

export function readDiscordBotApiToken(config) {
  const directToken = process.env.DUNE_DISCORD_ADAPTER_TOKEN || config?.discordAdapterToken || "";
  if (directToken) return String(directToken).trim();
  const tokenFile = process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE || process.env.DUNE_BOT_API_TOKEN_FILE || config?.discordAdapterTokenFile || config?.discordBotApiTokenFile || "";
  if (!tokenFile) return "";
  try {
    return readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

function bearerToken(value) {
  const parts = String(value || "").split(/\s+/);
  return parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1].trim() : "";
}

function constantTimeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
