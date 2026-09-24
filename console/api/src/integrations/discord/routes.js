import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "../../audit.js";
import { readPlayerAnnouncements } from "../../services/playerAnnouncements.js";
import { parseBackupListRows } from "../../statusParsers.js";
import {
  discordAdapterEnabled, discordAdapterErrorResponse, discordAdapterHealth,
  discordAdapterPopulation, discordAdapterReadiness, discordAdapterServices,
  discordAdapterStatus, discordWritesEnabled, DISCORD_ADAPTER_ROUTES, DISCORD_PLANNED_ADAPTER_ROUTES,
  DISCORD_CATALOG_PROTOCOL_VERSION, validateDiscordActor, discordRoleMappingFromEnv
} from "./adapter.js";
import { buildCommandCatalog } from "./commandCatalog.js";
import { discordActorTier, policyError, requireDiscordCapability, DISCORD_CAPABILITIES } from "./policy.js";
import { discordStatusProvider } from "./statusProvider.js";
import { discordReadinessProvider, discordServicesProvider } from "./readOnlyProviders.js";
import {
  opsActivityProvider, opsCombatProvider, opsResourcesProvider,
  opsEconomyProvider, opsInventoryProvider,
  opsSocProvider, opsPrometheusProvider
} from "./opsProvider.js";
import {
  linkPlayerProvider,
  verifyPlayerLinkProvider,
  unlinkProvider,
  whoamiProvider,
  requireLinkedPlayer
} from "./linkProvider.js";
import {
  playerInventoryProvider,
  playerStorageProvider,
  itemSearchProvider,
  inventorySearchProvider
} from "./inventoryProvider.js";
import { broadcastProvider } from "./broadcastProvider.js";
import { buildDuneArgs, runDockerLogs, runDune, validateServiceName } from "../../runner.js";
import { sanitizeDiscordValue } from "./sanitize.js";
import { initializeDiscordAdapterSchema } from "./schema.js";
import { WRITE_BRIDGE_SIGNED_ACTOR_FIELDS, verifyActorSignature, actorSignatureRequired } from "./actorSignature.js";
import { meetsMinTier } from "./writeActionMinTier.js";
import { resolveWriteActionRoute } from "./writeActionRoutes.js";
import { getWriteNonceStore } from "./writeBridgeState.js";
import { callWriteBridgeInternalRoute } from "./writeBridgeInternalClient.js";

export const WRITE_BRIDGE_SOCKET_FILENAME = "discord-write-bridge.sock";

