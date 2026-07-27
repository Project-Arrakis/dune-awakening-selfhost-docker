import assert from "node:assert/strict";
import test from "node:test";
import { adminItemMetadata, adminVehicleMetadata } from "../src/duneDb.js";
import {
  playerInventoryProvider,
  playerStorageProvider,
  itemSearchProvider,
  inventorySearchProvider
} from "../src/integrations/discord/inventoryProvider.js";

// ─── Real bug, found via a live user report (2026-07-26/27) ────────────────
//
// Every player-facing route (player:inventory, player:storage,
// player:find) returned only the raw template_id (e.g. "AzuriteOre",
// "Bloodsack_01") with no lookup against the already-existing local item
// catalog (runtime/data/admin-items.json) at all -- despite that exact
// catalog already being correctly used by the unrelated server-wide OPS
// aggregate (ops:armory). These tests prove the fix (enrichWithDisplayName()
// in inventoryProvider.js) actually resolves real, current catalog entries,
// not just a synthetic fixture -- if the real catalog file's shape or
// contents ever drift, these tests catch it directly.

test("adminItemMetadata resolves the exact items from the original live bug report", () => {
  const metadata = adminItemMetadata();
  const expected = {
    AzuriteOre: "Copper Ore",
    Bloodsack_01: "Small Blood Sack",
    PlantFiber: "Plant Fiber",
    ScrapMetal: "Salvaged Metal",
    Oil: "Fuel Cell",
    Ammo: "Light Darts",
    BuildingBlueprint_CopyDevice: "Solido Replicator"
  };
  for (const [id, name] of Object.entries(expected)) {
    assert.equal(metadata.get(id)?.name, name, `${id} should resolve to "${name}"`);
  }
});

test("adminVehicleMetadata applies the explicit Ornithopter renames", () => {
  const metadata = adminVehicleMetadata();
  assert.equal(metadata.get("OrnithopterLight")?.name, "Scout");
  assert.equal(metadata.get("OrnithopterMedium")?.name, "Assault");
  assert.equal(metadata.get("OrnithopterTransport")?.name, "Carrier");
});

test("adminVehicleMetadata splits multi-word camelCase IDs that have no explicit override and are not in admin-items.json", () => {
  const metadata = adminVehicleMetadata();
  assert.equal(metadata.get("TreadWheel")?.name, "Tread Wheel");
});

// Real conflict found during manual review (2026-07-27, before any live
// command consumed this function): ContainerVehicle exists in BOTH
// admin-items.json (as a real vehicles-category item, name "Carrier
// Ornithopter Cargo Container") and admin-vehicles.json (this file's own
// 9-entry vehicle-table catalog, where it would otherwise fall back to
// splitCamelCase() -> "Container Vehicle", a less accurate name). Per
// explicit operator direction: admin-items.json is the bigger, more
// actively-maintained catalog, so its real name wins for any ID present
// in both.
test("adminVehicleMetadata prefers admin-items.json's real name over its own camelCase-split fallback when an ID exists in both catalogs", () => {
  const metadata = adminVehicleMetadata();
  assert.equal(metadata.get("ContainerVehicle")?.name, "Carrier Ornithopter Cargo Container");
});

test("adminVehicleMetadata leaves single-word IDs with no internal capitalization unchanged", () => {
  const metadata = adminVehicleMetadata();
  assert.equal(metadata.get("Sandbike")?.name, "Sandbike");
  assert.equal(metadata.get("Buggy")?.name, "Buggy");
  assert.equal(metadata.get("Tank")?.name, "Tank");
  assert.equal(metadata.get("Sandcrawler")?.name, "Sandcrawler");
});

// ─── Provider-level enrichment ──────────────────────────────────────────

// playerInventory() (duneDb.js) issues THREE queries in sequence: (1)
// tableExists() checks for dune.items and dune.inventories via
// "select to_regclass(...)", (2) a lookup for the inventory's own
// id/max_item_count/max_item_volume (from dune.inventories), (3) the
// actual items query (from dune.items). This mock distinguishes all
// three by query text so playerInventoryProvider (which uses
// playerInventory internally) actually reaches the real items query,
// while the simpler single-query providers (storage/find) can use the
// same mock and just fall through to the final rows branch.
function mockDb(rows) {
  return {
    async query(text) {
      if (text.includes("to_regclass")) {
        return { rows: [{ exists: true }], rowCount: 1 };
      }
      if (text.includes("from dune.inventories")) {
        return { rows: [{ id: "inv-1", max_item_count: 40, max_item_volume: 225 }], rowCount: 1 };
      }
      return { rows, rowCount: rows.length };
    }
  };
}

test("playerInventoryProvider adds display_name to every row using the real catalog", async () => {
  const db = mockDb([
    { id: "1", template_id: "AzuriteOre", stack_size: 72 },
    { id: "2", template_id: "PlantFiber", stack_size: 270 }
  ]);
  const result = await playerInventoryProvider(db, { playerPawnId: "1", characterName: "TestChar" });
  assert.equal(result.rows[0].display_name, "Copper Ore");
  assert.equal(result.rows[1].display_name, "Plant Fiber");
  // Original fields must still be present -- this is additive, not a
  // replacement, since other code (grouping, augment-slot logic) still
  // reads template_id directly.
  assert.equal(result.rows[0].template_id, "AzuriteOre");
});

test("playerInventoryProvider falls back to the raw template_id for an item not in the catalog (never disappears, never shows Unknown for a real ID)", async () => {
  const db = mockDb([{ id: "1", template_id: "SomeFutureItemNotYetInCatalog", stack_size: 1 }]);
  const result = await playerInventoryProvider(db, { playerPawnId: "1" });
  assert.equal(result.rows[0].display_name, "SomeFutureItemNotYetInCatalog");
});

