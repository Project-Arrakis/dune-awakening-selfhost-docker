import { describe, expect, it } from "vitest";
import { memoryForDisplayedMap, parseMapRows, sortMapRows, statusWithLiveMemory } from "./MapsPanel";

describe("queued always-on map diagnostics", () => {
  it("shows the exact physical-memory safety reason from map status", () => {
    const [row] = parseMapRows(
      "SH_Arrakeen Current: always-on Partitions: 1 Assigned: 0 Block: host-memory available=1GiB required=8GiB requested=4GiB reserve=4GiB swap-free=114GiB"
    );

    expect(row.status).toBe("Queued");
    expect(row.statusDetail).toBe(
      "Waiting for physical RAM: 1 GB available; 8 GB required (4 GB map + 4 GB safety reserve). Swap is emergency-only and is not used as startup capacity."
    );
  });
});

describe("map table sorting", () => {
  const rows = [
    { map: "SH_HarkoVillage", status: "Queued", mode: "Dynamic", memory: "6 GB" },
    { map: "Overmap", status: "Ready", mode: "Core Map", memory: "2 GB" },
    { map: "DeepDesert_1", status: "Ready", mode: "Always On", memory: "15 GB" },
    { map: "Survival_1", status: "Loading", mode: "Core Map", memory: "12 GB" },
    { map: "SH_Arrakeen", status: "Not Running", mode: "Dynamic", memory: "2 GB" }
  ];
  const liveMemory = [
    { container: "dune-server-sh-harkovillage-4", map: "SH_HarkoVillage", usedBytes: 4 * 1024 ** 3, limitBytes: 6 * 1024 ** 3, percent: 66.7, raw: "" },
    { container: "dune-server-deepdesert-1-8", map: "DeepDesert_1", usedBytes: 10 * 1024 ** 3, limitBytes: 15 * 1024 ** 3, percent: 66.7, raw: "" }
  ];

  it("pins core maps first while sorting other maps by name", () => {
    expect(sortMapRows(rows, "map", "desc").map((row) => row.map)).toEqual([
      "Survival_1", "Overmap", "SH_HarkoVillage", "SH_Arrakeen", "DeepDesert_1"
    ]);
  });

  it("sorts by live memory load and keeps unloaded maps last", () => {
    expect(sortMapRows(rows, "memory", "asc", liveMemory).map((row) => row.map)).toEqual([
      "Survival_1", "Overmap", "SH_HarkoVillage", "DeepDesert_1", "SH_Arrakeen"
    ]);
    expect(sortMapRows(rows, "memory", "desc", liveMemory).map((row) => row.map)).toEqual([
      "Survival_1", "Overmap", "DeepDesert_1", "SH_HarkoVillage", "SH_Arrakeen"
    ]);
  });

  it("preserves the original non-core order before a column is selected", () => {
    expect(sortMapRows(rows, null, "asc").map((row) => row.map)).toEqual([
      "Survival_1", "Overmap", "SH_HarkoVillage", "DeepDesert_1", "SH_Arrakeen"
    ]);
  });
});

describe("dual Deep Desert runtime status", () => {
  const pvpMemory = {
    container: "dune-server-deepdesert-1-40",
    map: "DeepDesert_1",
    usedBytes: 8 * 1024 ** 3,
    limitBytes: 16 * 1024 ** 3,
    percent: 50,
    raw: ""
  };

  it("does not show a stopped primary PvE instance as loading when only the sibling PvP instance is running", () => {
    const memory = memoryForDisplayedMap(
      [pvpMemory],
      "DeepDesert_1",
      { map: "DeepDesert_1", mode: "Dynamic" },
      { partitionId: "8", dimension: 0 }
    );

    expect(memory).toBeNull();
    expect(statusWithLiveMemory("Not Running", memory, "Dynamic")).toBe("Not Running");
  });

  it("still reports live memory when the primary partition itself is running", () => {
    const pveMemory = { ...pvpMemory, container: "dune-server-deepdesert-1-8" };
    const memory = memoryForDisplayedMap(
      [pveMemory, pvpMemory],
      "DeepDesert_1",
      { map: "DeepDesert_1", mode: "Dynamic" },
      { partitionId: "8", dimension: 0 }
    );

    expect(memory?.container).toBe("dune-server-deepdesert-1-8");
    expect(statusWithLiveMemory("Ready", memory, "Dynamic")).toBe("Ready");
  });
});
