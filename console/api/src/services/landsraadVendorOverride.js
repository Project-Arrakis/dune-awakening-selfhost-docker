import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { applyLandsraadVendorOverride, revertLandsraadVendorOverride } from "../duneDb.js";

const DEFAULT_PRESET = {
  enabled: false,
  vendorKeys: [],
  mode: "fixed",
  houseFaction: null,
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
    && previous.houseFaction === settings.houseFaction
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

// allowOverrideResolvedTerm must be explicitly true (only ever sent by the
// UI's "Force Now" after its own stronger, already-resolved-term-specific
// confirm dialog -- see LandsraadPanel.tsx) to override a term that has
// already organically resolved. This is a real, separate flag rather than
// implied by "this came from the manual save-and-apply route" (2026-09-11
// Layer 2 audit, Security Architect hat finding): a bare "save my preset"
// POST -- e.g. an operator just enabling the automatic-reconciler toggle,
// or any other direct API caller -- must never be able to silently discard
// a real win just by virtue of hitting the same endpoint the UI's Force
// Now button also uses.
export async function applySavedLandsraadVendorOverride(config, db, { allowOverrideResolvedTerm = false } = {}) {
  const preset = readLandsraadVendorOverridePreset(config);
  if (!preset.vendorKeys.length) return { preset, result: { ok: true, applied: false, reason: "No Landsraad vendor override has been configured." } };
  const result = await applyLandsraadVendorOverride(db, {
    vendorKeys: preset.vendorKeys,
    mode: preset.mode,
    houseFaction: preset.houseFaction,
    allowOverrideResolvedTerm
  });
  const next = {
    ...preset,
    lastAppliedTermId: result.applied ? String(result.termId) : preset.lastAppliedTermId,
    lastAppliedAt: result.applied ? new Date().toISOString() : preset.lastAppliedAt,
    lastResult: result.applied
      ? `Applied - ${result.decreeName}${result.houseFactionName ? ` - ${result.houseFactionName} winning` : ""}`
      : String(result.reason || "Waiting")
  };
  writePreset(config, next);
  return { preset: next, result };
}

export async function revertSavedLandsraadVendorOverride(config, db) {
  const result = await revertLandsraadVendorOverride(db);
  const preset = readLandsraadVendorOverridePreset(config);
  const next = {
    ...preset,
    lastAppliedTermId: result.applied ? null : preset.lastAppliedTermId,
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

        const result = await applyPreset(db, { vendorKeys: preset.vendorKeys, mode: preset.mode, houseFaction: preset.houseFaction, allowOverrideResolvedTerm: false });
        const next = {
          ...preset,
          lastAppliedTermId: result.applied ? String(result.termId) : preset.lastAppliedTermId,
          lastAppliedAt: result.applied ? new Date(now).toISOString() : preset.lastAppliedAt,
          lastResult: result.applied
            ? `Applied Automatically - ${result.decreeName}${result.houseFactionName ? ` - ${result.houseFactionName} winning` : ""}`
            : String(result.reason || "Waiting")
        };
        writePreset(config, next);
        return { skipped: false, preset: next, result };
      } finally {
        running = false;
      }
    }
  };
}

// houseFaction is deliberately validated against the same narrow allow-list
// duneDb.js's LANDSRAAD_HOUSE_FACTION_NAMES uses (kept as a second, small,
// independently-maintained copy here rather than importing duneDb.js's
// internal constant -- this file is DB-agnostic by design, matching
// landsraadMilestones.js's own preset-layer/DB-layer separation). Both
// layers validate; neither trusts the other alone (design doc §9, Security
// Architect L1 audit finding on duneDb.js's parallel validKeys precedent).
const VALID_HOUSE_FACTIONS = new Set(["atreides", "harkonnen"]);

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
  const houseFaction = input.houseFaction == null || input.houseFaction === "" ? null : String(input.houseFaction);
  if (houseFaction != null && !VALID_HOUSE_FACTIONS.has(houseFaction)) {
    throw new Error(`"${houseFaction}" is not a supported Landsraad house.`);
  }
  return { enabled: input.enabled, mode, vendorKeys, houseFaction };
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
