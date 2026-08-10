import { describe, expect, it } from "vitest";
import { playerAssignedFaction, splitInventoryByGroup } from "./playerAdminUtils";

describe("playerAssignedFaction", () => {
  it("resolves assigned factions without relying on display casing", () => {
    expect(playerAssignedFaction("atreides", true)).toEqual({ id: 1, name: "Atreides" });
    expect(playerAssignedFaction("HARKONNEN", true)).toEqual({ id: 2, name: "Harkonnen" });
    expect(playerAssignedFaction("Smuggler", true)).toEqual({ id: 4, name: "Smuggler" });
  });

  it("hides reputation controls for unassigned or unsupported factions", () => {
    expect(playerAssignedFaction("Atreides", false)).toBeNull();
    expect(playerAssignedFaction("Unassigned", true)).toBeNull();
    expect(playerAssignedFaction("Neutral", true)).toBeNull();
  });
});

describe("splitInventoryByGroup", () => {
  it("splits backpack (0), character (1), loadout (15), and schematics (30)", () => {
    const rows = [
      { id: 1, template_id: "WaterBottle_1", inventory_type: 0 },
      { id: 2, template_id: "Armor_Chest_T4", inventory_type: 1 },
      { id: 3, template_id: "DewReaper_1h_Tier6", inventory_type: 15 },
      { id: 4, template_id: "Schematic_UniqueScattergun", inventory_type: 30 },
      { id: 5, template_id: "Plasteel_Scrap", inventory_type: 0 }
    ];
    const { backpack, character, loadout, schematics } = splitInventoryByGroup(rows);
    expect(backpack.map((row) => row.id)).toEqual([1, 5]);
    expect(character.map((row) => row.id)).toEqual([2]);
    expect(loadout.map((row) => row.id)).toEqual([3]);
    expect(schematics.map((row) => row.id)).toEqual([4]);
  });

  it("returns empty groups for empty input and never drops rows", () => {
    expect(splitInventoryByGroup([])).toEqual({ backpack: [], character: [], loadout: [], schematics: [] });
    const rows = [{ id: 1, inventory_type: 1 }, { id: 2, inventory_type: 0 }, { id: 3, inventory_type: 15 }, { id: 4, inventory_type: 30 }];
    const { backpack, character, loadout, schematics } = splitInventoryByGroup(rows);
    expect(backpack.length + character.length + loadout.length + schematics.length).toBe(rows.length);
  });
});
