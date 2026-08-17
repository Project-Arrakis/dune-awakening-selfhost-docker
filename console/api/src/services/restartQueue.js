import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildBroadcastCommand, publishServerCommand } from "../rmq.js";
import { clampInt } from "../jsonStore.js";

// The Restart Queue turns any console-triggered restart into a countdown with
// in-game Server Broadcast warnings when players are online, and lets it run
// immediately when nobody is. This module owns only the on-disk settings and
// state plus pure decision helpers; the executor (which needs the task runner
// and the online-player count) lives in server.js and drives this on the 10s
// master tick. See plans/server/restart-queue.md.

// Default broadcast templates, matching the original hardcoded copy. `{minutes}`
// renders as a pluralized quantity ("15 minutes" / "1 minute"); `{mapLabel}`
// renders as the target's display name ("All servers" for a battlegroup entry,
// the map/sietch name for a map entry). See renderTemplate/buildWarning.
const DEFAULT_MESSAGES = {
  battlegroup: {
    title: "Battlegroup Restart",
    body: "All servers will restart in {minutes}. Please get to a safe place."
  },
  map: {
    title: "Map Restart",
    body: "{mapLabel} will restart in {minutes}. Please move to another map or get to a safe place."
  }
};

const DEFAULT_SETTINGS = {
  enabled: false,
  defaultCountdownMinutes: 15,
  broadcastCheckpoints: [15, 10, 5, 1],
  broadcastDurationSec: 30,
  recoveryGraceMinutes: 5,
  messages: DEFAULT_MESSAGES
};

const EMPTY_STATE = { entries: [] };

const MAX_COUNTDOWN_MINUTES = 1440;
const MAX_CHECKPOINTS = 12;
const PUBLISH_LABEL = "restart-queue";
// Matches rmq.js's buildBroadcastCommand validators (Title <=80 chars,
// Body 1-500 chars) so a saved template can never fail at send time.
const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 500;

// The restart-bearing operations the queue gates. Includes the direct restart
// controls and the settings-save-and-restart flows (whose payloads carry a
// `restartMode` of stack/service/respawn when they actually restart; a save
// with restart disabled reports `restartMode: "none"` and classifyRestart
// leaves it ungated). A battlegroup restart is mutually exclusive with
// everything; map-scoped restarts (a respawn or a sietch partition) can run
// concurrently for distinct maps. See plans/server/restart-queue.md.
const RESTART_OPERATIONS = new Set([
  "restartAll",
  "restartService",
  "mapsRespawn",
  "sietchesRestart",
  "userSettingsSaveAndRestart",
  "userSettingsResetAndRestart",
  "userSettingsRawAndRestart"
]);

function generatedDir(config) {
  return config.generatedDir || resolve(config.repoRoot, "runtime", "generated");
}

function settingsPath(config) {
  return resolve(generatedDir(config), "restart-queue.json");
}

function statePath(config) {
  return resolve(generatedDir(config), "restart-queue-state.json");
}

export function normalizeSettings(input = {}) {
  const source = input && typeof input === "object" ? (input.settings && typeof input.settings === "object" ? input.settings : input) : {};
  return {
    enabled: source.enabled === true,
    defaultCountdownMinutes: clampInt(source.defaultCountdownMinutes, DEFAULT_SETTINGS.defaultCountdownMinutes, 1, MAX_COUNTDOWN_MINUTES),
    broadcastCheckpoints: normalizeCheckpoints(source.broadcastCheckpoints),
    broadcastDurationSec: clampInt(source.broadcastDurationSec, DEFAULT_SETTINGS.broadcastDurationSec, 1, 3600),
    recoveryGraceMinutes: clampInt(source.recoveryGraceMinutes, DEFAULT_SETTINGS.recoveryGraceMinutes, 0, 1440),
    messages: normalizeMessages(source.messages)
  };
}

// Falls back to the default template per-field (title/body independently) on
// anything invalid, rather than throwing: this is a settings save, and a
// half-bad edit should keep the other half rather than reject the whole save.
// The actual send-time strictness lives in rmq.js's validators.
function normalizeMessages(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    battlegroup: normalizeMessageTemplate(source.battlegroup, DEFAULT_MESSAGES.battlegroup),
    map: normalizeMessageTemplate(source.map, DEFAULT_MESSAGES.map)
  };
}

function normalizeMessageTemplate(value, fallback) {
  const source = value && typeof value === "object" ? value : {};
  return {
    title: clampTemplateText(source.title, fallback.title, MAX_TITLE_LENGTH),
    body: clampTemplateText(source.body, fallback.body, MAX_BODY_LENGTH)
  };
}

function clampTemplateText(value, fallback, maxLength) {
  const raw = String(value ?? "").trim();
  return raw.length >= 1 && raw.length <= maxLength ? raw : fallback;
}

