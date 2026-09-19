import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeJsonAtomic } from "../jsonStore.js";

const MAX_SCHEDULES = 100;
const MISSED_RUN_GRACE_MS = 90_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatterCache = new Map();

export function createScheduledMapMessageScheduler(config, context = {}) {
  let running = false;

  return {
    list: () => readSchedules(config),
    save: (input, now) => saveSchedule(config, input, now),
    remove: (id) => removeSchedule(config, id),
    runNow: (id) => runOneNow(config, id, context),
    async tick(now = new Date()) {
      if (running) return { skipped: true, reason: "running" };
      running = true;
      try {
        return await runDueSchedules(config, context, now);
      } finally {
        running = false;
      }
    }
  };
}

export function readSchedules(config) {
  const state = readState(config);
  return { version: 1, schedules: state.schedules.map(publicSchedule) };
}

export function saveSchedule(config, input = {}, now = new Date()) {
  const state = readState(config);
  const rawId = String(input.id || "").trim();
  const index = rawId ? state.schedules.findIndex((entry) => entry.id === rawId) : -1;
  if (rawId && index < 0) throw new Error("Scheduled message was not found.");
  if (!rawId && state.schedules.length >= MAX_SCHEDULES) throw new Error(`A maximum of ${MAX_SCHEDULES} scheduled messages is allowed.`);

  const previous = index >= 0 ? state.schedules[index] : null;
  const schedule = normalizeSchedule(input, previous, now);
  if (index >= 0) state.schedules[index] = schedule;
  else state.schedules.push(schedule);
  writeState(config, state);
  return publicSchedule(schedule);
}

export function removeSchedule(config, id) {
  const scheduleId = validateId(id);
  const state = readState(config);
  const next = state.schedules.filter((entry) => entry.id !== scheduleId);
  if (next.length === state.schedules.length) throw new Error("Scheduled message was not found.");
  writeState(config, { version: 1, schedules: next });
  return { removed: scheduleId };
}

export function nextScheduledRun(schedule, after = new Date(), excludedLocalDate = "") {
  if (!schedule?.enabled) return "";
  const [wantedHour, wantedMinute] = String(schedule.time || "").split(":").map(Number);
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = start + 9 * 24 * 60 * 60_000;
  for (let timestamp = start; timestamp <= limit; timestamp += 60_000) {
    const parts = localDateParts(new Date(timestamp), schedule.timezone);
    if (parts.hour !== wantedHour || parts.minute !== wantedMinute) continue;
    if (excludedLocalDate && parts.date === excludedLocalDate) continue;
    if (schedule.frequency === "weekly" && !schedule.daysOfWeek.includes(parts.weekday)) continue;
    return new Date(timestamp).toISOString();
  }
  throw new Error("Could not determine the next scheduled delivery for this timezone.");
}

async function runDueSchedules(config, context, now) {
  let state = readState(config);
  let changed = false;
  const due = [];
  const missed = [];
  for (const schedule of state.schedules) {
    if (!schedule.enabled) continue;
    if (!schedule.nextRunAt) {
      schedule.nextRunAt = nextScheduledRun(schedule, now, schedule.lastRunLocalDate);
      changed = true;
      continue;
    }
    const dueAt = Date.parse(schedule.nextRunAt);
    if (!Number.isFinite(dueAt) || dueAt > now.getTime()) continue;
    const localRunDate = localDateParts(new Date(dueAt), schedule.timezone).date;
    schedule.lastAttemptAt = now.toISOString();
    schedule.lastRunLocalDate = localRunDate;
    schedule.nextRunAt = nextScheduledRun(schedule, now, localRunDate);
    if (now.getTime() - dueAt > MISSED_RUN_GRACE_MS) {
      schedule.lastStatus = "missed";
      schedule.lastError = "Delivery was skipped because the Console was unavailable at the scheduled time.";
      missed.push(publicSchedule(schedule));
    } else {
      schedule.lastStatus = "running";
      schedule.lastError = "";
      due.push(schedule.id);
    }
    changed = true;
  }
  if (changed) writeState(config, state);
  for (const schedule of missed) context.onResult?.({ schedule, manual: false, ok: false, skipped: true, error: schedule.lastError });

  const results = [];
  for (const id of due) {
    state = readState(config);
    const schedule = state.schedules.find((entry) => entry.id === id);
    if (!schedule) continue;
    results.push(await deliverSchedule(config, schedule, context, false));
  }
  return { skipped: false, due: due.length, results };
}

async function runOneNow(config, id, context) {
  const scheduleId = validateId(id);
  const state = readState(config);
  const schedule = state.schedules.find((entry) => entry.id === scheduleId);
  if (!schedule) throw new Error("Scheduled message was not found.");
  return deliverSchedule(config, schedule, context, true);
}

