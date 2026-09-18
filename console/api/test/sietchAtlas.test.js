import test from "node:test";
import assert from "node:assert/strict";
import { buildSietchAtlas } from "../src/services/sietchAtlas.js";

const config = {};
const db = {};
const MAPS = [
  { displayMap: "HaggaBasin", combatMap: "Survival_1" },
  { displayMap: "DeepDesert", combatMap: "DeepDesert_1" }
];

function combatRowsFor(partitionIds) {
  return {
    rows: partitionIds.map((id) => ({ partition_id: id, dimension_index: 0, database_label: null, server_id: `srv-${id}`, ready: true, alive: true, blocked: false })),
    capabilities: { combatState: true }
  };
}

// Real bug, caught live on first deploy (2026-09-18): resolveMapCombatState/
// mapCombatPartitionRows key off dune.world_partition's internal map name
// ("Survival_1"/"DeepDesert_1"), not the display name ("HaggaBasin"/
// "DeepDesert") sandstorm/Coriolis use -- passing the display name straight
// through silently returned zero rows for every real sietch.
test("buildSietchAtlas queries combat state with the internal map name, but reports/sandstorm-checks with the display name", async () => {
  const seenCombatMaps = [];
  const seenStormMaps = [];
  const result = await buildSietchAtlas(config, db, {
    maps: MAPS,
    mapCombatPartitionRows: async (_db, map) => { seenCombatMaps.push(map); return combatRowsFor(["1"]); },
    resolveCombatState: async (_config, map, rows) => ({
      map, mapState: "PVE",
      partitions: rows.map((row) => ({ map, partitionId: row.partitionId, serverDisplayName: "Sietch", runtimeStatus: "RUNNING", configuredState: "PVE" }))
    }),
    resolveCycle: async () => ({ seed: "cor-6", nextCycleAt: null }),
    resolveStorm: async ({ map }) => { seenStormMaps.push(map); return { active: false, lastStartAt: null }; }
  });

  assert.deepEqual(seenCombatMaps.sort(), ["DeepDesert_1", "Survival_1"]);
  assert.deepEqual(seenStormMaps.sort(), ["DeepDesert", "HaggaBasin"]);
  assert.equal(result.sietches.HaggaBasin[0].map, "HaggaBasin");
  assert.equal(result.sietches.DeepDesert[0].map, "DeepDesert");
});

test("buildSietchAtlas returns the farm-wide Coriolis cycle plus per-map sietch lists", async () => {
  const result = await buildSietchAtlas(config, db, {
    maps: MAPS,
    mapCombatPartitionRows: async (_db, map) => combatRowsFor(map === "Survival_1" ? ["1", "37"] : ["8"]),
    resolveCombatState: async (_config, map, rows) => ({
      map,
      mapState: "MIXED",
      partitions: rows.map((row) => ({
        map,
        partitionId: row.partitionId,
        serverDisplayName: `Display ${row.partitionId}`,
        runtimeStatus: "RUNNING",
        configuredState: row.partitionId === "37" ? "PVP" : "PVE"
      }))
    }),
    resolveCycle: async () => ({ seed: "cor-6", nextCycleAt: "2026-09-22T11:00:00.000Z" }),
    resolveStorm: async ({ partitionId }) => ({ active: partitionId === "8", lastStartAt: partitionId === "8" ? "2026-09-17T21:14:51.115Z" : null })
  });

  assert.equal(result.coriolisSeed, "cor-6");
  assert.equal(result.coriolisNextCycleAt, "2026-09-22T11:00:00.000Z");
  assert.equal(result.sietches.HaggaBasin.length, 2);
  assert.equal(result.sietches.HaggaBasin[0].combatState, "PVE");
  assert.equal(result.sietches.HaggaBasin[1].combatState, "PVP");
  assert.equal(result.sietches.HaggaBasin[0].sandstormActive, false);
  assert.equal(result.sietches.DeepDesert.length, 1);
  assert.equal(result.sietches.DeepDesert[0].sandstormActive, true);
  assert.equal(result.sietches.DeepDesert[0].sandstormLastStartAt, "2026-09-17T21:14:51.115Z");
});

test("buildSietchAtlas returns an empty sietch list for a map with no partitions instead of throwing", async () => {
  const result = await buildSietchAtlas(config, db, {
    maps: MAPS,
    mapCombatPartitionRows: async (_db, map) => map === "DeepDesert_1" ? { rows: [], capabilities: { combatState: false } } : combatRowsFor(["1"]),
    resolveCombatState: async (_config, map, rows) => ({
      map,
      mapState: "PVE",
      partitions: rows.map((row) => ({ map, partitionId: row.partitionId, serverDisplayName: "Sietch", runtimeStatus: "RUNNING", configuredState: "PVE" }))
    }),
    resolveCycle: async () => ({ seed: "cor-6", nextCycleAt: null }),
    resolveStorm: async () => ({ active: false, lastStartAt: null })
  });
  assert.deepEqual(result.sietches.DeepDesert, []);
  assert.equal(result.sietches.HaggaBasin.length, 1);
});

test("buildSietchAtlas degrades to a null Coriolis cycle rather than failing the whole atlas", async () => {
  const result = await buildSietchAtlas(config, db, {
    maps: [MAPS[0]],
    mapCombatPartitionRows: async () => combatRowsFor(["1"]),
    resolveCombatState: async (_config, map, rows) => ({
      map,
      mapState: "PVE",
      partitions: rows.map((row) => ({ map, partitionId: row.partitionId, serverDisplayName: "Sietch", runtimeStatus: "RUNNING", configuredState: "PVE" }))
    }),
    resolveCycle: async () => { throw new Error("docker logs failed"); },
    resolveStorm: async () => ({ active: false, lastStartAt: null })
  });
  assert.equal(result.coriolisSeed, null);
  assert.equal(result.coriolisNextCycleAt, null);
  assert.equal(result.sietches.HaggaBasin.length, 1);
});

test("buildSietchAtlas degrades a single sietch's storm lookup failure to inactive rather than dropping the sietch", async () => {
  const result = await buildSietchAtlas(config, db, {
    maps: [MAPS[0]],
    mapCombatPartitionRows: async () => combatRowsFor(["1"]),
    resolveCombatState: async (_config, map, rows) => ({
      map,
      mapState: "PVE",
      partitions: rows.map((row) => ({ map, partitionId: row.partitionId, serverDisplayName: "Sietch", runtimeStatus: "RUNNING", configuredState: "PVE" }))
    }),
    resolveCycle: async () => ({ seed: "cor-6", nextCycleAt: null }),
    resolveStorm: async () => { throw new Error("docker logs failed"); }
  });
  assert.equal(result.sietches.HaggaBasin.length, 1);
  assert.equal(result.sietches.HaggaBasin[0].sandstormActive, false);
  assert.equal(result.sietches.HaggaBasin[0].sandstormLastStartAt, null);
});
