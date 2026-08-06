import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatChatBodyMessage, isValidHexFlsId, isValidWhisperIdentity, listReadyRabbitQueues, publishCarePackageWhisper } from "../rmq.js";
import { ensureMessageOfTheDayPersona, MESSAGE_OF_THE_DAY_PERSONA } from "../carePackage.js";
import { redact } from "../redact.js";

const DEFAULT_MESSAGE_OF_THE_DAY = {
  enabled: false,
  title: "",
  message: ""
};

const EMPTY_STATUS = { lastAttemptAt: "", lastSent: 0, lastFailed: 0, lastError: "", lastScanAt: "", lastScanError: "" };
const EMPTY_STATE = { delivered: {}, status: EMPTY_STATUS };
// player_state.last_login_time is written before the character finishes spawning and
// before the in-game chat UI is consistently ready. RabbitMQ can accept and consume a
// whisper during that gap even though the client never renders it, so leave a bounded
// post-login grace period before recording the session as delivered.
const MIN_MOTD_SESSION_AGE_MS = 30_000;
const DELIVERED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

export function readMessageOfTheDay(config) {
  const state = readState(config);
  return {
    settings: readSettings(config),
    defaults: { ...DEFAULT_MESSAGE_OF_THE_DAY },
    status: normalizeStatus(state.status)
  };
}

export function saveMessageOfTheDay(config, body = {}) {
  const settings = normalizeSettings(body.settings || body);
  writeJson(settingsPath(config), settings, 0o600);
  return { settings, defaults: { ...DEFAULT_MESSAGE_OF_THE_DAY } };
}

export function restoreMessageOfTheDay(config) {
  const settings = { ...DEFAULT_MESSAGE_OF_THE_DAY };
  writeJson(settingsPath(config), settings, 0o600);
  writeJson(statePath(config), EMPTY_STATE, 0o600);
  return { settings, defaults: { ...DEFAULT_MESSAGE_OF_THE_DAY } };
}

export function primeMessageOfTheDayOnlineState(config, players) {
  const current = readState(config);
  const delivered = {};
  for (const player of (players || []).map(normalizePlayer).filter((entry) => entry.key && entry.characterName)) {
    delivered[player.key] = {
      deliveredAt: new Date().toISOString(),
      characterName: player.characterName,
      sessionKey: player.sessionKey,
      primed: true
    };
  }
  writeJson(statePath(config), { delivered, status: normalizeStatus(current.status) }, 0o600);
  return { delivered: Object.keys(delivered).length };
}