async function deliverSchedule(config, schedule, context, manual) {
  const attemptedAt = new Date();
  try {
    const result = await context.deliver(schedule);
    updateRunState(config, schedule.id, {
      lastAttemptAt: attemptedAt.toISOString(),
      lastDeliveredAt: attemptedAt.toISOString(),
      lastStatus: "sent",
      lastError: "",
      lastRecipients: Math.max(0, Number(result?.recipients) || 0)
    });
    context.onResult?.({ schedule, manual, ok: true, result });
    return { ok: true, schedule: publicSchedule({ ...schedule, lastStatus: "sent" }), ...result };
  } catch (error) {
    const message = String(error?.message || "Unexpected error.");
    const noPlayers = /No online players/i.test(message);
    updateRunState(config, schedule.id, {
      lastAttemptAt: attemptedAt.toISOString(),
      lastStatus: noPlayers ? "skipped" : "failed",
      lastError: message,
      lastRecipients: 0
    });
    context.onResult?.({ schedule, manual, ok: false, skipped: noPlayers, error: message });
    if (manual) throw error;
    return { ok: false, skipped: noPlayers, error: message };
  }
}

function updateRunState(config, id, patch) {
  const state = readState(config);
  const schedule = state.schedules.find((entry) => entry.id === id);
  if (!schedule) return;
  Object.assign(schedule, patch);
  writeState(config, state);
}

function normalizeSchedule(input, previous, now) {
  const enabled = normalizeBoolean(input.enabled ?? previous?.enabled ?? true);
  const frequency = String(input.frequency || previous?.frequency || "daily").trim().toLowerCase();
  if (!new Set(["daily", "weekly"]).has(frequency)) throw new Error("Frequency must be daily or weekly.");
  const daysOfWeek = normalizeDays(input.daysOfWeek ?? previous?.daysOfWeek ?? []);
  if (frequency === "weekly" && !daysOfWeek.length) throw new Error("Choose at least one weekday for a weekly message.");
  const timezone = validateTimezone(input.timezone || previous?.timezone || "UTC");
  const time = validateTime(input.time || previous?.time || "09:00");
  const message = validateText(input.message ?? previous?.message ?? "", "Message", 500, true);
  const name = validateText(input.name ?? previous?.name ?? "", "Name", 80, false) || message.slice(0, 60);
  const mapName = validateMapName(input.mapName || previous?.mapName || "HaggaBasin");
  const dimension = validateInteger(input.dimension ?? previous?.dimension ?? 0, 0, 9999, "Dimension");
  const id = previous?.id || randomUUID();
  const scheduleChanged = !previous || ["enabled", "frequency", "timezone", "time", "mapName", "dimension"].some((key) => String(previous[key]) !== String({ enabled, frequency, timezone, time, mapName, dimension }[key])) || JSON.stringify(previous.daysOfWeek) !== JSON.stringify(daysOfWeek);
  const nextRunAt = enabled
    ? (scheduleChanged ? nextScheduledRun({ enabled, frequency, daysOfWeek, timezone, time }, now) : previous.nextRunAt || nextScheduledRun({ enabled, frequency, daysOfWeek, timezone, time }, now))
    : "";
  return {
    id, name, enabled, mapName, dimension, message, frequency, daysOfWeek, time, timezone, nextRunAt,
    createdAt: previous?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
    lastAttemptAt: previous?.lastAttemptAt || "",
    lastDeliveredAt: previous?.lastDeliveredAt || "",
    lastRunLocalDate: previous?.lastRunLocalDate || "",
    lastStatus: previous?.lastStatus || "never",
    lastError: previous?.lastError || "",
    lastRecipients: Math.max(0, Number(previous?.lastRecipients) || 0)
  };
}

function readState(config) {
  const file = schedulesPath(config);
  if (!existsSync(file)) return { version: 1, schedules: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || !Array.isArray(parsed.schedules)) return { version: 1, schedules: [] };
    return { version: 1, schedules: parsed.schedules.filter((entry) => entry && typeof entry === "object") };
  } catch {
    return { version: 1, schedules: [] };
  }
}

function writeState(config, state) {
  writeJsonAtomic(schedulesPath(config), { version: 1, schedules: state.schedules }, 0o600);
}

function schedulesPath(config) {
  return resolve(config.generatedDir || resolve(config.repoRoot, "runtime/generated"), "scheduled-map-messages.json");
}

function publicSchedule(schedule) {
  return { ...schedule, daysOfWeek: [...(schedule.daysOfWeek || [])] };
}

function localDateParts(date, timezone) {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatterCache.set(timezone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    weekday: WEEKDAYS.indexOf(values.weekday),
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function validateTimezone(value) {
  const timezone = String(value || "").trim();
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new Error("Timezone must be a valid IANA timezone, such as UTC or America/New_York.");
  }
  return timezone;
}

function validateTime(value) {
  const time = String(value || "").trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Time must use the 24-hour HH:MM format.");
  return time;
}

function validateMapName(value) {
  const mapName = String(value || "").trim();
  if (!/^[A-Za-z0-9_]{1,80}$/.test(mapName)) throw new Error("Map must be a valid map destination.");
  return mapName;
}

function validateId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) throw new Error("Scheduled message ID is invalid.");
  return id;
}

function validateText(value, label, max, required) {
  const text = String(value || "").trim();
  if ((required && !text) || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error(`${label} must be ${required ? "1-" : "no more than "}${max} printable characters.`);
  return text;
}

function validateInteger(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return number;
}

function normalizeDays(value) {
  if (!Array.isArray(value)) throw new Error("Weekdays must be a list.");
  return [...new Set(value.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1) return true;
  if (value === "false" || value === 0) return false;
  throw new Error("Enabled must be true or false.");
}
