import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildingUnlockStatus, itemImagePath, itemIsRankedSchematic, itemIsSchematic, itemRequiresDatabaseGrant, listBuildingUnlockItems, listCatalogItems, resolveCatalogItem, resolveFillableCatalogItem, resolveItemVolume } from "../src/adminCatalog.js";

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

test("building patent tokens are isolated from ordinary items and report ownership safely", () => {
  const root = fixtureRepo();
  assert.equal(listCatalogItems(root, { q: "lighting" }).length, 0);

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

test("resolveFillableCatalogItem rejects unfillable items", () => {
  const root = fixtureRepo();
  assert.throws(
    () => resolveFillableCatalogItem(root, { itemId: "PlantFiber" }),
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

test("resolveItemVolume returns volume for catalogued items", () => {
  const root = fixtureRepo();
  assert.equal(resolveItemVolume(root, "SteelBar"), 1.0);
  assert.equal(resolveItemVolume(root, "PlantFiber"), 0);
});

test("resolveItemVolume returns 0 for unknown templates", () => {
  const root = fixtureRepo();
  assert.equal(resolveItemVolume(root, "NonExistent"), 0);
});
