import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { applyLandsraadVendorOverride, revertLandsraadVendorOverride } from "../duneDb.js";

const DEFAULT_PRESET = {
  enabled: false,
  vendorKeys: [],
  mode: "fixed",
  lastAppliedTermId: null,
  lastAppliedAt: "",
  lastResult: ""
};

export function readLandsraadVendorOverridePreset(config) {
  const file = presetPath(config);
  if (!existsSync(file)) return { ...DEFAULT_PRESET, vendorKeys: [] };
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const settings = normalizeLandsraadVendorOverridePreset(parsed, { allowEmpty: true });
  return {
    ...settings,
    lastAppliedTermId: nullableTermId(parsed.lastAppliedTermId),
    lastAppliedAt: String(parsed.lastAppliedAt || ""),
    lastResult: String(parsed.lastResult || "")
  };
}

export function saveLandsraadVendorOverridePreset(config, input = {}) {
  const settings = normalizeLandsraadVendorOverridePreset(input);
  const previous = readLandsraadVendorOverridePreset(config);
  const unchanged = previous.enabled === settings.enabled
    && previous.mode === settings.mode
    && previous.vendorKeys.length === settings.vendorKeys.length
    && previous.vendorKeys.every((value, index) => value === settings.vendorKeys[index]);
  const next = {
    ...settings,
    lastAppliedTermId: unchanged ? previous.lastAppliedTermId : null,
    lastAppliedAt: unchanged ? previous.lastAppliedAt : "",
    lastResult: unchanged ? previous.lastResult : ""
  };
  writePreset(config, next);
  return next;
}

// manual: true is "Force Now" (explicit, attended -- may override an
// already-resolved term, since only a deliberate admin action may discard a
// real win). false is the reconciler's unattended tick (never overrides a
// resolved term). See duneDb.js's applyLandsraadVendorOverride for why.
export async function applySavedLandsraadVendorOverride(config, db, { manual = false } = {}) {
  const preset = readLandsraadVendorOverridePreset(config);
  if (!preset.vendorKeys.length) return { preset, result: { ok: true, applied: false, reason: "No Landsraad vendor override has been configured." } };
  const result = await applyLandsraadVendorOverride(db, {
    vendorKeys: preset.vendorKeys,
    mode: preset.mode,
    allowOverrideResolvedTerm: manual
  });
  const next = {
    ...preset,
    lastAppliedTermId: result.applied ? String(result.termId) : preset.lastAppliedTermId,
    lastAppliedAt: result.applied ? new Date().toISOString() : preset.lastAppliedAt,
    lastResult: result.applied ? `Applied - ${result.decreeName}` : String(result.reason || "Waiting")
  };
  writePreset(config, next);
  return { preset: next, result };
}

export async function revertSavedLandsraadVendorOverride(config, db) {
  const result = await revertLandsraadVendorOverride(db);
  const preset = readLandsraadVendorOverridePreset(config);
  const next = {
    ...preset,
    lastAppliedTermId: null,
    lastAppliedAt: result.applied ? new Date().toISOString() : preset.lastAppliedAt,
    lastResult: result.applied ? "Reverted" : String(result.reason || "Nothing to revert")
  };
  writePreset(config, next);
  return { preset: next, result };
}

export function createLandsraadVendorOverrideReconciler(config, options = {}) {
  const getDb = options.getDb;
  const applyPreset = options.applyPreset || applyLandsraadVendorOverride;
  const intervalMs = Math.max(10_000, Number(options.intervalMs || 60_000));
  let running = false;
  let lastCheckedAt = 0;

  return {
    async tick(now = Date.now()) {
      if (running || now - lastCheckedAt < intervalMs) return { skipped: true, reason: running ? "running" : "interval" };
      lastCheckedAt = now;
      const preset = readLandsraadVendorOverridePreset(config);
      if (!preset.enabled || !preset.vendorKeys.length) return { skipped: true, reason: "disabled" };
      const db = getDb?.();
      if (!db) return { skipped: true, reason: "database-unavailable" };

      running = true;
      try {
        const term = await db.query(`
          select term_id::text as term_id
          from dune.landsraad_decree_term
          order by term_id desc
          limit 1`);
        const termId = term.rows[0]?.term_id || null;
        if (!termId) return { skipped: true, reason: "no-term" };
        if (String(preset.lastAppliedTermId || "") === String(termId)) return { skipped: true, reason: "already-applied", termId };

        const result = await applyPreset(db, { vendorKeys: preset.vendorKeys, mode: preset.mode, allowOverrideResolvedTerm: false });
        const next = {
          ...preset,
          lastAppliedTermId: result.applied ? String(result.termId) : preset.lastAppliedTermId,
          lastAppliedAt: result.applied ? new Date(now).toISOString() : preset.lastAppliedAt,
          lastResult: result.applied ? `Applied Automatically - ${result.decreeName}` : String(result.reason || "Waiting")
        };
        writePreset(config, next);
        return { skipped: false, preset: next, result };
      } finally {
        running = false;
      }
    }
  };
}

export function normalizeLandsraadVendorOverridePreset(input = {}, options = {}) {
  if (typeof input.enabled !== "boolean") throw new Error("Automatic Landsraad vendor override must be enabled or disabled.");
  const mode = input.mode === "rotate" ? "rotate" : "fixed";
  if (!Array.isArray(input.vendorKeys) || (!options.allowEmpty && !input.vendorKeys.length)) {
    throw new Error(options.allowEmpty
      ? "Landsraad vendor override presets support up to 4 vendor types."
      : "Select at least one Landsraad vendor type.");
  }
  const validKeys = new Set(["vehicles", "weapons", "armor", "utilities"]);
  const vendorKeys = input.vendorKeys.map((key) => String(key));
  for (const key of vendorKeys) {
    if (!validKeys.has(key)) throw new Error(`"${key}" is not a supported Landsraad vendor type.`);
  }
  if (new Set(vendorKeys).size !== vendorKeys.length) throw new Error("Each Landsraad vendor type can only be selected once.");
  return { enabled: input.enabled, mode, vendorKeys };
}

function nullableTermId(value) {
  const termId = String(value ?? "").trim();
  return termId || null;
}

function presetPath(config) {
  return config.landsraadVendorOverridePresetFile
    || resolve(config.generatedDir || resolve(config.repoRoot, "runtime/generated"), "landsraad-vendor-override.json");
}

function writePreset(config, value) {
  const file = presetPath(config);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, ...value, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o664 });
  renameSync(temporary, file);
  try { chmodSync(file, 0o664); } catch {}
}
