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
const ATLAS_MAPS = ["HaggaBasin", "DeepDesert"];

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

async function sietchesForMap(config, map, db, mapCombatPartitionRows, resolveCombatState, resolveStorm) {
  const partitionResult = await mapCombatPartitionRows(db, map).catch(() => ({ rows: [], capabilities: { combatState: false } }));
  const rows = partitionRowsFromCombatResult(partitionResult);
  if (rows.length === 0) return [];
  const combat = await resolveCombatState(config, map, rows);
  return Promise.all(combat.partitions.map(async (partition) => {
    const sandstorm = await resolveStorm({ map, partitionId: partition.partitionId }).catch(() => ({ active: false, lastStartAt: null }));
    return {
      map: partition.map,
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
    ...maps.map((map) => sietchesForMap(config, map, db, mapCombatPartitionRows, resolveCombatState, resolveStorm))
  ]);

  const sietches = {};
  maps.forEach((map, index) => { sietches[map] = sietchesByMap[index]; });

  return {
    coriolisSeed: coriolis.seed || null,
    coriolisNextCycleAt: coriolis.nextCycleAt || null,
    sietches
  };
}
