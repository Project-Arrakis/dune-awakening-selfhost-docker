import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsApi } from "../../api/maps";
import { invalidateInstanceNames } from "../maps/instanceNames";
import { buildNamedMapChatOptions } from "./AdminToolsPanel";

vi.mock("../../api/maps", () => ({ mapsApi: { sietchDimensions: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  invalidateInstanceNames();
});

describe("Admin Tools map-message destinations", () => {
  it("uses the configured Sietch name instead of the database default", async () => {
    vi.mocked(mapsApi.sietchDimensions).mockImplementation((_map?: string, wantIds?: boolean) => Promise.resolve({
      stdout: wantIds
        ? "1\n"
        : ["DIMENSION  DISPLAY NAME                     PASSWORD", "0          Sietch New                       (unset)"].join("\n"),
      exitCode: 0
    }) as never);

    const options = await buildNamedMapChatOptions([{
      map: "Survival_1",
      partition_id: 1,
      dimension_index: 0,
      name: "Survival Sietch",
      alive: true,
      ready: true,
      connected_players: 4
    }]);

    expect(options).toEqual([expect.objectContaining({
      label: "Sietch New (Ready, 4 Online)",
      chatRegion: "HaggaBasin",
      dimension: 0
    })]);
  });

  it("keeps the service name when Sietch names cannot be read", async () => {
    vi.mocked(mapsApi.sietchDimensions).mockRejectedValue(new Error("runtime unavailable"));

    const options = await buildNamedMapChatOptions([{
      map: "Survival_1",
      partition_id: 1,
      dimension_index: 0,
      name: "Survival Sietch",
      alive: true,
      ready: true,
      connected_players: 0
    }]);

    expect(options[0]?.label).toBe("Survival Sietch (Ready, 0 Online)");
  });

  it("labels Overmap as Overland and never resolves it as a Sietch", async () => {
    const options = await buildNamedMapChatOptions([{
      map: "Overmap",
      partition_id: 2,
      dimension_index: 0,
      name: "Sietch Overland",
      alive: true,
      ready: true,
      connected_players: 2
    }]);

    expect(options[0]?.label).toBe("Overland (Ready, 2 Online)");
    expect(mapsApi.sietchDimensions).not.toHaveBeenCalled();
  });
});
