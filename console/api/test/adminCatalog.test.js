import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildingUnlockStatus, isFillableItem, itemImagePath, itemIsRankedSchematic, itemIsSchematic, itemRequiresDatabaseGrant, listBuildingUnlockItems, listCatalogItems, resolveCatalogItem, resolveFillableCatalogItem, resolveItemVolume } from "../src/adminCatalog.js";

const REAL_REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "web-admin-catalog-"));
  mkdirSync(join(root, "runtime/data"), { recursive: true });
  writeFileSync(join(root, "runtime/data/admin-items.json"), JSON.stringify([
    { id: "PlantFiber", name: "Plant Fiber", category: "materials", source: "Resources" },
    { id: "CupOfWater", name: "Cup of Water", category: "consumables", source: "Survival" },
    { id: "ChoamHeavyLasgunSchematic", name: "Arhun K-28 Lasgun", category: "schematics", source: "Schematics" },
    { id: "ArmorPiercingAugment", name: "Armor Piercing Augment", category: "augments", source: "Items" },
    { id: "SteelBar", name: "Steel Ingot", category: "resources", source: "Resources", group: "refined_resource", volume: 1.0 },
    { id: "T6RefinedResourceA", name: "Plastanium Ingot", category: "resources", source: "Resources", group: "refined_resource", volume: 1.0 },
    { id: "FremenComponent1", name: "EMF Generator", category: "resources", source: "Resources", group: "component", volume: 1.0 },
    { id: "AzuriteOre", name: "Copper Ore", category: "resources", source: "Resources", group: "raw_resource", volume: 0.2 },
    { id: "BasicLighting_Patent", name: "Basic Lighting", category: "buildings", source: "BuildingSets" },
    { id: "Developer_Storage_Container_Patent", name: "Developer Storage Container", category: "buildings", source: "BuildingSets" }
  ]));
  return root;
}

