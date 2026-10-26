import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeJsonAtomic } from "../jsonStore.js";

// Bot-wide Market Bot settings, shared by buyback, reseed, and unseed runs
// (scheduled and manual alike). Only the console route writes this file; the
// addon bridge has no path to it.
export const MARKET_BOT_DISABLE_BACKUPS_PHRASE = "DISABLE MARKET BOT BACKUPS";

// Appended to a run's detail so every skipped backup shows in the run
// summary, audit log, and Activity tab.
export const SAFETY_BACKUP_SKIPPED_NOTE = " Safety backup skipped: disabled in Market Bot settings.";

const DEFAULT_SETTINGS = Object.freeze({ safetyBackups: true });

export function marketBotSettingsPath(config) {
  return resolve(config.repoRoot, "runtime/generated/market-bot", "settings.json");
}

// Fails safe: a missing, corrupt, or hand-edited file keeps backups on. Only
// an explicit boolean false turns them off.
export function readMarketBotSettings(config) {
  const path = marketBotSettingsPath(config);
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { safetyBackups: parsed?.safetyBackups !== false };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function marketBotSafetyBackupsEnabled(config) {
  return readMarketBotSettings(config).safetyBackups;
}

// Turning backups off must carry the confirmation phrase; turning them back
// on never needs one.
export function saveMarketBotSettings(config, payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Market Bot settings must be a JSON object.");
  const previous = readMarketBotSettings(config);
  const safetyBackups = payload.safetyBackups === undefined ? previous.safetyBackups : payload.safetyBackups;
  if (typeof safetyBackups !== "boolean") throw new Error("safetyBackups must be true or false.");
  if (!safetyBackups && previous.safetyBackups && payload.confirmation !== MARKET_BOT_DISABLE_BACKUPS_PHRASE) {
    throw new Error(`Confirmation phrase required: ${MARKET_BOT_DISABLE_BACKUPS_PHRASE}`);
  }
  const next = { safetyBackups };
  writeJsonAtomic(marketBotSettingsPath(config), next);
  return next;
}