// Substitutes {token} placeholders; an unrecognized token is left as-is so a
// typo in a saved template is visible rather than silently erased.
function renderTemplate(template, vars) {
  return String(template || "").replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(vars, key) ? vars[key] : match));
}

// Checkpoints are the minutes-remaining marks at which a warning fires. Accepts
// an array or a comma-separated string (the UI ships a text field). Values are
// clamped, de-duplicated, and sorted descending so the countdown fires them in
// order. An empty/garbage list falls back to the default so a save never
// silences all warnings by accident.
function normalizeCheckpoints(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const n = Number(String(item).trim());
    if (!Number.isInteger(n) || n < 1 || n > MAX_COUNTDOWN_MINUTES) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_CHECKPOINTS) break;
  }
  out.sort((a, b) => b - a);
  return out.length ? out : [...DEFAULT_SETTINGS.broadcastCheckpoints];
}

export function readSettings(config) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(settingsPath(config), "utf8")));
  } catch {
    return defaultSettings();
  }
}

// Merges the incoming body onto the CURRENTLY PERSISTED settings before
// normalizing, so a save that only touches one field (the enable toggle, the
// countdown/checkpoints fields, or -- via the messages editor -- just the
// broadcast templates) never resets every other field back to its default.
// `current` is already fully normalized by readSettings, so a shallow merge
// is sufficient; a caller that sends a full `messages` object (the editor
// always does) replaces it wholesale, which is what "save this tab" means.
export function saveSettings(config, body = {}) {
  const current = readSettings(config);
  const patch = body && typeof body === "object" ? (body.settings && typeof body.settings === "object" ? body.settings : body) : {};
  const settings = normalizeSettings({ ...current, ...patch });
  writeJson(settingsPath(config), settings, 0o600);
  return { settings, defaults: defaultSettings() };
}

export function defaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    broadcastCheckpoints: [...DEFAULT_SETTINGS.broadcastCheckpoints],
    messages: { battlegroup: { ...DEFAULT_MESSAGES.battlegroup }, map: { ...DEFAULT_MESSAGES.map } }
  };
}

export function readState(config) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(config), "utf8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries.map(normalizeEntry).filter(Boolean) : [];
    return { entries };
  } catch {
    return { entries: [] };
  }
}

export function writeState(config, state) {
  const entries = Array.isArray(state?.entries) ? state.entries.map(normalizeEntry).filter(Boolean) : [];
  writeJson(statePath(config), { entries }, 0o600);
  return { entries };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const target = entry.target === "battlegroup" ? "battlegroup" : entry.target === "service" ? "service" : "map";
  const id = String(entry.id || "").trim() || randomUUID();
  const operation = String(entry.operation || "").trim();
  if (!operation) return null;
  return {
    id,
    status: entry.status === "restarting" ? "restarting" : "counting",
    target,
    type: String(entry.type || "server").trim() || "server",
    operation,
    payload: entry.payload && typeof entry.payload === "object" ? entry.payload : {},
    mapKey: target !== "battlegroup" ? String(entry.mapKey || "").trim() : "",
    mapLabel: String(entry.mapLabel || "").trim(),
    // Denormalized from classifyRestart so the tick can re-scope the online
    // check to this entry's map without re-parsing its restart payload.
    partitionId: target !== "battlegroup" ? clampInt(entry.partitionId, 0, 0, 2147483647) : 0,
    map: target !== "battlegroup" ? String(entry.map || "").trim() : "",
    startedAt: String(entry.startedAt || "").trim(),
    restartAt: Number(entry.restartAt) || 0,
    countdownMinutes: clampInt(entry.countdownMinutes, DEFAULT_SETTINGS.defaultCountdownMinutes, 1, MAX_COUNTDOWN_MINUTES),
    sentCheckpoints: Array.isArray(entry.sentCheckpoints)
      ? [...new Set(entry.sentCheckpoints.map((n) => Number(n)).filter((n) => Number.isInteger(n)))]
      : [],
    requestedBy: String(entry.requestedBy || "web-admin").trim() || "web-admin"
  };
}

