import * as duneDb from "../duneDb.js";
import { resolveMapCombatState } from "./mapCombatState.js";
import { resolveCoriolisCycle } from "./coriolisSeed.js";
import { resolveSandstormStatus } from "./sandstormStatus.js";

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

async function sietchesForMap(config, displayMap, combatMap, db, mapCombatPartitionRows, resolveCombatState, resolveStorm) {
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
      sandstormActive: sandstorm.active,
      sandstormLastStartAt: sandstorm.lastStartAt
    };
  }));
}

export async function buildSietchAtlas(config, db, {
  mapCombatPartitionRows = duneDb.mapCombatPartitionRows,
  resolveCombatState = resolveMapCombatState,
  resolveCycle = resolveCoriolisCycle,
  resolveStorm = resolveSandstormStatus,
  maps = ATLAS_MAPS
} = {}) {
  const [coriolis, ...sietchesByMap] = await Promise.all([
    resolveCycle({ map: "HaggaBasin" }).catch(() => ({ seed: null, nextCycleAt: null })),
    ...maps.map(({ displayMap, combatMap }) => sietchesForMap(config, displayMap, combatMap, db, mapCombatPartitionRows, resolveCombatState, resolveStorm))
  ]);

  const sietches = {};
  maps.forEach(({ displayMap }, index) => { sietches[displayMap] = sietchesByMap[index]; });

  return {
    coriolisSeed: coriolis.seed || null,
    coriolisNextCycleAt: coriolis.nextCycleAt || null,
    sietches
  };
}
