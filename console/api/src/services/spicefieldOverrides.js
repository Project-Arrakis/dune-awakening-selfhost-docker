import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

const EDITABLE_COLUMNS = [
  "max_globally_active",
  "max_globally_primed",
  "is_spawning_active",
  "global_spawn_weight"
];

export function persistSpicefieldOverride(config, row) {
  const file = config.spicefieldOverridesFile;
  if (!file) throw new Error("Spice Field override storage is not configured.");
  const id = Number(row?.spicefield_type_id);
  if (!Number.isInteger(id) || id < 1) throw new Error("Cannot persist Spice Field override without a valid type id.");

  const current = readSpicefieldOverrides(file);
  const overrides = { ...(current.overrides || {}) };
  const saved = {
    spicefield_type_id: id,
    map_name: row.map_name ?? "",
    field_type: row.field_type ?? "",
    dimension_index: row.dimension_index ?? null,
    updatedAt: new Date().toISOString()
  };
  for (const column of EDITABLE_COLUMNS) {
    saved[column] = row[column];
  }
  overrides[String(id)] = saved;

  const next = {
    schemaVersion: 1,
    updatedAt: saved.updatedAt,
    overrides
  };
  writeJsonAtomic(file, next);
  return { ok: true, file, overrideCount: Object.keys(overrides).length };
}

export function readSpicefieldOverrides(file) {
  if (!file || !existsSync(file)) return { schemaVersion: 1, overrides: {} };
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { schemaVersion: 1, overrides: {} };
  const overrides = parsed.overrides && typeof parsed.overrides === "object" && !Array.isArray(parsed.overrides) ? parsed.overrides : {};
  return {
    schemaVersion: parsed.schemaVersion || 1,
    updatedAt: parsed.updatedAt || "",
    overrides
  };
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o664 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o664);
  } catch {
    // Best effort on non-POSIX development hosts.
  }
}
