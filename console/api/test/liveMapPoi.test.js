import test from "node:test";
import assert from "node:assert/strict";
import { liveMapPoi, liveMapSubtypeLabel, POI_CATEGORIES } from "../src/services/liveMapPoi.js";

test("liveMapPoi runs every registered category and merges rows/capabilities", async () => {
  const fetchCategory = async (db, map, category) => {
    if (category === "ore") return { capabilities: { ore: true }, rows: [{ id: "1", marker_type: "RhyoliteOre", map: "HaggaBasin", x: 100, y: 200, z: 300 }] };
    return { capabilities: { [category]: false }, rows: [] };
  };
  const result = await liveMapPoi(null, "HaggaBasin", { fetchCategory });
  assert.equal(result.capabilities.ore, true);
  assert.equal(result.capabilities.scrap, false);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], { id: "1", type: "ore", name: "RhyoliteOre", subtype: "RhyoliteOre", subtypeLabel: "Granite", map: "HaggaBasin", x: 100, y: 200, z: 300 });
  assert.ok(result.knownSubtypes.ore.includes("JasmiumOre"));
  assert.ok(result.knownSubtypes.ore.includes("StravidiumOre"));
  assert.ok(result.knownSubtypes.ore.includes("TitaniumOre"));
});

test("ore marker identifiers receive their player-facing resource names", () => {
  assert.equal(liveMapSubtypeLabel("ore", "AzuriteOre"), "Copper");
  assert.equal(liveMapSubtypeLabel("ore", "BauxitePickup"), "Aluminium");
  assert.equal(liveMapSubtypeLabel("ore", "DolomiteRock"), "Carbon");
  assert.equal(liveMapSubtypeLabel("ore", "MagnetiteOre"), "Iron");
  assert.equal(liveMapSubtypeLabel("ore", "RhyoliteOre"), "Granite");
  assert.equal(liveMapSubtypeLabel("ore", "FutureiumOre"), "Futureium");
});

test("one category failing doesn't take down the others", async () => {
  const fetchCategory = async (db, map, category) => {
    if (category === "scrap") throw new Error("boom");
    return { capabilities: { [category]: true }, rows: [{ id: category, marker_type: category, map: "HaggaBasin", x: 0, y: 0, z: 0 }] };
  };
  const result = await liveMapPoi(null, "HaggaBasin", { fetchCategory });
  assert.equal(result.capabilities.scrap, false);
  assert.equal(result.capabilities.ore, true);
  assert.equal(result.rows.filter((r) => r.type === "scrap").length, 0);
  assert.equal(result.rows.filter((r) => r.type === "ore").length, 1);
});

test("POI_CATEGORIES registry has the 9 expected real categories", () => {
  assert.deepEqual(POI_CATEGORIES.map((c) => c.key).sort(), [
    "enemy", "flora", "fortress", "hazard", "house_representative", "ore", "poi", "scrap", "trainer"
  ]);
});
