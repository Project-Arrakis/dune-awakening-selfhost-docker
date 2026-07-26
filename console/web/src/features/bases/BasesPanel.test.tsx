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
          generatorRuntimeSeconds: 3600,
          generators: [
            { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 1, generatorCount: 1, runtimeSeconds: 7200 },
            { type: "spice", name: "Spice-Powered Generator", fuelName: "Spice-infused Fuel Cell", fuelCells: 2, generatorCount: 1, runtimeSeconds: 5400 }
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

    await waitFor(() => expect(screen.getByText("2 · next depletion in 1h 0m", { selector: ".bases-generator-summary" })).toBeInTheDocument());
    // A native title tooltip repeats the same text so a hover always shows it
    // in full, even if a narrow column ever clips the visible text.
    expect(screen.getByText("2 · next depletion in 1h 0m", { selector: ".bases-generator-summary" })).toHaveAttribute("title", "2 · next depletion in 1h 0m");
    expect(screen.getByText("Unavailable")).toHaveAttribute("title", "Generator data is unavailable");
    expect(screen.queryByRole("button", { name: "Show generator details for Sietch Two" })).not.toBeInTheDocument();
    // Column headers get the same tooltip treatment for when their label is
    // wider than the (user-resizable) column default.
    expect(screen.getByRole("columnheader", { name: /Piece Count/ })).toHaveAttribute("title", "Piece Count");

    fireEvent.click(screen.getByRole("button", { name: "Show generator details for Sietch One" }));

    expect(screen.getByText("Fuel-Powered Generator")).toBeInTheDocument();
    expect(screen.getByText("Spice-Powered Generator")).toBeInTheDocument();
    expect(screen.getByText("1 Fuel Cell")).toBeInTheDocument();
    expect(screen.getByText("2 Spice-infused Fuel Cells")).toBeInTheDocument();
    expect(screen.getByText("2h 0m")).toBeInTheDocument();
    expect(screen.getByText("1h 30m")).toBeInTheDocument();
  });

  it("renders both wind turbine types as their own cards and reports the empty count alongside the next depletion", async () => {
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
          // Next depletion excludes the empty fuel generator — it is the
          // soonest of the three still-fuelled generators (spice, at 10800s).
          generatorRuntimeSeconds: 10800,
          generatorEmptyCount: 1,
          generatorAllEmpty: false,
          generators: [
            { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 0, generatorCount: 1, runtimeSeconds: 0, emptyCount: 1 },
            { type: "spice", name: "Spice-Powered Generator", fuelName: "Spice-infused Fuel Cell", fuelCells: 2, generatorCount: 1, runtimeSeconds: 10800, emptyCount: 0 },
            { type: "windTurbineOmni", name: "Omnidirectional Wind Turbine", fuelName: "Lubricant", fuelCells: 467, generatorCount: 1, runtimeSeconds: 1622210, emptyCount: 0 },
            { type: "windTurbineDirectional", name: "Directional Wind Turbine", fuelName: "Lubricant", fuelCells: 38, generatorCount: 1, runtimeSeconds: 136800, emptyCount: 0 }
          ]
        }
      ]
    });

    render(<BasesPanel onError={vi.fn()} />);

    // One generator is empty and three still hold fuel — the summary must show
    // both the count out of fuel and when the next one depletes, not collapse
    // to a bare "out of fuel" that hides the other three. "next depletion in"
    // is forced onto its own line via <br />, which contributes no text node,
    // so the DOM's textContent has a single space (not a newline) there.
    // The "out of fuel" phrase is a nested <span> for its own color, so RTL's
    // default text matcher (direct child text nodes only) can't see the whole
    // line as one string — read the container's full textContent instead.
    await waitFor(() => expect(document.querySelector(".bases-generator-summary")).not.toBeNull());
    const summary = document.querySelector(".bases-generator-summary");
    expect(summary?.textContent?.replace(/\s+/g, " ").trim()).toBe("4 · 1 out of fuel next depletion in 3h 0m");
    expect(summary).toHaveAttribute("title", "4 · 1 out of fuel · next depletion in 3h 0m");
    // Only the "out of fuel" phrase draws attention with color — the count and
    // the depletion time stay in the default text color.
    expect(screen.getByText("1 out of fuel", { selector: ".bases-fuel-alert" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show generator details for Sietch Three" }));

    expect(screen.getByText("Fuel-Powered Generator")).toBeInTheDocument();
    expect(screen.getByText("Spice-Powered Generator")).toBeInTheDocument();
    expect(screen.getByText("Omnidirectional Wind Turbine")).toBeInTheDocument();
    expect(screen.getByText("Directional Wind Turbine")).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });

  it("reads as fully out of fuel when every generator at the base is empty", async () => {
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
          generatorEmptyCount: 2,
          generatorAllEmpty: true,
          generators: [
            { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 0, generatorCount: 2, runtimeSeconds: 0, emptyCount: 2 }
          ]
        }
      ]
    });

    render(<BasesPanel onError={vi.fn()} />);

    // No generator holds fuel, so there is no next-depletion time to report —
    // this must not read the same as "depletes now". "All generators out of
    // fuel" is a nested <span> for its own color, so read textContent directly
    // rather than relying on RTL's direct-child-only text matcher.
    await waitFor(() => expect(document.querySelector(".bases-generator-summary")).not.toBeNull());
    const summary = document.querySelector(".bases-generator-summary");
    expect(summary?.textContent?.replace(/\s+/g, " ").trim()).toBe("2 · All generators out of fuel");
    expect(summary).toHaveAttribute("title", "2 · All generators out of fuel");
    // Only "All generators out of fuel" gets the attention color — the leading
    // count ("2 ·") stays in the default text color.
    expect(screen.getByText("All generators out of fuel", { selector: ".bases-fuel-alert" })).toBeInTheDocument();
  });
});
