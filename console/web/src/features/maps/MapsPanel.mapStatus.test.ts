import { describe, expect, it } from "vitest";
import { parseMapRows } from "./MapsPanel";

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
