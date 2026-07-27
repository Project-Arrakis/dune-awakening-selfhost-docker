import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { basesApi } from "../../api/bases";
import { BasesPanel } from "./BasesPanel";

vi.mock("../../api/bases", () => ({
  basesApi: { list: vi.fn() }
}));

vi.mock("../../api/client", () => ({
  apiDownload: vi.fn()
}));

const commonRow = {
  base_type: "Sub-Fief",
  owner_name: "Chani",
  shared_with: [],
  map: "TheDeepDesert",
  partition_id: 8,
  x: 100,
  y: 200,
  z: 30,
  piece_count: 10,
  placeable_count: 4,
  fuelCells: 0,
  generatorRuntimeSeconds: 0,
  generators: []
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BasesPanel generator details", () => {
  it("keeps fuel and spice generators separate and distinguishes unavailable data", async () => {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true },
      totalCount: 2,
      totalBases: 2,
      totalPieces: 20,
      totalPlaceables: 8,
      rows: [
        {
          ...commonRow,
          base_id: "1006",
          name: "Sietch One",
          generatorDataAvailable: true,
          generatorCount: 2,
          fuelCells: 3,
          generatorRuntimeSeconds: 7200,
          generatorUptimeMultiplier: 2,
          generatorUptimeEventLabel: "Double generator uptime event",
          generatorUptimeEventEndsAt: "2026-09-01T00:00:00.000Z",
          generators: [
            { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 1, generatorCount: 1, runtimeSeconds: 7200 },
            { type: "spice", name: "Spice-Powered Generator", fuelName: "Spice-infused Fuel Cell", fuelCells: 2, generatorCount: 1, runtimeSeconds: 21600 }
          ]
        },
        {
          ...commonRow,
          base_id: "1007",
          name: "Sietch Two",
          generatorDataAvailable: false,
          generatorCount: 0
        }
      ]
    });

    render(<BasesPanel onError={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("2 · Lowest Queued Reserve 2h 0m", { selector: ".bases-generator-summary" })).toBeInTheDocument());
    expect(screen.getByRole("columnheader", { name: /Base Name/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Building Pieces/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Placeables/ })).toBeInTheDocument();
    // A native title tooltip repeats the same text so a hover always shows it
    // in full, even if a narrow column ever clips the visible text.
    expect(screen.getByText("2 · Lowest Queued Reserve 2h 0m", { selector: ".bases-generator-summary" })).toHaveAttribute("title", "2 · Lowest Queued Reserve 2h 0m");
    expect(screen.getByText("Unavailable")).toHaveAttribute("title", "Generator data is unavailable");
    expect(screen.queryByRole("button", { name: "Show generator details for Sietch Two" })).not.toBeInTheDocument();
    // Column headers get the same tooltip treatment for when their label is
    // wider than the (user-resizable) column default.
    expect(screen.getByRole("columnheader", { name: /Building Pieces/ })).toHaveAttribute("title", "Building Pieces");

    fireEvent.click(screen.getByRole("button", { name: "Show generator details for Sietch One" }));

    expect(screen.getByText("Fuel-Powered Generator")).toBeInTheDocument();
    expect(screen.getByText("Spice-Powered Generator")).toBeInTheDocument();
    expect(document.querySelectorAll(".bases-generator-group")).toHaveLength(2);
    expect(screen.getAllByText(/Fuel Cells\s+Queued/)).toHaveLength(2);
    expect(screen.getByText("1 Fuel Cell")).toBeInTheDocument();
    expect(screen.getByText("2 Spice-infused Fuel Cells")).toBeInTheDocument();
    expect(screen.getByText("2h 0m")).toBeInTheDocument();
    expect(screen.getByText("6h 0m")).toBeInTheDocument();
    expect(screen.getByText("2× Uptime Event")).toHaveClass("bases-uptime-event-badge");
    expect(screen.getByText(/Ends Aug 31, 2026/)).toBeInTheDocument();
  });

  it("renders both wind turbine types and reports generators with no queued fuel", async () => {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [
        {
          ...commonRow,
          base_id: "1008",
          name: "Sietch Three",
          generatorDataAvailable: true,
          generatorCount: 4,
          // The lowest queued reserve excludes the unstocked fuel generator.
          generatorRuntimeSeconds: 10800,
          generatorUnstockedCount: 1,
          generatorAllUnstocked: false,
          generators: [
            { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 0, generatorCount: 1, runtimeSeconds: 0, unstockedCount: 1 },
            { type: "spice", name: "Spice-Powered Generator", fuelName: "Spice-infused Fuel Cell", fuelCells: 2, generatorCount: 1, runtimeSeconds: 10800, unstockedCount: 0 },
            { type: "windTurbineOmni", name: "Omnidirectional Wind Turbine", fuelName: "Lubricant", fuelCells: 467, generatorCount: 1, runtimeSeconds: 1681200, unstockedCount: 0 },
            { type: "windTurbineDirectional", name: "Directional Wind Turbine", fuelName: "Lubricant", fuelCells: 38, generatorCount: 1, runtimeSeconds: 205200, unstockedCount: 0 }
          ]
        }
      ]
    });

    render(<BasesPanel onError={vi.fn()} />);

    // Wait for this test's API response specifically. Waiting for any summary
    // is flaky because the panel intentionally renders its module-level cache
    // while the fresh request is in flight.
    const alert = await screen.findByText("1 with no queued fuel", { selector: ".bases-fuel-alert" });
    const summary = alert.closest(".bases-generator-summary");
    expect(summary?.textContent?.replace(/\s+/g, " ").trim()).toBe("4 · 1 with no queued fuel Lowest Queued Reserve 3h 0m");
    expect(summary).toHaveAttribute("title", "4 · 1 with no queued fuel · Lowest Queued Reserve 3h 0m");

    fireEvent.click(screen.getByRole("button", { name: "Show generator details for Sietch Three" }));

    expect(screen.getByText("Fuel-Powered Generator")).toBeInTheDocument();
    expect(screen.getByText("Spice-Powered Generator")).toBeInTheDocument();
    expect(screen.getByText("Omnidirectional Wind Turbine")).toBeInTheDocument();
    expect(screen.getByText("Directional Wind Turbine")).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });

  it("reports when every generator has no queued fuel without claiming active burns stopped", async () => {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [
        {
          ...commonRow,
          base_id: "1009",
          name: "Sietch Four",
          generatorDataAvailable: true,
          generatorCount: 2,
          generatorRuntimeSeconds: 0,
          generatorUnstockedCount: 2,
          generatorAllUnstocked: true,
          generators: [
            { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 0, generatorCount: 2, runtimeSeconds: 0, unstockedCount: 2 }
          ]
        }
      ]
    });

    render(<BasesPanel onError={vi.fn()} />);

    const alert = await screen.findByText("No generators have queued fuel", { selector: ".bases-fuel-alert" });
    const summary = alert.closest(".bases-generator-summary");
    expect(summary?.textContent?.replace(/\s+/g, " ").trim()).toBe("2 · No generators have queued fuel");
    expect(summary).toHaveAttribute("title", "2 · No generators have queued fuel");
  });
});
