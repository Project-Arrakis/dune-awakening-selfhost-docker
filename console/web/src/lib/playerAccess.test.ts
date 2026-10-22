import { describe, expect, it } from "vitest";
import { accessCountLabel, accessEmptyAdjective, accessQuery, describePlayerAccess, filterRowsByAccess } from "./playerAccess";

const rows = [{ relationship: "Owner" }, { relationship: "Co-Owner" }, { relationship: "Associate" }];

describe("playerAccess", () => {
  it("narrows rows by relationship and leaves 'all' untouched", () => {
    expect(filterRowsByAccess(rows, "owner")).toEqual([{ relationship: "Owner" }]);
    expect(filterRowsByAccess(rows, "coowner")).toEqual([{ relationship: "Co-Owner" }]);
    expect(filterRowsByAccess(rows, "all")).toHaveLength(3);
  });

  it("only puts a narrowing level in the query string", () => {
    expect(accessQuery("owner")).toBe("access=owner");
    expect(accessQuery("coowner")).toBe("access=coowner");
    expect(accessQuery("all")).toBe("");
    expect(accessQuery(undefined)).toBe("");
  });

  it("words each level consistently for both tabs", () => {
    expect(describePlayerAccess("Bases", "Chani", "owner")).toBe("Bases owned by Chani.");
    expect(describePlayerAccess("Vehicles", "Chani", "coowner")).toBe("Vehicles Chani co-owns.");
    expect(describePlayerAccess("Vehicles", "Chani", "all")).toMatch(/guild and public access are not listed/);
    expect(accessCountLabel("coowner")).toBe("Co-owned");
    expect(accessEmptyAdjective("all")).toBe("");
  });
});