export async function runMessageOfTheDayScan(config, players, context = {}) {
  const settings = readSettings(config);
  if (!settings.enabled) return { ok: true, skipped: true, reason: "disabled", sent: 0, failed: 0 };
  if (!settings.message.trim()) return { ok: true, skipped: true, reason: "empty", sent: 0, failed: 0 };

  const onlinePlayers = onlinePlayerList(players);
  const now = context.now instanceof Date ? context.now : new Date();
  const state = readState(config);
  const delivered = {};
  for (const [key, entry] of Object.entries(state.delivered || {})) {
    const player = onlinePlayers.find((player) => player.key === key);
    if (player) {
      if (sameSession(entry, player)) delivered[key] = entry;
    } else if (shouldRetainDeliveredSession(entry, now)) {
      delivered[key] = entry;
    }
  }

  const pendingPlayers = onlinePlayers.filter((player) => !delivered[player.key] && isSessionMature(player, now));
  if (!pendingPlayers.length) {
    writeJson(statePath(config), { delivered, status: healthyScanStatus(state.status, now) }, 0o600);
    return { ok: true, skipped: false, sent: 0, failed: 0 };
  }

  const results = [];
  let sent = 0;
  let failed = 0;
  let deferred = 0;
  const mockMode = Boolean(context.mockMode || config.mockMode);
  const playersWithDirectQueues = pendingPlayers.filter((player) => player.queue);
  const readyRecipientQueues = context.readyRecipientQueues instanceof Set
    ? context.readyRecipientQueues
    : !mockMode && playersWithDirectQueues.length
      ? await listReadyRabbitQueues(config)
      : null;
  const persona = (context.mockMode || config.mockMode)
    ? (context.persona || MESSAGE_OF_THE_DAY_PERSONA)
    : await ensureMessageOfTheDayPersona(context.db);
  for (const player of pendingPlayers) {
    try {
      if (player.queue && readyRecipientQueues && !readyRecipientQueues.has(player.queue)) {
        deferred += 1;
        results.push({ player: player.characterName, ok: true, deferred: true, reason: "Player message queue is not ready" });
        continue;
      }
      if (mockMode) {
        results.push({ player: player.characterName, ok: true, mock: true, senderName: persona.displayName });
      } else {
        const result = await publishCarePackageWhisper(config, {
          message: renderMessageOfTheDay(settings.message, player.characterName),
          senderFuncomId: persona.funcomId,
          senderHexFlsId: persona.hexFlsId,
          recipientFuncomId: player.funcomId,
          recipientCharacterName: player.characterName,
          recipientQueue: player.queue
        });
        results.push({ player: player.characterName, ok: true, senderName: persona.displayName, stdout: result.stdout });
      }
      sent += 1;
      delivered[player.key] = {
        deliveredAt: new Date().toISOString(),
        characterName: player.characterName,
        sessionKey: player.sessionKey
      };
    } catch (error) {
      failed += 1;
      results.push({ player: player.characterName, ok: false, error: String(error.message || error) });
    }
  }

  const firstFailure = results.find((result) => !result.ok)?.error || "";
  const status = {
    lastAttemptAt: now.toISOString(),
    lastSent: sent,
    lastFailed: failed,
    lastError: firstFailure ? redact(firstFailure) : "",
    lastScanAt: now.toISOString(),
    lastScanError: ""
  };
  writeJson(statePath(config), { delivered, status }, 0o600);
  return { ok: failed === 0, skipped: false, sent, failed, deferred, results };
}

export function recordMessageOfTheDayScanFailure(config, error, now = new Date()) {
  const state = readState(config);
  const status = normalizeStatus({
    ...state.status,
    lastScanAt: now.toISOString(),
    lastScanError: redact(String(error?.message || error || "Unknown scan failure"))
  });
  writeJson(statePath(config), { delivered: state.delivered || {}, status }, 0o600);
  return status;
}

export function normalizeSettings(input = {}) {
  return {
    enabled: normalizeBoolean(input.enabled, "enabled"),
    title: "",
    message: normalizeMessage(input.message ?? input.body ?? "")
  };
}

export function renderMessageOfTheDay(template, playerName) {
  return formatChatBodyMessage(String(template || "").replaceAll("{playerName}", String(playerName || "Player")));
}

export function messageOfTheDayDeliveryPlan(settings, players, state = EMPTY_STATE) {
  const normalizedSettings = normalizeSettings(settings);
  const onlinePlayers = onlinePlayerList(players);
  const delivered = {};
  for (const [key, entry] of Object.entries(state.delivered || {})) {
    const player = onlinePlayers.find((player) => player.key === key);
    if (player && sameSession(entry, player)) delivered[key] = entry;
  }
  const pending = normalizedSettings.enabled && normalizedSettings.message
    ? onlinePlayers.filter((player) => !delivered[player.key])
    : [];
  return { pending, delivered };
}

function readSettings(config) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(settingsPath(config), "utf8")));
  } catch {
    return { ...DEFAULT_MESSAGE_OF_THE_DAY };
  }
}

