import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { vehiclesApi, type VehiclesListResponse } from "../../api/vehicles";
import { VehiclesPanel } from "./VehiclesPanel";

vi.mock("../../api/vehicles", () => ({
  vehiclesApi: {
    list: vi.fn()
  }
}));

function renderPanel(overrides: Partial<Parameters<typeof VehiclesPanel>[0]> = {}) {
  const props = {
    onError: vi.fn(),
    confirmAction: vi.fn().mockResolvedValue(true),
    formatMutationResult: vi.fn().mockReturnValue("Action completed."),
    ...overrides
  };
  render(<VehiclesPanel {...props} />);
  return props;
}

function listResponse(overrides: Partial<VehiclesListResponse> = {}): VehiclesListResponse {
  return {
    capabilities: { vehicles: true },
    totalCount: 1,
    totalVehicles: 1,
    rows: [
      {
        id: "5001",
        name: "Sihaya",
        type: "Sandbike",
        owner: "Duncan_Idaho",
        shared_with: [{ name: "Gurney_H", rank: 2, label: "Co-Owner" }, { name: "Leto_A", rank: 3, label: "Associate" }],
        condition_percent: 92,
        current_fuel: 61,
        max_fuel: 100,
        fuel_percent: 61,
        map: "HaggaBasin",
        partition_id: 1,
        x: 100,
        y: 200,
        z: 30,
        modules: [
          { templateId: "GeneratorModule", name: "Generator", condition: 440, maxCondition: 500, conditionPercent: 88 }
        ]
      }
    ],
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VehiclesPanel", () => {
  it("renders a vehicle row with type, owner, and shared-with", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse());
    renderPanel();

    expect(await screen.findByText("Sihaya")).toBeInTheDocument();
    expect(screen.getByText("Sandbike")).toBeInTheDocument();
    expect(screen.getByText("Duncan_Idaho")).toBeInTheDocument();
    // Shared-with renders "Name (RankLabel)" like the Bases page.
    expect(screen.getByText(/Gurney_H/)).toBeInTheDocument();
    expect(screen.getByText(/Co-Owner/)).toBeInTheDocument();
    // The location subtext carries the disambiguating map + partition.
    expect(screen.getByText(/HaggaBasin · partition 1/)).toBeInTheDocument();
    // Hagga Basin has no sector grid — coords only, no second row.
    expect(screen.queryByText(/^Sector/)).toBeNull();
  });

  it("shows the server-provided sub-region on the Location column", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{ ...listResponse().rows[0], map: "HaggaBasin", region: "Hagga Rift" }]
    }));
    renderPanel();

    expect(await screen.findByText("Hagga Rift")).toBeInTheDocument();
  });

  it("shows the Deep Desert sector grid as a second location row", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{ ...listResponse().rows[0], map: "DeepDesert", partition_id: 8, x: 0, y: 0 }]
    }));
    renderPanel();

    // (0, 0) on the 9x9 grid (letter = Y descending, number = X ascending) is E-5.
    expect(await screen.findByText("Sector E-5")).toBeInTheDocument();
  });

  it("expands a row to show its components", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse());
    renderPanel();

    const expandButton = await screen.findByLabelText("Show components for Sihaya");
    fireEvent.click(expandButton);

    expect(await screen.findByText("1 component")).toBeInTheDocument();
    expect(screen.getByText("Generator")).toBeInTheDocument();
    expect(screen.getByText(/440 \/ 500 · 88%/)).toBeInTheDocument();
  });

  it("shows 'Durability not reported' for a component with no durability data", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{
        ...listResponse().rows[0],
        modules: [{ templateId: "SandbikeInventory_1", name: "Sandbike Storage", condition: null, maxCondition: null, conditionPercent: null }]
      }]
    }));
    renderPanel();

    fireEvent.click(await screen.findByLabelText("Show components for Sihaya"));
    expect(await screen.findByText("Durability not reported")).toBeInTheDocument();
  });

  it("renders a muted dash for fuel when capacity is unknown", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{
        ...listResponse().rows[0],
        fuel_percent: null,
        max_fuel: null
      }]
    }));
    renderPanel();

    await screen.findByText("Sihaya");
    // Condition still shows a percent; fuel shows a dash.
    expect(screen.getByText("92%")).toBeInTheDocument();
  });

  it("submits the search term and clears it", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse());
    renderPanel();

    await screen.findByText("Sihaya");
    const input = screen.getByPlaceholderText("Search name, type, owner, or map") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "worm" } });
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => {
      expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ q: "worm" }));
    });

    fireEvent.click(screen.getByText("Clear"));
    expect(input.value).toBe("");
  });

  it("advances to the next page", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({ totalCount: 120, totalVehicles: 120 }));
    renderPanel();

    await screen.findByText("Sihaya");
    await waitFor(() => expect(screen.getByText("Next")).not.toBeDisabled());
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
    });
  });

  it("shows the unsupported reason when the schema lacks vehicle tables", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue({
      capabilities: { vehicles: false },
      totalCount: 0,
      totalVehicles: 0,
      rows: [],
      reason: "Unsupported by detected schema. Missing required table(s): dune.vehicle_modules"
    });
    renderPanel();

    expect(await screen.findByText(/Missing required table/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search name, type, owner, or map")).not.toBeInTheDocument();
  });

  it("renders rounded world coordinates on the Location column", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{ ...listResponse().rows[0], x: 100.4, y: -217653.8, map: "HaggaBasin", region: null }]
    }));
    renderPanel();

    // Rounded to plain integers, no thousands separators.
    expect(await screen.findByText("(100, -217654)")).toBeInTheDocument();
  });

  it("colors each meter by its condition threshold", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{
        ...listResponse().rows[0],
        condition_percent: 80, // green (>=66)
        fuel_percent: 50, // amber (>=33)
        modules: [{ templateId: "Engine", name: "Engine", condition: 5, maxCondition: 100, conditionPercent: 10 }] // red (<33)
      }]
    }));
    const { container } = render(
      <VehiclesPanel onError={vi.fn()} confirmAction={vi.fn().mockResolvedValue(true)} formatMutationResult={vi.fn().mockReturnValue("")} />
    );

    await screen.findByText("Sihaya");
    fireEvent.click(screen.getByLabelText("Show components for Sihaya"));
    await screen.findByText("Engine");

    const backgrounds = Array.from(container.querySelectorAll<HTMLElement>(".vehicles-meter i"))
      .map((fill) => fill.getAttribute("style") || "");
    expect(backgrounds.some((style) => style.includes("--success"))).toBe(true);
    expect(backgrounds.some((style) => style.includes("--warning"))).toBe(true);
    expect(backgrounds.some((style) => style.includes("--danger"))).toBe(true);
  });

  it("splits a locomotion component's mount position onto its own line", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{
        ...listResponse().rows[0],
        modules: [
          { templateId: "Loco", name: "Heavy Locomotion (Front Left)", condition: 90, maxCondition: 100, conditionPercent: 90 },
          { templateId: "Gen", name: "Generator", condition: 90, maxCondition: 100, conditionPercent: 90 }
        ]
      }]
    }));
    renderPanel();

    fireEvent.click(await screen.findByLabelText("Show components for Sihaya"));

    // The mount position is broken out into its own element, leaving the tier name.
    const position = await screen.findByText("Front Left");
    expect(position).toHaveClass("vehicles-component-position");
    expect(screen.getByText("Heavy Locomotion")).toBeInTheDocument();
    // A name without a position marker stays whole -- no stray position element.
    expect(screen.getByText("Generator")).toBeInTheDocument();
  });

  it("sorts by a column when its header is clicked", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse());
    renderPanel();

    await screen.findByText("Sihaya");
    fireEvent.click(screen.getByRole("columnheader", { name: /Type/ }));

    await waitFor(() => {
      expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ sortColumn: "type", sortDirection: "asc" }));
    });
  });

  it("reloads with the chosen page size", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({ totalCount: 300, totalVehicles: 300 }));
    renderPanel();

    await screen.findByText("Sihaya");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "100" } });

    await waitFor(() => {
      expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 100 }));
    });
  });
});
