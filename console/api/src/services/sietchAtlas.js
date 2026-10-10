import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import * as duneDb from "../duneDb.js";
import { resolveMapCombatState } from "./mapCombatState.js";
import { resolveCoriolisCycle } from "./coriolisSeed.js";
import { resolveSandstormStatus } from "./sandstormStatus.js";
import { readModifiersByScope } from "./publicDirectory.js";

// Public, per-sietch/per-Deep-Desert-instance summary for #the-atlas
// (dune-awakening-selfhost-docker#938, mentat#376): PvP/PvE, live sandstorm
// status, and the farm-wide Coriolis cycle, in one call. Reuses three
// already-established services rather than reimplementing any of them, so
// this stays in agreement with the Live Map and combat-state routes it's
// built from:
//   - resolveMapCombatState (mapCombatState.js) for PvP/PvE + display name,
//     the same resolver /api/maps/combat-state and the Live Map dropdown use
//   - resolveCoriolisCycle (coriolisSeed.js) for the weekly cycle, farm-wide
//   - resolveSandstormStatus (sandstormStatus.js) for the frequent random
//     storm, genuinely per-partition
//
// Sandworm/storm-cadence config (usersettings.py's partition_engine scope)
// is deliberately NOT included yet -- tracked as a fast-follow, not blocking
// the first real #the-atlas content.
//
// Real bug, caught live on first deploy (2026-09-18): resolveMapCombatState/
// mapCombatPartitionRows key off dune.world_partition's own internal map
// name ("Survival_1"/"DeepDesert_1"), NOT the Live Map's display/actorMap
// name ("HaggaBasin"/"DeepDesert") that resolveCoriolisCycle/
// resolveSandstormStatus use -- exactly the two-name-space split
// LiveMapPanel.tsx's own LIVE_MAP_TO_COMBAT_STATE_MAP already exists to
// bridge (HaggaBasin -> Survival_1, DeepDesert -> DeepDesert_1), which this
// service missed on first pass and passed "HaggaBasin"/"DeepDesert"
// straight into the combat-state resolver, silently returning zero rows for
// every real sietch. Track both names explicitly per map instead of
// assuming they're the same string.
const ATLAS_MAPS = [
  { displayMap: "HaggaBasin", combatMap: "Survival_1" },
  { displayMap: "DeepDesert", combatMap: "DeepDesert_1" }
];

// The real login password for a Survival_1 sietch (Bgd.ServerLoginPassword,
// set via `dune sietches set-password`/`set-settings`). Every other reader
// of this field in this codebase (the CLI's `list`/`show`, the web
// console's MapsPanel SecretInput) is deliberately write-only and never
// echoes the real value back -- this is the first read path for the actual
// plaintext, added specifically so #the-atlas can show it to the
// Naib/Fedaykin/Crysknife-Bearer-restricted channel players need it to
// actually log into the sietch (mentat#376, dune-awakening-selfhost-docker#938).
function sietchLoginPassword(config, partitionId) {
  if (!config?.repoRoot) return null;
  try {
    const cfgPath = resolve(config.repoRoot, "runtime/generated/sietch-config.json");
    if (!existsSync(cfgPath)) return null;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const value = cfg?.partitions?.[String(partitionId)]?.password;
    return value ? String(value) : null;
  } catch {
    return null;
  }
}

function partitionRowsFromCombatResult(result) {
  if (result?.capabilities?.combatState === false || !Array.isArray(result?.rows)) return [];
  return result.rows.map((row) => ({
    partitionId: row.partition_id,
    dimensionIndex: row.dimension_index,
    databaseLabel: row.database_label || null,
    serverId: row.server_id || "",
    ready: Boolean(row.ready),
    alive: Boolean(row.alive),
    blocked: Boolean(row.blocked)
  }));
}

async function sietchesForMap(config, displayMap, combatMap, db, mapCombatPartitionRows, resolveCombatState, resolveStorm, partitionModifiers, includePasswords) {
  const partitionResult = await mapCombatPartitionRows(db, combatMap).catch(() => ({ rows: [], capabilities: { combatState: false } }));
  const rows = partitionRowsFromCombatResult(partitionResult);
  if (rows.length === 0) return [];
  const combat = await resolveCombatState(config, combatMap, rows);
  return Promise.all(combat.partitions.map(async (partition) => {
    const sandstorm = await resolveStorm({ map: displayMap, partitionId: partition.partitionId }).catch(() => ({ active: false, lastStartAt: null }));
    return {
      map: displayMap,
      partitionId: partition.partitionId,
      serverDisplayName: partition.serverDisplayName,
      runtimeStatus: partition.runtimeStatus,
      combatState: partition.configuredState,
      // [Security fix, real finding from automated PR review, 2026-09-27]
      // ATLAS_READ is public tier (policy.js CAPABILITY_BY_TIER) -- ANY
      // Discord actor who can reach this route gets this payload,
      // regardless of which channel mentat happens to post it into. A
      // Discord channel permission lock only restricts who can SEE the
      // message mentat posts; it does nothing to the underlying API this
      // route serves. loginPassword must never be included unless the
      // CALLING ACTOR's own roles are independently verified here, not
      // merely assumed safe because of an unrelated channel lock.
      loginPassword: includePasswords ? sietchLoginPassword(config, partition.partitionId) : null,
      sandstormActive: sandstorm.active,
      sandstormLastStartAt: sandstorm.lastStartAt,
      // Real operator request (2026-09-18): show what's configured
      // differently from default, globally (worldModifiers, top-level) and
      // per sietch (only genuine overrides -- see readModifiersByScope's
      // own comment for why a value shared with the global config isn't
      // redundantly repeated here).
      modifiers: partitionModifiers[`${combatMap}:${partition.partitionId}`] || {}
    };
  }));
}

function defaultReadModifiers(config) {
  return readModifiersByScope(resolve(config.repoRoot, "runtime/generated/gameplay-profile.ini"));
}

export async function buildSietchAtlas(config, db, {
  mapCombatPartitionRows = duneDb.mapCombatPartitionRows,
  resolveCombatState = resolveMapCombatState,
  resolveCycle = resolveCoriolisCycle,
  resolveStorm = resolveSandstormStatus,
  readModifiers = defaultReadModifiers,
  maps = ATLAS_MAPS,
  includePasswords = false
} = {}) {
  let modifiersByScope;
  try {
    modifiersByScope = readModifiers(config);
  } catch {
    modifiersByScope = { global: {}, partitions: {} };
  }

  const [coriolis, ...sietchesByMap] = await Promise.all([
    resolveCycle({ map: "HaggaBasin" }).catch(() => ({ seed: null, nextCycleAt: null })),
    ...maps.map(({ displayMap, combatMap }) => sietchesForMap(config, displayMap, combatMap, db, mapCombatPartitionRows, resolveCombatState, resolveStorm, modifiersByScope.partitions, includePasswords))
  ]);

  const sietches = {};
  maps.forEach(({ displayMap }, index) => { sietches[displayMap] = sietchesByMap[index]; });

  return {
    coriolisSeed: coriolis.seed || null,
    coriolisNextCycleAt: coriolis.nextCycleAt || null,
    worldModifiers: modifiersByScope.global,
    sietches
  };
}