function readState(config) {
  try {
    const state = JSON.parse(readFileSync(statePath(config), "utf8"));
    return state && typeof state === "object" && state.delivered && typeof state.delivered === "object"
      ? { delivered: state.delivered, status: normalizeStatus(state.status) }
      : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

function normalizeStatus(status = {}) {
  const legacyError = String(status?.lastError || "");
  const legacyInfrastructureFailure = !Object.prototype.hasOwnProperty.call(status, "lastScanAt")
    && Math.max(0, Number(status?.lastFailed) || 0) > 0
    && /ECONNRESET|ECONNREFUSED|connection|database|postgres|docker|rabbitmq|container|terminated/i.test(legacyError);
  if (legacyInfrastructureFailure) {
    return {
      lastAttemptAt: "",
      lastSent: 0,
      lastFailed: 0,
      lastError: "",
      lastScanAt: String(status?.lastAttemptAt || ""),
      lastScanError: legacyError
    };
  }
  return {
    lastAttemptAt: String(status?.lastAttemptAt || ""),
    lastSent: Math.max(0, Number(status?.lastSent) || 0),
    lastFailed: Math.max(0, Number(status?.lastFailed) || 0),
    lastError: legacyError,
    lastScanAt: String(status?.lastScanAt || ""),
    lastScanError: String(status?.lastScanError || "")
  };
}

function healthyScanStatus(status, now) {
  return normalizeStatus({
    ...normalizeStatus(status),
    lastScanAt: now.toISOString(),
    lastScanError: ""
  });
}

function normalizePlayer(player = {}) {
  const rawFlsId = String(player.fls_id || player.flsId || player.recipientFlsId || "").trim();
  const rawFuncomId = String(player.funcom_id || player.funcomId || player.recipientFuncomId || "").trim();
  const flsId = isValidHexFlsId(rawFlsId) ? rawFlsId : "";
  const funcomId = isValidWhisperIdentity(rawFuncomId) ? rawFuncomId : "";
  const characterName = String(player.character_name || player.characterName || player.recipientCharacterName || "").trim();
  const key = String(flsId || funcomId || player.action_player_id || player.actor_id || player.player_pawn_id || "").trim();
  const sessionKey = String(player.login_session || player.loginSession || player.last_login_time || player.lastLoginTime || "").trim();
  const onlineStatus = String(player.online_status || player.onlineStatus || "").trim().toLowerCase();
  return {
    key,
    flsId,
    funcomId,
    characterName,
    online: onlineStatus === "online",
    sessionKey,
    queue: flsId ? `${flsId}_queue` : ""
  };
}

function onlinePlayerList(players = []) {
  const unique = new Map();
  for (const player of players.map(normalizePlayer).filter((entry) => entry.key && entry.funcomId && entry.characterName && entry.online)) {
    const current = unique.get(player.key);
    if (!current || sessionTime(player.sessionKey) >= sessionTime(current.sessionKey)) unique.set(player.key, player);
  }
  return [...unique.values()];
}

function sameSession(entry = {}, player = {}) {
  const current = String(player.sessionKey || "").trim();
  if (!current) return true;
  return String(entry.sessionKey || "").trim() === current;
}

function shouldRetainDeliveredSession(entry = {}, now = new Date()) {
  if (!String(entry.sessionKey || "").trim()) return false;
  const deliveredAt = parseSessionTime(entry.deliveredAt);
  if (!deliveredAt) return true;
  return now.getTime() - deliveredAt.getTime() < DELIVERED_SESSION_RETENTION_MS;
}

function isSessionMature(player = {}, now = new Date()) {
  const startedAt = parseSessionTime(player.sessionKey);
  if (!startedAt) return true;
  return now.getTime() - startedAt.getTime() >= MIN_MOTD_SESSION_AGE_MS;
}

function parseSessionTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = normalizeSessionTimestamp(raw);
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? new Date(millis) : null;
}

function normalizeSessionTimestamp(value) {
  const withDateSeparator = value.includes(" ") && !value.includes("T") ? value.replace(" ", "T") : value;
  return withDateSeparator.replace(/([+-]\d{2})$/, "$1:00");
}

function sessionTime(value) {
  return parseSessionTime(value)?.getTime() ?? 0;
}

function normalizeBoolean(value, field) {
  if (value === true || value === false) return value;
  throw new Error(`${field} must be true or false`);
}

function normalizeMessage(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return formatChatBodyMessage(raw);
}

function settingsPath(config) {
  return resolve(config.generatedDir || resolve(config.repoRoot, "runtime", "generated"), "message-of-the-day.json");
}

function statePath(config) {
  return resolve(config.generatedDir || resolve(config.repoRoot, "runtime", "generated"), "message-of-the-day-state.json");
}

function writeJson(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  try {
    if (existsSync(path)) chmodSync(path, mode);
  } catch {
    // Best effort only. Some mounted filesystems do not support chmod.
  }
}
