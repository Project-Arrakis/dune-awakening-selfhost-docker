import { describe, expect, it } from "vitest";
import { friendlyMapName, hasFriendlyMapName } from "./mapNames";

describe("map friendly names", () => {
  it.each([
    ["Survival_1", "Hagga Basin"],
    ["Overmap", "Overland"],
    ["SH_Arrakeen", "Arrakeen"],
    ["DeepDesert_1", "Deep Desert"],
    ["CB_Dungeon_ThePit", "The Old Quarry"],
    ["Story_Faction_Outpost_Hark", "Arsunt Garrison (Harkonnen)"]
  ])("maps %s to %s", (mapId, displayName) => {
    expect(friendlyMapName(mapId)).toBe(displayName);
    expect(hasFriendlyMapName(mapId)).toBe(true);
  });

  it("matches IDs case-insensitively and preserves unknown IDs", () => {
    expect(friendlyMapName("sh_harkovillage")).toBe("Harko Village");
    expect(friendlyMapName("Community_Custom_Map")).toBe("Community_Custom_Map");
    expect(hasFriendlyMapName("Community_Custom_Map")).toBe(false);
  });
});
