import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeJsonAtomic } from "../jsonStore.js";
import { redact } from "../redact.js";

const SETTINGS_PATH = "runtime/generated/server-startup-settings.json";
export const AUTO_START_BATTLEGROUP_DEFAULT = true;

function settingsFile(repoRoot) {
  return resolve(repoRoot || "", SETTINGS_PATH);
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function readServerStartupSettings(repoRoot) {
  const file = settingsFile(repoRoot);
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return typeof value.autoStartBattlegroup === "boolean"
      ? { autoStartBattlegroup: value.autoStartBattlegroup }
      : {};
  } catch (error) {
    console.warn(`Ignoring unreadable server-startup settings: ${redact(error?.message || "Unexpected error.")}`);
    return {};
  }
}

export function resolveAutoStartBattlegroup(repoRoot, env = process.env) {
  const stored = readServerStartupSettings(repoRoot);
  if (stored.autoStartBattlegroup !== undefined) return stored.autoStartBattlegroup;
  if (env.ADMIN_AUTO_START_STACK_ON_BOOT === "0") return false;
  return AUTO_START_BATTLEGROUP_DEFAULT;
}

export function serverStartupSettingsView(repoRoot, env = process.env) {
  const stored = readServerStartupSettings(repoRoot);
  const fromEnvironment = stored.autoStartBattlegroup === undefined
    && env.ADMIN_AUTO_START_STACK_ON_BOOT === "0";
  return {
    settings: { autoStartBattlegroup: resolveAutoStartBattlegroup(repoRoot, env) },
    defaults: { autoStartBattlegroup: AUTO_START_BATTLEGROUP_DEFAULT },
    source: stored.autoStartBattlegroup !== undefined ? "console" : fromEnvironment ? "environment" : "default"
  };
}

export function saveServerStartupSettings(repoRoot, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw badRequest("Server startup settings must be an object.");
  }
  if (typeof payload.autoStartBattlegroup !== "boolean") {
    throw badRequest("autoStartBattlegroup must be true or false.");
  }
  writeJsonAtomic(settingsFile(repoRoot), { autoStartBattlegroup: payload.autoStartBattlegroup }, 0o600);
  return serverStartupSettingsView(repoRoot);
}