// How long a dual-confirmation action's nonce stays valid after its FIRST
// confirmation, waiting for a second, distinct admin -- longer
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
  announcementsProvider = readPlayerAnnouncements
}) {
  const safeStatusProvider = typeof statusProvider === "function" ? statusProvider : () => discordStatusProvider(config);
  const safeReadinessProvider = typeof readinessProvider === "function" ? readinessProvider : () => discordReadinessProvider(config);
  const safeServicesProvider = typeof servicesProvider === "function" ? servicesProvider : () => discordServicesProvider(config);
  const safePopulationProvider = typeof populationProvider === "function" ? populationProvider : () => defaultPopulationProvider(config);

  // Reads the JSON body for a Discord adapter POST route and, when
  // DUNE_DISCORD_ACTOR_SECRET is configured, verifies that body.actor
  // carries a valid HMAC signature before any route handler trusts
  // actor.userId/actor.roleIds. See actorSignature.js. When `required` is
  // true, the actor signature MUST be present and valid regardless of
  // whether DUNE_DISCORD_ACTOR_SECRET is configured -- used here for the
  // write bridge's write/preview and write/execute routes, which must
  // never trust an actor's tier/roles without a verified
  // signature (see WRITE_BRIDGE_SIGNED_ACTOR_FIELDS in actorSignature.js).
  //
  // [Layer 3 integration audit fix, CRITICAL] WRITE_BRIDGE_SIGNED_ACTOR_FIELDS
  // includes "action" specifically so the write bridge's signature binds the
  // actor to the SPECIFIC action being requested, not just to the route (both
  // write/preview and write/execute are the same one route for every action).
  // Before this fix, a captured, legitimately-signed envelope from a real
  // moderator+ actor could be replayed with a DIFFERENT action/params within
  // the freshness window and still verify -- meetsMinTier would then
  // evaluate the real actor's real tier against whatever action the replayed
  // request now claimed, up to and including server.stop for an owner-tier
  // envelope. body.action must be merged into the signed payload here,
  // before verification, since it lives alongside `actor` in the body, not
  // inside it -- and this repo's own bot-side counterpart (Project-Arrakis/
  // mentat's actorSignature.js) must sign the identical shape or every real
  // request fails verification (see that repo's own fix, same issue).
  async function readJsonWithActorSignature(request, { requireActorSignature = false, fields } = {}) {
    const body = await readJson(request);
    try {
      const actorPayload = fields?.includes("action") ? { ...body?.actor, action: body?.action } : body?.actor;
      verifyActorSignature({ actorPayload, headers: request.headers, config, route: path, required: requireActorSignature, ...(fields ? { fields } : {}) });
    } catch (error) {
      // When a secret is configured: always throw (even for read routes).
      // When no secret: only throw for mutation routes (requireActorSignature).
      if (requireActorSignature || actorSignatureRequired(config)) throw error;
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

    // Command catalog (Phase 1 of docs/rfc-command-discovery.md).
    // Bearer-token auth only (requireDiscordBotToken() above, matching
    // HEALTH) -- no actor signature, no per-capability check: this is
    // read-only metadata about route/command shape, not game or player
    // data, so it does not need per-actor tier enforcement the way an
    // actual data route does.
    if (path === DISCORD_ADAPTER_ROUTES.CATALOG && req.method === "GET") {
      return json(res, 200, { ok: true, protocolVersion: DISCORD_CATALOG_PROTOCOL_VERSION, catalog: buildCommandCatalog() });
    }

    if (path === DISCORD_ADAPTER_ROUTES.STATUS && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, await discordAdapterStatus({
        config,
        actorPayload: body.actor,
        diagnostic: Boolean(body.diagnostic),
        statusProvider: safeStatusProvider
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.READINESS && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, await discordAdapterReadiness({
        config,
        actorPayload: body.actor,
        readinessProvider: safeReadinessProvider
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.SERVICES && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, await discordAdapterServices({
        config,
        actorPayload: body.actor,
        servicesProvider: safeServicesProvider
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.POPULATION && req.method === "POST") {
      const body = await readJson(req);
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
      [DISCORD_ADAPTER_ROUTES.OPS_SOC]: { capability: DISCORD_CAPABILITIES.OPS_SOC_READ, provider: opsSocProvider, queryBound: false },
      [DISCORD_ADAPTER_ROUTES.OPS_PROMETHEUS]: { capability: DISCORD_CAPABILITIES.OPS_PROMETHEUS_READ, provider: opsPrometheusProvider, queryBound: false }
    };

    if (opsRoutes[path] && req.method === "POST") {
      const body = await readJson(req);
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
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      const mapping = discordRoleMappingFromEnv();
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.BROADCAST_SEND);
      const result = await broadcastProvider(config, { message: body.message });
      return json(res, 200, result);
    }

    // Announcement settings used by the companion bot's read-only status command.
    if (path === DISCORD_ADAPTER_ROUTES.ANNOUNCEMENTS && req.method === "POST") {
      const body = await readJson(req);
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

    // Players link
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_LINK && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE);
      return json(res, 200, await linkPlayerProvider(db, config, {
        discordUserId: actor.userId,
        characterName: body.characterName
      }));
    }

    // Players link verify
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_LINK_VERIFY && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE);
      return json(res, 200, await verifyPlayerLinkProvider(db, {
        discordUserId: actor.userId,
        code: body.code
      }));
    }

    // Players unlink
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_UNLINK && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE);
      return json(res, 200, await unlinkProvider(db, {
        discordUserId: actor.userId
      }));
    }

    // Players me
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ME && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.INVENTORY_READ);
      return json(res, 200, await whoamiProvider(db, {
        discordUserId: actor.userId
      }));
    }

    // Players inventory
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_INVENTORY && req.method === "POST") {
      const body = await readJson(req);
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
      const body = await readJson(req);
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
      const body = await readJson(req);
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
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.INVENTORY_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      return json(res, 200, await inventorySearchProvider(db, {
        playerPawnId: linked.player_pawn_id,
        query: body.query
      }));
    }

    // Guild storage
    if (path === DISCORD_ADAPTER_ROUTES.GUILD_STORAGE && req.method === "POST") {
      const body = await readJson(req);
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
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.GUILD_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      return json(res, 200, await itemSearchProvider(db, {
        playerControllerId: linked.player_controller_id,
        query: body.query,
        scope: "guild"
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.SERVERS && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      return handleSecureInfraRoute({ key: "SERVERS", config, json, res, actor });
    }
    if (path === DISCORD_ADAPTER_ROUTES.PORTS && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      return handleSecureInfraRoute({ key: "PORTS", config, json, res, actor });
    }
    if (path === DISCORD_ADAPTER_ROUTES.DB && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      return handleSecureInfraRoute({ key: "DB", config, json, res, actor });
    }

    if (path === DISCORD_ADAPTER_ROUTES.VERSION && req.method === "GET") {
      return json(res, 200, { ok: true, version: config.version || "dev" });
    }

    if (path === DISCORD_ADAPTER_ROUTES.MAINTENANCE && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.READINESS_READ);
      const result = await commandRunner(config, buildDuneArgs("readiness"), {
        timeoutMs: 15000,
        allowedExitCodes: [0, 1]
      });
      return json(res, 200, { ok: result.code === 0, output: cappedOutput(result.stdout || result.stderr) });
    }

    if (path === DISCORD_ADAPTER_ROUTES.LOGS && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.LOGS_READ);
      const service = validateServiceName(body.service);
      const result = await dockerLogsRunner(service, { tail: 100, timeoutMs: 10000 });
      const lines = sanitizeDiscordValue(`${result.stdout || ""}${result.stderr || ""}`)
        .split(/\r?\n/).filter(Boolean).slice(-50);
      return json(res, 200, { ok: true, service, lines });
    }

    if (path === DISCORD_ADAPTER_ROUTES.MAP_STATE && req.method === "POST") {
      const body = await readJson(req);
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
// repeatedly; the nonce store's own eviction policy bounds how many pending
// previews accumulate per actor.
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
  // meetsMinTier() must never be called unwrapped here, unlike
  // resolveWriteActionRoute() above and store.create() below (both
  // explicitly wrapped, for this exact same failure class). meetsMinTier()
  // throws a bare Error with no .statusCode when an action has no
  // WRITE_ACTION_MIN_TIER entry -- selfCheckWriteActionRoutes() only gates
  // whether the Hop-B socket starts, it never prevents write/preview from
  // being reachable, so this crash path was fully live even after the
  // boot-time self-check had already flagged the drift. A distinguishable
  // 500 (not the generic adapter_error a bare throw would produce) so
  // monitoring can tell "this action's own table is broken" apart from an
  // unrelated server bug.
  let authorized;
  try {
    authorized = meetsMinTier(actorTier, action);
  } catch (error) {
    throw policyError("write_action_misconfigured", "This write action is misconfigured. Contact an administrator.", 500);
  }
  if (!authorized) {
    throw policyError("not_authorized", `Discord actor is not authorized for ${action}.`, 403);
  }

  const store = getWriteNonceStore();
  // store.create() must never be called unguarded here, unlike the
  // resolveWriteActionRoute() call above it. When an actor exceeds MAX_ENTRIES_PER_ACTOR (20
  // pending previews), writeNonceStore throws a bare Error with no
  // .code/.statusCode, which used to propagate uncaught into the generic
  // adapter error handler -- a plain 500 `{code:"adapter_error"}`,
  // indistinguishable from a real server bug to any monitoring that treats
  // 5xx as an incident. This is a real, expected client condition (an actor
  // spamming previews), so it gets the same distinguishable, documented
  // 429 shape every other rate-limited path in this codebase already uses.
  let created;
  try {
    created = store.create({ actorUserId: actor.userId, action, params: body.params || {} });
  } catch (error) {
    throw policyError("too_many_pending_confirmations", error.message, 429);
  }
  const { nonce, expiresAt } = created;

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
// the real mutation via Core's own internal loopback (Hop B). For a
// dual-confirmation action, the nonce is peeked rather than eagerly consumed,
// so a second, distinct actor can independently pass every gate below before
// Hop B is ever reached -- see the requiresDualConfirmation branch further
// down. NOTE (superseded): server.stop was this mechanism's
// original and only user; it no longer sets the flag (see the note above its
// WRITE_ACTION_ROUTES entry for why), so NO production action currently
// requires dual confirmation. This dispatch logic is entirely generic --
// driven only by the resolved route's own requiresDualConfirmation field,
// never by an action name -- so it remains real, available infrastructure for
// any future action, and stays exercised end-to-end by
// writeBridge.integration.test.js via setRequiresDualConfirmationForTests().
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
  // to whoever happens to present it next -- UNLESS this is a
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
  // See writePreviewRoute's identical handling above for the full rationale
  // -- meetsMinTier() must never be called unwrapped.
  let executeAuthorized;
  try {
    executeAuthorized = meetsMinTier(actorTier, action);
  } catch (error) {
    throw policyError("write_action_misconfigured", "This write action is misconfigured. Contact an administrator.", 500);
  }
  if (!executeAuthorized) {
    throw policyError("not_authorized", `Discord actor is not authorized for ${action}.`, 403);
  }

  // roleSnapshotAt freshness: proves the actor's roleIds were re-derived
  // from Discord at (or near) confirm
  // time, not replayed from the original interaction's cached payload.
  // Number.isSafeInteger check must run BEFORE the comparison -- a
  // malformed value (NaN, string, undefined) makes Math.abs(now - NaN) also
  // NaN, and `NaN > maxRoleAgeSeconds` is always false in JavaScript,
  // silently PASSING instead of rejecting if this order were reversed.
  const roleSnapshotAt = actor.roleSnapshotAt;
  if (!Number.isSafeInteger(roleSnapshotAt) || roleSnapshotAt <= 0) {
    throw policyError("invalid_actor_signature", "Discord actor role snapshot timestamp is invalid.", 403);
  }
  // Deliberately its own env var, not DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS:
  // that var bounds the generic HMAC-signature anti-replay window for every
  // Discord adapter route, an unrelated property to "is this actor's
  // re-derived role snapshot still current." Sharing one knob would let an
  // operator widen the general replay window for an unrelated reason (e.g.
  // bot/host clock drift) and silently widen the acceptance window for
  // stale, possibly-since-revoked elevated roles on this codebase's
  // highest-risk mutation path, with no separate control.
  //
  // boundedEnvInt() (used elsewhere in this file) is deliberately used
  // instead of `Number(process.env.X) || 30`, which silently treats an
  // explicit "0" as "use the 30s default" (an operator asking for zero
  // tolerance got the default instead) and enforces no upper bound (a huge
  // value could effectively disable this freshness check entirely): an
  // out-of-range or non-integer value -- including 0 and unbounded-large --
  // falls back to the default instead of being silently reinterpreted or
  // accepted as-is.
  const maxRoleAgeSeconds = boundedEnvInt("DUNE_DISCORD_WRITE_BRIDGE_ROLE_MAX_AGE_SECONDS", 30, 5, 300);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - roleSnapshotAt) > maxRoleAgeSeconds) {
    throw policyError("stale_actor_signature", "Your role info expired. Please re-run the command.", 403);
  }

  // Dual-confirmation gate: a qualifying action's FIRST
  // write/execute call, from any one authorized actor, marks the nonce
  // pending a second confirmation and stops here -- Hop B is not reached,
  // nothing has mutated. The nonce is deliberately NOT consumed, and its TTL
  // is extended to give a second, distinct admin realistic time to act. The
  // second call (isDualConfirmSecondStep, checked above) falls through to
  // the real consume + Hop B dispatch below like any other action.
  // "A qualifying action" is currently an empty set in production (server.stop
  // no longer sets the flag -- see the route-table note); this branch is
  // deliberately kept, generic, and tested rather than removed.
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

  // STRIDE Repudiation: the real target handler's own audit() call (triggered when Hop B
  // dispatches to it) only ever records the CURRENT request's actor -- for a
  // dual-confirmation completion, that's the second confirmer only. The
  // primary confirmer's identity (peeked.actorUserId) is read above only for
  // the same-actor mismatch check and then discarded, meaning a two-person-
  // approved destructive action's audit trail showed only ONE of the two
  // required approvers, defeating the accountability purpose the mechanism
  // exists for. This explicit record, written here (not inside the real
  // target handler, which must stay unmodified per "no parallel
  // implementation") captures both identities before Hop B is ever reached.
  if (isDualConfirmSecondStep) {
    audit(config, req, "write-bridge.dual-confirmation-completed", {
      action,
      primaryActorUserId: peeked.actorUserId,
      secondActorUserId: actor.userId,
      secondActorUsername: actor.username
    });
  }

  // Hop B: the internal loopback that actually performs the mutation.
  // Reuses the real target route handler completely unchanged -- never
  // reimplements mutation logic.
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
