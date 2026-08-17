import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { audit } from "../audit.js";
import { writeJsonAtomic } from "../jsonStore.js";
import { redact } from "../redact.js";
import { publishServerCommand } from "../rmq.js";

const PLAYER_BANS_PATH = "runtime/generated/player-bans.json";
const MAX_BANS = 2000;
const MAX_REASON_LENGTH = 500;
const DEFAULT_ENFORCEMENT_COOLDOWN_MS = 15_000;

function bansFile(repoRoot) {
  return resolve(repoRoot || "", PLAYER_BANS_PATH);
}

export function normalizeBanFlsId(value) {
  const id = String(value || "").trim().toUpperCase();
  if (!/^[A-F0-9]{15,64}$/.test(id)) throw Object.assign(new Error("This player does not have a valid stable FLS account ID and cannot be persistently banned."), { statusCode: 409 });
  return id;
}

function optionalText(value, maxLength) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, maxLength);
}

function optionalPositiveId(value) {
  const text = String(value || "").trim();
  return /^\d+$/.test(text) && text !== "0" ? text : "";
}

function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeEntry(entry, key = "") {
  const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  let flsId;
  try {
    flsId = normalizeBanFlsId(source.flsId || key);
  } catch {
    return null;
  }
  const createdAt = isoTimestamp(source.createdAt) || new Date(0).toISOString();
  return {
    flsId,
    funcomId: optionalText(source.funcomId, 180),
    accountId: optionalPositiveId(source.accountId),
    characterName: optionalText(source.characterName, 180),
    reason: optionalText(source.reason, MAX_REASON_LENGTH),
    createdAt,
    updatedAt: isoTimestamp(source.updatedAt) || createdAt,
    lastEnforcedAt: isoTimestamp(source.lastEnforcedAt),
    enforcementCount: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(source.enforcementCount) || 0)))
  };
}

function normalizeState(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawBans = source.bans && typeof source.bans === "object" && !Array.isArray(source.bans) ? source.bans : {};
  const bans = {};
  for (const [key, value] of Object.entries(rawBans)) {
    if (Object.keys(bans).length >= MAX_BANS) break;
    const entry = normalizeEntry(value, key);
    if (entry) bans[entry.flsId] = entry;
  }
  return { schemaVersion: 1, bans };
}

export function readPlayerBanState(repoRoot) {
  const file = bansFile(repoRoot);
  if (!existsSync(file)) return normalizeState({});
  try {
    return normalizeState(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    console.warn(`Ignoring unreadable player ban registry: ${redact(error?.message || "Unexpected error.")}`);
    return normalizeState({});
  }
}

function writePlayerBanState(repoRoot, state) {
  const next = normalizeState(state);
  writeJsonAtomic(bansFile(repoRoot), next, 0o600);
  return next;
}

export function bannedFlsIds(repoRoot) {
  return Object.keys(readPlayerBanState(repoRoot).bans);
}

export function playerBanFor(repoRoot, player = {}) {
  const id = String(player.fls_id || player.flsId || "").trim().toUpperCase();
  return id ? readPlayerBanState(repoRoot).bans[id] || null : null;
}

export function banPlayer(repoRoot, player = {}, options = {}) {
  const flsId = normalizeBanFlsId(player.fls_id || player.flsId);
  const state = readPlayerBanState(repoRoot);
  if (!state.bans[flsId] && Object.keys(state.bans).length >= MAX_BANS) throw Object.assign(new Error(`The ban registry already contains its maximum of ${MAX_BANS} players.`), { statusCode: 409 });
  const now = new Date(options.now?.() ?? Date.now()).toISOString();
  const previous = state.bans[flsId];
  const entry = normalizeEntry({
    ...previous,
    flsId,
    funcomId: player.funcom_id || player.funcomId || previous?.funcomId,
    accountId: player.account_id || player.accountId || previous?.accountId,
    characterName: player.character_name || player.characterName || previous?.characterName,
    reason: options.reason ?? previous?.reason,
    createdAt: previous?.createdAt || now,
    updatedAt: now
  });
  const next = writePlayerBanState(repoRoot, { ...state, bans: { ...state.bans, [flsId]: entry } });
  return { ok: true, alreadyBanned: Boolean(previous), ban: next.bans[flsId] };
}

export function unbanPlayer(repoRoot, flsId) {
  const normalized = normalizeBanFlsId(flsId);
  const state = readPlayerBanState(repoRoot);
  const removed = state.bans[normalized] || null;
  if (!removed) return { ok: true, wasBanned: false, flsId: normalized };
  const bans = { ...state.bans };
  delete bans[normalized];
  writePlayerBanState(repoRoot, { ...state, bans });
  return { ok: true, wasBanned: true, flsId: normalized, ban: removed };
}

function recordEnforcement(repoRoot, flsId, now = Date.now()) {
  const state = readPlayerBanState(repoRoot);
  const entry = state.bans[flsId];
  if (!entry) return;
  writePlayerBanState(repoRoot, {
    ...state,
    bans: {
      ...state.bans,
      [flsId]: {
        ...entry,
        lastEnforcedAt: new Date(now).toISOString(),
        enforcementCount: entry.enforcementCount + 1
      }
    }
  });
}

export function createPlayerBanEnforcer(options = {}) {
  const {
    config,
    getDb,
    duneDb,
    now = () => Date.now(),
    auditImpl = audit,
    publishKick = (flsId) => publishServerCommand(config, { ServerCommand: "KickPlayer", PlayerId: flsId }, "player-ban-enforcement"),
    cooldownMs = DEFAULT_ENFORCEMENT_COOLDOWN_MS,
    log = console
  } = options;
  let running = false;
  const attemptedAt = new Map();

  async function enforcePlayer(player) {
    // Re-read immediately before publication so an unban that races a scan wins.
    const ban = playerBanFor(config.repoRoot, player);
    if (!ban) return { enforced: false, reason: "not_banned" };
    const flsId = ban.flsId;
    const lastAttempt = attemptedAt.get(flsId) || 0;
    if (now() - lastAttempt < cooldownMs) return { enforced: false, reason: "cooldown" };
    attemptedAt.set(flsId, now());
    await publishKick(flsId, player);
    recordEnforcement(config.repoRoot, flsId, now());
    auditImpl(config, null, "players.ban-enforced", {
      flsId,
      accountId: String(player.account_id || ban.accountId || ""),
      characterName: String(player.character_name || ban.characterName || ""),
      map: String(player.map || "")
    });
    return { enforced: true, flsId };
  }

  async function tick() {
    if (running) return { skipped: true, reason: "running" };
    const state = readPlayerBanState(config.repoRoot);
    if (!Object.keys(state.bans).length) return { skipped: true, reason: "empty" };
    running = true;
    try {
      const players = await duneDb.listAllPlayers(getDb(), { status: "online" });
      let enforced = 0;
      let failed = 0;
      for (const player of players.rows || []) {
        const flsId = String(player.fls_id || "").trim().toUpperCase();
        const ban = state.bans[flsId];
        if (!ban) continue;
        try {
          const result = await enforcePlayer(player);
          if (result.enforced) enforced += 1;
        } catch (error) {
          failed += 1;
          log.error(`Player ban enforcement failed for ${ban.flsId.slice(0, 4)}…: ${redact(error?.message || "Unexpected error.")}`);
        }
      }
      return { ok: failed === 0, enforced, failed };
    } finally {
      running = false;
    }
  }

  return { tick, enforcePlayer };
}