// Decide whether an operation is a gated restart and, if so, whether it targets
// the whole battlegroup or a single map. Returns null for non-restart ops or a
// no-op restartMode ("none"), which the gate treats as "proceed unchanged".
export function classifyRestart(operation, payload = {}) {
  if (!RESTART_OPERATIONS.has(operation)) return null;
  const restartMode = String(payload?.restartMode || "").trim();
  if (restartMode === "none") return null;

  // Whole-battlegroup restarts.
  if (operation === "restartAll" || restartMode === "stack") {
    return { target: "battlegroup", mapKey: "", mapLabel: "All servers", partitionId: 0, map: "" };
  }

  // The two game-server services have stable partition targets. Preserve that
  // scope so their queue label, online-player check, and warning copy describe
  // the service that is actually cycling. Shared infrastructure services still
  // affect the battlegroup and remain battlegroup-scoped.
  if (operation === "restartService" && !payload?.map && !payload?.partitionId && !payload?.target) {
    const service = String(payload?.service || "").trim().toLowerCase();
    if (service === "overmap") {
      return { target: "service", mapKey: "overmap:2", mapLabel: "Overmap", partitionId: 2, map: "Overmap" };
    }
    if (service === "survival" || service === "survival-1") {
      return { target: "service", mapKey: "survival_1:1", mapLabel: "Survival 1", partitionId: 1, map: "Survival_1" };
    }
    return { target: "battlegroup", mapKey: "", mapLabel: "All servers", partitionId: 0, map: "" };
  }

  const mapLabel = String(payload?.restartLabel || payload?.map || payload?.service || "this map").trim() || "this map";
  const mapKey = restartMapKey(payload);
  // Carried onto the entry so the online-player check (both at gate time and
  // on every tick) can be scoped to this specific map/partition instead of
  // the whole battlegroup. See duneDb.countOnlinePlayersForTarget.
  const rawPartitionId = Number(payload?.partitionId || payload?.target || 0);
  const partitionId = Number.isInteger(rawPartitionId) && rawPartitionId > 0 ? rawPartitionId : 0;
  const map = String(payload?.map || "").trim();
  return { target: "map", mapKey, mapLabel, partitionId, map };
}

function restartMapKey(payload = {}) {
  const partition = String(payload?.partitionId || payload?.target || "").trim();
  const map = String(payload?.map || payload?.service || "").trim().toLowerCase();
  if (partition && map) return `${map}:${partition}`;
  if (partition) return `partition:${partition}`;
  if (map) return `map:${map}`;
  return `label:${String(payload?.restartLabel || "").trim().toLowerCase()}`;
}

// Concurrency rules (see plan): one battlegroup entry XOR N distinct-map
// entries. Returns { ok } or { ok:false, reason } for a 409.
export function canQueue(entries, target, mapKey) {
  const list = Array.isArray(entries) ? entries : [];
  const hasBattlegroup = list.some((e) => e.target === "battlegroup");
  if (target === "battlegroup") {
    if (hasBattlegroup) return { ok: false, reason: "A battlegroup restart is already queued." };
    if (list.length) return { ok: false, reason: "Maps are already restarting. Cancel them before starting a battlegroup restart." };
    return { ok: true };
  }
  if (hasBattlegroup) return { ok: false, reason: "A battlegroup restart is queued, so individual map restarts are blocked." };
  if (list.some((e) => e.mapKey && e.mapKey === mapKey)) return { ok: false, reason: "This map is already in the restart queue." };
  return { ok: true };
}

// Append a new countdown entry. Caller has already validated via canQueue().
export function appendEntry(config, { target, type, operation, payload, mapKey, mapLabel, partitionId, map, requestedBy, countdownMinutes, now }) {
  const state = readState(config);
  const startMs = Number.isFinite(now) ? now : Date.now();
  const minutes = clampInt(countdownMinutes, DEFAULT_SETTINGS.defaultCountdownMinutes, 1, MAX_COUNTDOWN_MINUTES);
  const entry = normalizeEntry({
    id: randomUUID(),
    status: "counting",
    target,
    type,
    operation,
    payload,
    mapKey: target !== "battlegroup" ? mapKey : "",
    mapLabel,
    partitionId: target !== "battlegroup" ? partitionId : 0,
    map: target !== "battlegroup" ? map : "",
    startedAt: new Date(startMs).toISOString(),
    restartAt: startMs + minutes * 60_000,
    countdownMinutes: minutes,
    sentCheckpoints: [],
    requestedBy
  });
  state.entries.push(entry);
  writeState(config, state);
  return entry;
}

export function removeEntry(config, id) {
  const state = readState(config);
  const entries = state.entries.filter((e) => e.id !== id);
  writeState(config, { entries });
  return { entries };
}

// Flip an entry to the write-ahead `restarting` status and persist BEFORE the
// caller dispatches the actual restart. If the console (or the whole
// battlegroup, which bounces the console container) goes down mid-dispatch,
// boot recovery sees `restarting` and never re-fires it.
export function markEntryRestarting(config, id) {
  const state = readState(config);
  const entry = state.entries.find((e) => e.id === id);
  if (entry) entry.status = "restarting";
  writeState(config, state);
  return entry || null;
}

// Persist that a checkpoint warning has been broadcast for an entry, so a crash
// or a slow tick never double-sends it. Read-modify-write against the file so it
// composes with the other mutators the tick calls.
export function recordCheckpointSent(config, id, mark) {
  const state = readState(config);
  const entry = state.entries.find((e) => e.id === id);
  if (entry && Number.isInteger(mark) && !entry.sentCheckpoints.includes(mark)) {
    entry.sentCheckpoints.push(mark);
  }
  writeState(config, state);
  return entry || null;
}

