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

test("adminVehicleMetadata splits multi-word camelCase IDs that have no explicit override", () => {
  const metadata = adminVehicleMetadata();
  assert.equal(metadata.get("TreadWheel")?.name, "Tread Wheel");
  assert.equal(metadata.get("ContainerVehicle")?.name, "Container Vehicle");
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

test("playerStorageProvider (owned scope) adds display_name to every row", async () => {
  const db = mockDb([{ id: "c1", template_id: "ScrapMetal", stack_size: 8 }]);
  const result = await playerStorageProvider(db, { playerControllerId: "1", scope: "owned" });
  assert.equal(result.rows[0].display_name, "Salvaged Metal");
});

test("playerStorageProvider (guild scope) adds display_name to every row", async () => {
  const db = mockDb([{ id: "c1", template_id: "Oil", stack_size: 39 }]);
  const result = await playerStorageProvider(db, { playerControllerId: "1", scope: "guild" });
  assert.equal(result.rows[0].display_name, "Fuel Cell");
});

test("itemSearchProvider adds display_name to every matched row", async () => {
  const db = mockDb([{ id: "1", template_id: "Ammo", stack_size: 72 }]);
  const result = await itemSearchProvider(db, { playerControllerId: "1", query: "ammo", scope: "owned" });
  assert.equal(result.rows[0].display_name, "Light Darts");
});

test("inventorySearchProvider adds display_name to every matched row", async () => {
  const db = mockDb([{ id: "1", template_id: "BuildingBlueprint_CopyDevice", stack_size: 1 }]);
  const result = await inventorySearchProvider(db, { playerPawnId: "1", query: "copy" });
  assert.equal(result.rows[0].display_name, "Solido Replicator");
});
