import { describe, expect, it } from "vitest";
import { parseMapRows, sortMapRows } from "./MapsPanel";

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

  it("pins core maps first while sorting other maps by name", () => {
    expect(sortMapRows(rows, "map", "desc").map((row) => row.map)).toEqual([
      "Survival_1", "Overmap", "SH_HarkoVillage", "SH_Arrakeen", "DeepDesert_1"
    ]);
  });

  it("sorts memory numerically without moving core maps", () => {
    expect(sortMapRows(rows, "memory", "asc").map((row) => row.map)).toEqual([
      "Survival_1", "Overmap", "SH_Arrakeen", "SH_HarkoVillage", "DeepDesert_1"
    ]);
  });

  it("preserves the original non-core order before a column is selected", () => {
    expect(sortMapRows(rows, null, "asc").map((row) => row.map)).toEqual([
      "Survival_1", "Overmap", "SH_HarkoVillage", "DeepDesert_1", "SH_Arrakeen"
    ]);
  });
});