// "Restart Now" on an active entry: collapse its countdown so the next tick
// executes it.
export function expediteEntry(config, id, now = Date.now()) {
  const state = readState(config);
  const entry = state.entries.find((e) => e.id === id);
  if (entry) entry.restartAt = now;
  writeState(config, state);
  return entry || null;
}

// Which checkpoint marks are due now for a counting entry, given the configured
// checkpoints. A mark is due once minutes-remaining has fallen to or below it
// and it has not already been sent. Returns the marks to broadcast (highest
// first) — normally just one per tick, but a long tick gap could surface more.
export function checkpointsDue(entry, checkpoints, now = Date.now()) {
  if (!entry || entry.status !== "counting") return [];
  const remainingMs = entry.restartAt - now;
  if (remainingMs <= 0) return [];
  const remainingMinutes = remainingMs / 60_000;
  const sent = new Set(entry.sentCheckpoints || []);
  return (Array.isArray(checkpoints) ? checkpoints : [])
    .filter((mark) => Number.isInteger(mark) && mark > 0)
    .filter((mark) => !sent.has(mark) && remainingMinutes <= mark)
    .sort((a, b) => b - a);
}

// `messages` defaults to the built-in copy so existing callers (and tests)
// that don't pass a settings object keep working unchanged.
export function buildWarning(target, mapLabel, minutesLeft, messages = DEFAULT_MESSAGES) {
  const minutes = Math.max(1, Math.round(minutesLeft));
  const unit = minutes === 1 ? "minute" : "minutes";
  const defaultLabel = target === "battlegroup" ? "All servers" : "This map";
  const label = String(mapLabel || defaultLabel).trim() || defaultLabel;
  const template = target === "battlegroup" ? messages.battlegroup : messages.map;
  const vars = { minutes: `${minutes} ${unit}`, mapLabel: label };
  const renderedTitle = renderTemplate(template.title, vars);
  return {
    // Keep customized map-warning titles intact. For the built-in generic map
    // title, name the service explicitly so players never see "Map Restart"
    // or "Battlegroup Restart" for an Overmap/Survival service restart.
    title: target === "service" && template.title === DEFAULT_MESSAGES.map.title ? `${label} Restart` : renderedTitle,
    body: renderTemplate(template.body, vars)
  };
}

export async function sendWarning(config, entry, minutesLeft, settings = readSettings(config)) {
  const { title, body } = buildWarning(entry.target, entry.mapLabel, minutesLeft, settings.messages);
  const command = buildBroadcastCommand({ title, message: body, durationSec: settings.broadcastDurationSec });
  return publishServerCommand(config, command, PUBLISH_LABEL);
}

// Boot-time reconciliation. Pure: returns the entries to keep (already
// normalized) plus the buckets the caller acts on. `executeNow` are countdowns
// that elapsed while we were down but are still within the grace window, so the
// restart should run immediately; `resume` keep counting; `cleared` were
// mid-dispatch (never re-run); `discarded` aged out past the grace window.
export function recover(state, now, graceMinutes) {
  const graceMs = Math.max(0, Number(graceMinutes) || 0) * 60_000;
  const keep = [];
  const executeNow = [];
  const resume = [];
  const cleared = [];
  const discarded = [];
  for (const entry of Array.isArray(state?.entries) ? state.entries : []) {
    const normalized = normalizeEntry(entry);
    if (!normalized) continue;
    if (normalized.status === "restarting") {
      cleared.push(normalized);
      continue;
    }
    if (now < normalized.restartAt) {
      resume.push(normalized);
      keep.push(normalized);
      continue;
    }
    if (now - normalized.restartAt <= graceMs) {
      executeNow.push(normalized);
      keep.push(normalized);
      continue;
    }
    discarded.push(normalized);
  }
  return { keep: { entries: keep }, executeNow, resume, cleared, discarded };
}

export function isRestartOperation(operation) {
  return RESTART_OPERATIONS.has(operation);
}

// Public shape for the API/UI: settings + active entries with derived fields.
export function publicState(config, now = Date.now()) {
  const entries = readState(config).entries.map((entry) => ({
    id: entry.id,
    status: entry.status,
    target: entry.target,
    mapLabel: entry.mapLabel,
    requestedBy: entry.requestedBy,
    startedAt: entry.startedAt,
    restartAt: entry.restartAt,
    countdownMinutes: entry.countdownMinutes,
    remainingSeconds: Math.max(0, Math.round((entry.restartAt - now) / 1000)),
    sentCheckpoints: [...entry.sentCheckpoints].sort((a, b) => b - a)
  }));
  return { entries };
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