test("catalog item list returns real item rows only", () => {
  const rows = listCatalogItems(fixtureRepo(), { q: "fiber" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Plant Fiber");
  assert.equal(rows[0].itemId, "PlantFiber");
  assert.equal(rows[0].category, "materials");
  assert.notEqual(rows[0].name, "category");
  assert.notEqual(rows[0].name, "source");
});

test("building patent tokens are isolated while Developer Storage remains available to shared item selectors", () => {
  const root = fixtureRepo();
  assert.equal(listCatalogItems(root, { q: "lighting" }).length, 0);
  const sharedDeveloperStorage = listCatalogItems(root, { q: "developer storage" });
  assert.equal(sharedDeveloperStorage.length, 1);
  assert.equal(sharedDeveloperStorage[0].itemId, "Developer_Storage_Container_Patent");

  const unlocks = listBuildingUnlockItems(root);
  assert.equal(unlocks.length, 2);
  assert.equal(unlocks.find((row) => row.itemId === "BasicLighting_Patent")?.group, "Furniture & Decorations");
  assert.equal(unlocks.find((row) => row.itemId === "Developer_Storage_Container_Patent")?.experimental, true);
  assert.equal(buildingUnlockStatus("BasicLighting_Patent", { owned: ["BasicLighting"], pending: [] }), "Owned");
  assert.equal(buildingUnlockStatus("BasicLighting_Patent", { owned: [], pending: ["BasicLighting_Patent"] }), "Pending");
  assert.equal(buildingUnlockStatus("BasicLighting_Patent", { owned: [], pending: [] }), "Available");
  assert.equal(buildingUnlockStatus("BasicLighting_Patent", { owned: [], pending: [], supported: false }), "Unknown");
});

test("catalog resolver rejects duplicate display names instead of silently selecting one", () => {
  const root = fixtureRepo();
  const file = join(root, "runtime/data/admin-items.json");
  const rows = JSON.parse(readFileSync(file, "utf8"));
  rows.push({ id: "PlantFiber_Schematic", name: "Plant Fiber", category: "schematics", source: "Schematics" });
  writeFileSync(file, JSON.stringify(rows));
  assert.throws(() => resolveCatalogItem(root, { itemName: "Plant Fiber" }), /Ambiguous item name/);
  assert.equal(resolveCatalogItem(root, { itemId: "PlantFiber_Schematic" }).itemId, "PlantFiber_Schematic");
});

test("catalog resolver rejects metadata as item names", () => {
  const root = fixtureRepo();
  assert.equal(resolveCatalogItem(root, { itemName: "Plant Fiber" }).itemId, "PlantFiber");
  assert.throws(() => resolveCatalogItem(root, { itemName: "category" }), /No item found/);
  assert.throws(() => resolveCatalogItem(root, { itemName: "source" }), /No item found/);
});

test("catalog marks schematics and augments for database grants", () => {
  const root = fixtureRepo();
  assert.equal(itemRequiresDatabaseGrant(resolveCatalogItem(root, { itemName: "Arhun K-28 Lasgun" })), true);
  assert.equal(itemRequiresDatabaseGrant(resolveCatalogItem(root, { itemName: "Armor Piercing Augment" })), true);
  assert.equal(itemRequiresDatabaseGrant(resolveCatalogItem(root, { itemName: "Plant Fiber" })), false);
  assert.equal(itemRequiresDatabaseGrant(resolveCatalogItem(root, { itemId: "SchematicPattern_Sword" })), true);
  assert.equal(itemIsSchematic(resolveCatalogItem(root, { itemName: "Arhun K-28 Lasgun" })), true);
  assert.equal(itemIsSchematic(resolveCatalogItem(root, { itemName: "Armor Piercing Augment" })), false);
});

// Every normalized item stats its icon, and listCatalogItems normalizes up to
// 10,000 of them per request. Memoisation is only observable by moving the
// filesystem underneath the second lookup: it has to answer from the cache
// rather than notice a file that appeared in between.
test("item image lookups are resolved once per repo root", () => {
  const root = fixtureRepo();
  const images = join(root, "console/web/public/images/items");
  mkdirSync(images, { recursive: true });

  assert.equal(resolveCatalogItem(root, { itemId: "PlantFiber" }).image, "/images/items/image-unavailable.png");
  writeFileSync(join(images, "PlantFiber.png"), "");
  assert.equal(resolveCatalogItem(root, { itemId: "PlantFiber" }).image, "/images/items/image-unavailable.png");

  // Keyed by repo root, not global: another root resolves the same id fresh.
  const other = fixtureRepo();
  const otherImages = join(other, "console/web/public/images/items");
  mkdirSync(otherImages, { recursive: true });
  writeFileSync(join(otherImages, "PlantFiber.png"), "");
  assert.equal(resolveCatalogItem(other, { itemId: "PlantFiber" }).image, "/images/items/PlantFiber.png");
});

// The id becomes both a filesystem path and an <img src>. normalizeItem's id
// regex admits "." and "/", and baseInventory passes a raw template_id with no
// validation, so this is the only thing standing between a crafted id and a
// path outside the public directory.
test("item image ids cannot escape the images directory", () => {
  const root = fixtureRepo();
  mkdirSync(join(root, "console/web/public/images/items"), { recursive: true });
  // images/items sits five levels below the repo root, so this is the depth a
  // crafted id needs to land back on it. The file has to genuinely exist or the
  // assertion passes for the wrong reason -- an unreadable path and a rejected
  // one both come back unavailable.
  writeFileSync(join(root, "secret.png"), "");

  const unavailable = "/images/items/image-unavailable.png";
  for (const id of ["../../../../../secret", "..\\..\\..\\..\\..\\secret", "images/items/../../secret", "..", ".", "", "a/b"]) {
    const resolved = itemImagePath(root, id);
    assert.equal(resolved, unavailable, `id ${JSON.stringify(id)} must not resolve`);
    // Belt and braces: whatever comes back is also a URL, so it must never
    // carry path structure even if it did point at something real.
    assert.ok(!resolved.includes(".."), `id ${JSON.stringify(id)} leaked traversal into the URL`);
  }

  // The ordinary path is untouched.
  writeFileSync(join(root, "console/web/public/images/items/PlantFiber.png"), "");
  assert.equal(itemImagePath(root, "PlantFiber"), "/images/items/PlantFiber.png");
});

test("ranked physical schematics are distinguished from Grade 0 live grants", () => {
  const root = fixtureRepo();
  const schematic = resolveCatalogItem(root, { itemName: "Arhun K-28 Lasgun" });
  const normalItem = resolveCatalogItem(root, { itemName: "Plant Fiber" });
  assert.equal(itemIsRankedSchematic(schematic, 0), false);
  assert.equal(itemIsRankedSchematic(schematic, 5), true);
  assert.equal(itemIsRankedSchematic(normalItem, 5), false);
});

test("resolveFillableCatalogItem accepts refined resources", () => {
  const root = fixtureRepo();
  const item = resolveFillableCatalogItem(root, { itemId: "SteelBar" });
  assert.equal(item.group, "refined_resource");
  assert.equal(item.volume, 1.0);
});

test("resolveFillableCatalogItem accepts components", () => {
  const root = fixtureRepo();
  const item = resolveFillableCatalogItem(root, { itemId: "FremenComponent1" });
  assert.equal(item.group, "component");
});

test("resolveFillableCatalogItem accepts raw resources", () => {
  const root = fixtureRepo();
  const item = resolveFillableCatalogItem(root, { itemId: "AzuriteOre" });
  assert.equal(item.group, "raw_resource");
  assert.equal(item.volume, 0.2);
});

// Regression guard for the finding in resolveFillableCatalogItem's own
// comment (found during post-merge review of upstream PR #182, 2026-08-20:
// the comment previously claimed "today's 19 fillable items" -- stale, the
// real count is 99 once raw_resource was added to FILLABLE_GROUPS). The
// runtime safety check (throws on missing/zero volume) already covers this
// at request time, but this test catches a bad catalog edit at CI time
// instead of waiting for an operator to trip the runtime error -- and keeps
// the comment's "not currently triggerable" claim honest as the catalog
// grows.
test("every real, currently-fillable catalog item has a non-zero catalogued volume", () => {
  const items = JSON.parse(readFileSync(join(REAL_REPO_ROOT, "runtime/data/admin-items.json"), "utf8"));
  const missing = items
    .filter((item) => isFillableItem(item))
    .filter((item) => !(Number(item.volume) > 0))
    .map((item) => item.id);
  assert.deepEqual(missing, [],
    `${missing.length} fillable-group item(s) have no catalogued volume and would fail resolveFillableCatalogItem() at request time: ${missing.join(", ")}`);
});

test("resolveFillableCatalogItem rejects untagged/unfillable items", () => {
  const root = fixtureRepo();
  // CupOfWater deliberately carries no `group` in the fixture -- PlantFiber
  // is intentionally NOT used here since it is a real raw_resource in the
  // production catalog (see runtime/data/admin-items.json) and reusing it
  // as the "should be rejected" case would misleadingly suggest raw
  // resources are unfillable, which is no longer true.
  assert.throws(
    () => resolveFillableCatalogItem(root, { itemId: "CupOfWater" }),
    /Item type not allowed for fill/
  );
});

test("resolveFillableCatalogItem rejects unknown item ids", () => {
  const root = fixtureRepo();
  assert.throws(
    () => resolveFillableCatalogItem(root, { itemId: "NonExistentItem" }),
    /Item type not allowed for fill/
  );
});

// Found during code review (2026-08-19): every downstream volume-cap check
// (giveItemToBaseContainer/fillItemToBaseContainer/
// giveMultipleItemsToBaseContainer) treats itemVolume <= 0 as "not
// volume-tracked, skip the cap" -- correct for the standalone Storage tab's
// much broader catalog, but wrong for this narrower, fillable-only surface,
// where every real item is expected to carry real volume data. A catalog
// entry missing `volume` (or explicitly set to 0) must be rejected HERE,
// not silently allowed through to bypass a container's volume cap.
test("resolveFillableCatalogItem rejects a fillable-group item with no catalogued volume", () => {
  const root = fixtureRepo();
  const file = join(root, "runtime/data/admin-items.json");
  const rows = JSON.parse(readFileSync(file, "utf8"));
  rows.push({ id: "NoVolumeComponent", name: "No Volume Component", category: "resources", source: "Resources", group: "component" });
  writeFileSync(file, JSON.stringify(rows));
  assert.throws(
    () => resolveFillableCatalogItem(root, { itemId: "NoVolumeComponent" }),
    /missing catalogued volume data/
  );
});

test("resolveFillableCatalogItem rejects a fillable-group item with volume explicitly 0", () => {
  const root = fixtureRepo();
  const file = join(root, "runtime/data/admin-items.json");
  const rows = JSON.parse(readFileSync(file, "utf8"));
  rows.push({ id: "ZeroVolumeComponent", name: "Zero Volume Component", category: "resources", source: "Resources", group: "component", volume: 0 });
  writeFileSync(file, JSON.stringify(rows));
  assert.throws(
    () => resolveFillableCatalogItem(root, { itemId: "ZeroVolumeComponent" }),
    /missing catalogued volume data/
  );
});

test("resolveItemVolume returns volume for catalogued items", () => {
  const root = fixtureRepo();
  assert.equal(resolveItemVolume(root, "SteelBar"), 1.0);
  assert.equal(resolveItemVolume(root, "PlantFiber"), 0);
});

test("resolveItemVolume returns 0 for unknown templates", () => {
  const root = fixtureRepo();
  assert.equal(resolveItemVolume(root, "NonExistent"), 0);
});