test("playerInventoryProvider shows Unknown Item only for a row with no template_id at all", async () => {
  const db = mockDb([{ id: "1", stack_size: 1 }]);
  const result = await playerInventoryProvider(db, { playerPawnId: "1" });
  assert.equal(result.rows[0].display_name, "Unknown Item");
});

// ─── Real regression, found via a live user report (2026-07-27) ────────────
//
// playerOwnedStorageQuery()/guildStorageQuery() return one row PER
// CONTAINER (id, name, class, map, item_count) -- a storage container is
// a placeable building, not a game item, and has no template_id at all.
// The original version of this fix (committed, deployed, then found
// broken by a live user whose real base has a real Spice Silo with real
// Stone stacks) wrongly ran these container rows through
// enrichWithDisplayName(), which looked up a template_id that was never
// there and overwrote every container's real name with "Unknown Item".
// These tests use a realistic container-shaped fixture (matching the
// duneDb.js query's actual column list) instead of an item-shaped one,
// specifically to catch this class of bug -- the original tests used an
// item-shaped fixture with a template_id, which is exactly why they
// didn't catch the regression they were meant to guard against.

test("playerStorageProvider (owned scope) returns real container rows unmodified -- no display_name lookup against container data", async () => {
  const db = mockDb([{ id: "13", name: "SpiceSilo_Placeable", class: "SpiceSilo_Placeable", map: "HaggaBasin", item_count: 5 }]);
  const result = await playerStorageProvider(db, { playerControllerId: "1", scope: "owned" });
  assert.equal(result.rows[0].name, "SpiceSilo_Placeable");
  assert.equal(result.rows[0].display_name, undefined, "container rows must not get a fabricated item display_name");
});

test("playerStorageProvider (guild scope) returns real container rows unmodified -- no display_name lookup against container data", async () => {
  const db = mockDb([{ id: "20", name: "Fabricator_Placeable", class: "Fabricator_Placeable", map: "HaggaBasin", item_count: 0 }]);
  const result = await playerStorageProvider(db, { playerControllerId: "1", scope: "guild" });
  assert.equal(result.rows[0].name, "Fabricator_Placeable");
  assert.equal(result.rows[0].display_name, undefined, "container rows must not get a fabricated item display_name");
});

// Second real regression in the same live bug report, found only after
// fixing the one above and re-testing end-to-end against the actual
// live adapter API (not just this unit's own mocks): groupByContainer()
// is designed for one-row-per-ITEM shapes (its whole job is counting how
// many item rows land in each container). playerOwnedStorageQuery() rows
// are already one-row-per-CONTAINER, each with its own real,
// SQL-computed item_count. Grouping these "by their own id" produced a
// group of exactly one per container every time, discarding the real
// item_count and replacing it with 1 -- confirmed live via a real base's
// Spice Silo, whose real item_count of 5 was silently overwritten with
// 1 in the bot's actual Discord embed output.
test("playerStorageProvider preserves each container's real, pre-aggregated item_count -- does not overwrite it via item-shaped grouping logic", async () => {
  const db = mockDb([
    { id: "13", name: "SpiceSilo_Placeable", class: "SpiceSilo_Placeable", map: "HaggaBasin", item_count: 5 },
    { id: "6", name: "Totem_Small_Placeable", class: "Totem_Small_Placeable", map: "HaggaBasin", item_count: 0 }
  ]);
  const result = await playerStorageProvider(db, { playerControllerId: "1", scope: "owned" });
  const silo = result.grouped.find((g) => g.container_name === "SpiceSilo_Placeable");
  const totem = result.grouped.find((g) => g.container_name === "Totem_Small_Placeable");
  assert.equal(silo.item_count, 5, "Spice Silo's real 5-item count must be preserved, not overwritten with a group-of-one count of 1");
  assert.equal(totem.item_count, 0);
  assert.equal(result.grouped.length, 2, "each container must be its own group -- no merging or dropping of containers");
});

test("itemSearchProvider adds display_name to every matched row", async () => {
  const db = mockDb([{ id: "1", template_id: "Ammo", stack_size: 72 }]);
  const result = await itemSearchProvider(db, { playerControllerId: "1", query: "ammo", scope: "owned" });
  assert.equal(result.rows[0].display_name, "Light Darts");
});

// Real regression companion fix (2026-07-27, same live bug report):
// searchItemsInContainers() (duneDb.js) previously returned matched
// items with no container_name or map at all -- a real gap independent
// of the display-name bug above, since formatFindEmbed (the Discord
// bot's own formatter) has always needed to say WHICH container an item
// was found in, not just what the item is. Verifies the enrichment step
// here preserves those fields (added directly in the SQL, not by this
// file) alongside display_name.
test("itemSearchProvider preserves container_name and map fields alongside display_name", async () => {
  const db = mockDb([{
    id: "6594",
    template_id: "Stone",
    stack_size: 500,
    container_id: "13",
    container_name: "SpiceSilo_Placeable",
    map: "HaggaBasin"
  }]);
  const result = await itemSearchProvider(db, { playerControllerId: "1", query: "stone", scope: "owned" });
  assert.equal(result.rows[0].container_name, "SpiceSilo_Placeable");
  assert.equal(result.rows[0].map, "HaggaBasin");
  assert.equal(result.rows[0].display_name, "Granite Stone");
});

test("inventorySearchProvider adds display_name to every matched row", async () => {
  const db = mockDb([{ id: "1", template_id: "BuildingBlueprint_CopyDevice", stack_size: 1 }]);
  const result = await inventorySearchProvider(db, { playerPawnId: "1", query: "copy" });
  assert.equal(result.rows[0].display_name, "Solido Replicator");
});
