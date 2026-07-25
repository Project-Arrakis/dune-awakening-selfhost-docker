import { describe, expect, it } from "vitest";
import { catalogItemIsSchematic, catalogItemMinimumGrade, normalizeItemGrade } from "./ItemCatalog";

describe("item grant grade rules", () => {
  it("recognizes physical schematics whose item grade must stay zero", () => {
    expect(catalogItemIsSchematic({ id: "ChoamHeavyLasgunSchematic", category: "schematics", source: "Schematics" })).toBe(true);
    expect(catalogItemIsSchematic({ id: "PlantFiber", category: "materials", source: "Resources" })).toBe(false);
  });

  it("keeps standalone augments at grade one or higher", () => {
    expect(catalogItemMinimumGrade({ id: "T6_Augment_Melee4", category: "augments" })).toBe(1);
    expect(normalizeItemGrade(8)).toBe(5);
    expect(normalizeItemGrade(-1)).toBe(0);
  });
});
