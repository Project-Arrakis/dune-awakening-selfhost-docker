import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUN_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const STATES = new Set(["running", "succeeded", "failed"]);

export function readSelfUpdateStatus(repoRoot, runId) {
  const cleanRunId = String(runId || "").trim();
  if (!RUN_ID_PATTERN.test(cleanRunId)) throw Object.assign(new Error("Invalid console update run ID."), { code: "INVALID_RUN_ID" });

  const statusPath = join(repoRoot, "runtime", "generated", "self-update-status", `${cleanRunId}.env`);
  let source;
  try {
    source = readFileSync(statusPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { runId: cleanRunId, state: "pending", stage: "launching", percent: 1, message: "Waiting for the update helper to start." };
    throw error;
  }
  if (Buffer.byteLength(source, "utf8") > 16 * 1024) throw new Error("Console update status file is unexpectedly large.");

  const fields = parseStatusFields(source);
  if (fields.run_id !== cleanRunId) throw new Error("Console update status does not match the requested run.");
  if (!STATES.has(fields.state)) throw new Error("Console update status has an invalid state.");

  return {
    runId: cleanRunId,
    state: fields.state,
    stage: safeText(fields.stage, 64) || "unknown",
    percent: boundedPercent(fields.percent),
    message: safeText(fields.message, 500),
    startedAt: safeTimestamp(fields.started_at),
    updatedAt: safeTimestamp(fields.updated_at),
    finishedAt: safeTimestamp(fields.finished_at)
  };
}

function parseStatusFields(source) {
  const fields = {};
  for (const line of String(source).split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[a-z_]+$/.test(key)) continue;
    fields[key] = line.slice(separator + 1).trim();
  }
  return fields;
}

function boundedPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

function safeText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

function safeTimestamp(value) {
  const clean = safeText(value, 64);
  return clean && Number.isFinite(Date.parse(clean)) ? clean : null;
}
