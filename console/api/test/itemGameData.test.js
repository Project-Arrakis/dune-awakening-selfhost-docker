import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadItemGameData, withItemGameData } from "../src/itemGameData.js";
import { listCatalogItems, resolveItemStackSize, resolveItemVolume } from "../src/adminCatalog.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = join(repoRoot, "runtime/data");
const shipped = JSON.parse(readFileSync(join(dataDir, "item-game-data.json"), "utf8"));

function tempRepo(t, catalog, gameData) {
  const root = mkdtempSync(join(tmpdir(), "dune-item-game-data-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "runtime/data"), { recursive: true });
  writeFileSync(join(root, "runtime/data/admin-items.json"), JSON.stringify(catalog));
  if (gameData !== undefined) writeFileSync(join(root, "runtime/data/item-game-data.json"), typeof gameData === "string" ? gameData : JSON.stringify(gameData));
  return root;
}

// Pinned so a refresh is a deliberate, reviewed change
// (runtime/data/item-game-data.PROVENANCE.md).
test("the shipped game data has a volume and a stack limit for every item", () => {
  const ids = Object.keys(shipped.volume);
  assert.equal(ids.length, 4227);
  assert.deepEqual(Object.keys(shipped.maxStack), ids);
  assert.ok(Object.values(shipped.volume).every((value) => Number.isFinite(value) && value >= 0));
  assert.ok(Object.values(shipped.maxStack).every((value) => Number.isInteger(value) && value >= 1));
  assert.equal(Object.values(shipped.maxStack).filter((value) => value > 1).length, 221);
  assert.match(shipped.source.gameBuild, /^\d+$/);
  assert.equal(shipped.source.tables.length, 20);
});

test("an id two tables list takes the later table's row", () => {
  assert.equal(shipped.volume.Thumper, 2);
  assert.equal(shipped.volume.Stilltent, 2.5);
  assert.equal(shipped.volume.Halloween2026_Radsuit_Variant, 0);
});

// The ids left without data have no row in the game's tables. admin-items.json has
// 46 of them; one is a building patent, which the item list leaves out.
test("only the catalog ids the game does not define have no volume", () => {
  const unknown = [...new Set(listCatalogItems(repoRoot, { limit: 10000 }).filter((row) => row.volume === undefined).map((row) => row.itemId))];
  assert.equal(unknown.length, 45, unknown.join(", "));
  assert.ok(!unknown.includes("MTX_Neut_DesertMechanicSet02_Patent"));
  assert.ok(!Object.hasOwn(shipped.volume, "MTX_Neut_DesertMechanicSet02_Patent"));
  assert.ok(unknown.every((id) => !Object.hasOwn(shipped.volume, id)));
});

test("a curated catalog value wins over the game data", () => {
  // Curated at volume 1; the game table says 0.1.
  assert.equal(shipped.volume.T2MuaddibComponent, 0.1);
  assert.equal(resolveItemVolume(repoRoot, "T2MuaddibComponent"), 1);
  assert.equal(resolveItemStackSize(repoRoot, "T2MuaddibComponent"), 1);
});

test("the game data fills the gaps the catalog leaves", () => {
  assert.equal(resolveItemVolume(repoRoot, "Combat_Light_Unique_BeneGeserit_Top"), 2);
  assert.equal(resolveItemStackSize(repoRoot, "Combat_Light_Unique_BeneGeserit_Top"), 1);
  const row = listCatalogItems(repoRoot, { q: "HealthPackSchematic", limit: 10 }).find((item) => item.itemId === "HealthPackSchematic");
  assert.equal(row.volume, 0);
  assert.equal(row.stackSize, 1);
});

test("an item neither file knows keeps no volume and no stack limit", () => {
  assert.equal(resolveItemVolume(repoRoot, "Combat_Light_B1C4_Unique_Top1"), 0);
  assert.equal(resolveItemStackSize(repoRoot, "Combat_Light_B1C4_Unique_Top1"), 0);
});

test("lookup ignores case unless two ids differ only by case", (t) => {
  const root = tempRepo(t, [], { volume: { SwordOne: 2, Twin: 1, twin: 3 }, maxStack: {} });
  const data = loadItemGameData(join(root, "runtime/data/admin-items.json"));
  assert.equal(data.get("swordone").volume, 2);
  assert.equal(data.get("Twin").volume, 1);
  assert.equal(data.get("twin").volume, 3);
  assert.equal(data.get("TWIN"), null);
  assert.equal(data.get("constructor"), null);
  assert.equal(data.get("__proto__"), null);
});

test("wrongly typed rows are skipped", (t) => {
  const root = tempRepo(t, [], { volume: { A: "2", B: -1, C: null, D: 1 }, maxStack: { D: "500" } });
  const data = loadItemGameData(join(root, "runtime/data/admin-items.json"));
  for (const id of ["A", "B", "C"]) assert.equal(data.get(id), null);
  assert.deepEqual({ ...data.get("D") }, { volume: 1, stackSize: 1 });
});

for (const [name, content] of [["missing", undefined], ["not JSON", "{"], ["the wrong shape", { volume: [] }]]) {
  test(`a ${name} game data file leaves the catalog as it was`, (t) => {
    const root = tempRepo(t, [{ id: "SteelBar", name: "Steel Bar", category: "resources" }], content);
    assert.equal(resolveItemVolume(root, "SteelBar"), 0);
    assert.equal(resolveItemStackSize(root, "SteelBar"), 0);
    assert.equal(listCatalogItems(root).length, 1);
  });
}

test("a changed game data file is picked up", (t) => {
  const root = tempRepo(t, [{ id: "SteelBar", name: "Steel Bar", category: "resources" }]);
  assert.equal(resolveItemVolume(root, "SteelBar"), 0);
  writeFileSync(join(root, "runtime/data/item-game-data.json"), JSON.stringify({ volume: { SteelBar: 0.5 }, maxStack: { SteelBar: 500 } }));
  assert.equal(resolveItemVolume(root, "SteelBar"), 0.5);
  assert.equal(resolveItemStackSize(root, "SteelBar"), 500);
});

test("merging does not change the row it was given", () => {
  const row = { id: "X" };
  const merged = withItemGameData(row, { get: () => ({ volume: 1, stackSize: 1 }) });
  assert.deepEqual(row, { id: "X" });
  assert.deepEqual(merged, { id: "X", volume: 1, stackSize: 1 });
});
