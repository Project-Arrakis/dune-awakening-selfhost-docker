import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsApi } from "../../api/maps";
import { vehiclesApi, type VehiclesListResponse } from "../../api/vehicles";
import { invalidateInstanceNames } from "../maps/instanceNames";
import { VehiclesPanel, _resetVehiclesCacheForTests } from "./VehiclesPanel";

vi.mock("../../api/maps", () => ({ mapsApi: { sietchDimensions: vi.fn() } }));

vi.mock("../../api/vehicles", () => ({
  vehiclesApi: {
    list: vi.fn(),
    permissions: vi.fn(),
    setPermissions: vi.fn(),
    permissionCandidates: vi.fn(),
    transferToSystemCustodian: vi.fn(),
    deleteVehicle: vi.fn(),
    deleteStoredVehicle: vi.fn(),
    cancelQueuedDelete: vi.fn(),
    pendingDeletes: vi.fn(),
    storage: vi.fn()
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
  // The panel keeps its last view in a module-level cache; without this a
  // test inherits the previous test's search, page and status filter.
  _resetVehiclesCacheForTests();
  invalidateInstanceNames();
  vi.mocked(mapsApi.sietchDimensions).mockResolvedValue({ stdout: "", exitCode: 1 } as never);
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
    expect(screen.getByText("Hagga Basin · Partition 1")).toBeInTheDocument();
    // Hagga Basin has no sector grid — coords only, no second row.
    expect(screen.queryByText(/^Sector/)).toBeNull();
  });

  it("shows the configured map instance name when it can be resolved", async () => {
    vi.mocked(mapsApi.sietchDimensions).mockImplementation((_map?: string, wantIds?: boolean) => Promise.resolve({
      stdout: wantIds
        ? "1\n"
        : ["DIMENSION  DISPLAY NAME                     PASSWORD", "0          Sietch Abbir                     (unset)"].join("\n"),
      exitCode: 0
    }) as never);
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse());
    renderPanel();

    const location = await screen.findByText("Hagga Basin · Sietch Abbir");
    expect(location).toHaveAttribute("title", "HaggaBasin · Partition 1");
  });

  it("labels a recovered vehicle as stored instead of inventing Partition 0", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{
        ...listResponse().rows[0],
        owner: "",
        condition_percent: null,
        partition_id: null,
        lifecycle_state: "VehicleRecovery"
      }]
    }));
    renderPanel();

    expect(await screen.findByText("Hagga Basin · Stored for Recovery")).toBeInTheDocument();
    expect(screen.queryByText(/Partition 0/)).toBeNull();
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

  // A vehicle's cargo hold hangs off the vehicle actor, not a module, so this
  // is one control on the Components header gated on a fitted storage module
  // -- not a button per component card.
  describe("View Contents", () => {
    const STORAGE_MODULE = { templateId: "SandbikeInventory_2", name: "Sandbike Inventory Mk2", condition: null, maxCondition: null, conditionPercent: null, isStorage: true };

    async function expandWith(overrides: Partial<VehiclesListResponse>) {
      vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse(overrides));
      renderPanel();
      fireEvent.click(await screen.findByLabelText("Show components for Sihaya"));
      await screen.findByText(/component/);
    }

    function withStorageModule(response: VehiclesListResponse): Partial<VehiclesListResponse> {
      return { rows: [{ ...response.rows[0], modules: [...response.rows[0].modules, STORAGE_MODULE] }] };
    }

    it("offers the button when a storage module is fitted and the server can read holds", async () => {
      await expandWith({ capabilities: { vehicles: true, vehicleStorage: true }, ...withStorageModule(listResponse()) });
      expect(screen.getByRole("button", { name: /View Contents/ })).toBeInTheDocument();
    });

    it("hides the button when no storage module is fitted", async () => {
      await expandWith({ capabilities: { vehicles: true, vehicleStorage: true } });
      expect(screen.queryByRole("button", { name: /View Contents/ })).toBeNull();
    });

    it("hides the button when the schema cannot serve holds", async () => {
      await expandWith({ capabilities: { vehicles: true, vehicleStorage: false }, ...withStorageModule(listResponse()) });
      expect(screen.queryByRole("button", { name: /View Contents/ })).toBeNull();
    });

    it("opens the contents overlay without collapsing the expanded row", async () => {
      vi.mocked(vehiclesApi.storage).mockResolvedValue({
        supported: true, found: true, vehicleId: "5001", inventoryId: "9001",
        maxSlots: 15, usedSlots: 0, maxVolume: 250, currentVolume: 0, volumeComplete: true, slots: []
      } as never);
      await expandWith({ capabilities: { vehicles: true, vehicleStorage: true }, ...withStorageModule(listResponse()) });
      fireEvent.click(screen.getByRole("button", { name: /View Contents/ }));
      await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
      expect(vehiclesApi.storage).toHaveBeenCalledWith("5001");
      // The button lives inside a clickable table row; without the click guard
      // the row would toggle shut underneath the modal.
      expect(screen.getByText(/component/)).toBeInTheDocument();
    });
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

  it("shows raw current fuel when capacity is unknown", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{
        ...listResponse().rows[0],
        fuel_percent: null,
        max_fuel: null
      }]
    }));
    renderPanel();

    // Wait for this request's distinctive value instead of the cached row
    // that may be rendered while the panel refreshes in the background.
    expect(await screen.findByText("61 current")).toBeInTheDocument();
    expect(screen.getByText("92%")).toBeInTheDocument();
  });

  it("labels inferred condition and fuel percentages as Estimated without a tilde", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{
        ...listResponse().rows[0],
        condition_estimated: true,
        modules: [{ ...listResponse().rows[0].modules[0], maxInferred: true }]
      }]
    }));
    renderPanel();

    // The panel can render a cached authoritative row first. Wait for the
    // refreshed response that carries the estimation markers.
    await waitFor(() => expect(screen.getByText(/92%/)).toHaveTextContent("Estimated"));
    await waitFor(() => expect(screen.getByText(/61%/)).toHaveTextContent("Estimated"));
    fireEvent.click(screen.getByLabelText("Show components for Sihaya"));
    expect(screen.getByText(/440 \/ 500 · 88% Estimated/)).toBeInTheDocument();
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

  it("hides the Permissions tab when the schema lacks the capability", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({ capabilities: { vehicles: true } }));
    renderPanel();

    fireEvent.click(await screen.findByLabelText("Show components for Sihaya"));
    await screen.findByText("1 component");
    expect(screen.queryByRole("tab", { name: "Permissions" })).not.toBeInTheDocument();
  });

  it("shows the Permissions tab and refetches the list after a save", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({ capabilities: { vehicles: true, vehiclePermissions: true } }));
    vi.mocked(vehiclesApi.permissions).mockResolvedValue({
      supported: true,
      vehicleId: 5001,
      actorId: "5001",
      map: "HaggaBasin",
      mapNameId: 1,
      entries: [{ playerId: "4", name: "Duncan_Idaho", rank: 1, label: "", canonical: true }]
    } as never);
    renderPanel();

    fireEvent.click(await screen.findByLabelText("Show components for Sihaya"));
    fireEvent.click(await screen.findByRole("tab", { name: "Permissions" }));

    await screen.findByText("Duncan_Idaho", { selector: ".vehicles-permissions-owner-name" });
    expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledTimes(1);

    vi.mocked(vehiclesApi.setPermissions).mockResolvedValue({
      supported: true,
      result: { ok: true, vehicleId: 5001, actorId: "5001", map: "HaggaBasin", added: 1, reranked: 0, removed: 0, total: 2, message: "Permissions were updated." }
    } as never);
    const search = screen.getByPlaceholderText("Search a player to add");
    fireEvent.change(search, { target: { value: "Leto" } });
    vi.mocked(vehiclesApi.permissionCandidates).mockResolvedValue({ rows: [{ playerId: "9", name: "Leto_A" }] } as never);
    // Scoped to the permissions add row: the page's own vehicle search bar
    // has its own "Search"/"Clear" buttons with the same accessible names.
    const addRow = within(document.querySelector(".vehicles-permissions-add") as HTMLElement);
    fireEvent.click(addRow.getByRole("button", { name: "Search" }));
    fireEvent.click(await addRow.findByRole("button", { name: "Add Leto_A" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));

    // A saved roster invalidates the list cache -- owner/shared_with are
    // rendered from the list response, not the permissions tab's own state.
    await waitFor(() => expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledTimes(2));
  });

  it("defaults to owned vehicles and refetches from page 0 when the status filter changes", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({ totalCount: 120, totalVehicles: 120 }));
    renderPanel();

    await screen.findByText("Sihaya");
    const group = within(screen.getByRole("radiogroup", { name: "Vehicles shown" }));
    expect(group.getAllByRole("radio")).toHaveLength(5);
    expect(group.getByRole("radio", { name: /^Owned/ })).toBeChecked();
    expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ status: "owned" }));
    // A narrowed list reports its share of the whole; All reports the bare total.
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({ totalCount: 120, totalVehicles: 300 }));
    fireEvent.click(screen.getByText("Refresh"));
    expect(await screen.findByText("Total Vehicles: 120 of 300")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("Next")).not.toBeDisabled());
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ status: "owned", page: 1 })));

    fireEvent.click(group.getByRole("radio", { name: "Vehicle Backup" }));
    await waitFor(() => expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ status: "backup", page: 0 })));
    expect(group.getByRole("radio", { name: "Vehicle Backup" })).toBeChecked();

    for (const [name, status] of [["Stored for Recovery", "recovery"], [/^Unowned/, "unowned"], ["All vehicles", "all"]] as const) {
      fireEvent.click(group.getByRole("radio", { name }));
      await waitFor(() => expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ status })));
    }
    expect(await screen.findByText("Total Vehicles: 300")).toBeInTheDocument();
  });

  // App.tsx never clears its focusRequest, and the panel unmounts whenever
  // another tab is opened -- so the same request arrives again on return.
  it("does not re-apply a deep link it already handled when the tab is reopened", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse());
    const focusRequest = { vehicleId: "5001", nonce: 7 };
    const first = render(<VehiclesPanel onError={vi.fn()} confirmAction={vi.fn()} formatMutationResult={vi.fn()} focusRequest={focusRequest} />);
    await waitFor(() => expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ q: "5001", status: "all" })));

    // The admin moves on: clears the search and picks a filter.
    fireEvent.click(await screen.findByText("Clear"));
    fireEvent.click(screen.getByRole("radio", { name: "Vehicle Backup" }));
    await waitFor(() => expect(vi.mocked(vehiclesApi.list)).toHaveBeenLastCalledWith(expect.objectContaining({ q: "", status: "backup" })));
    first.unmount();

    vi.mocked(vehiclesApi.list).mockClear();
    render(<VehiclesPanel onError={vi.fn()} confirmAction={vi.fn()} formatMutationResult={vi.fn()} focusRequest={focusRequest} />);
    await waitFor(() => expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalled());
    expect(await screen.findByRole("radio", { name: "Vehicle Backup" })).toBeChecked();
    for (const [params] of vi.mocked(vehiclesApi.list).mock.calls) {
      expect(params).toMatchObject({ q: "", status: "backup" });
    }

    // A NEW request (a new nonce) is still honoured.
    vi.mocked(vehiclesApi.list).mockClear();
    render(<VehiclesPanel onError={vi.fn()} confirmAction={vi.fn()} formatMutationResult={vi.fn()} focusRequest={{ vehicleId: "5001", nonce: 8 }} />);
    await waitFor(() => expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ q: "5001", status: "all" })));
  });

  it("steps back to the last real page when the requested page comes back empty", async () => {
    // 60 vehicles at 50 per page: page 1 exists. Then the list shrinks to 50.
    vi.mocked(vehiclesApi.list).mockImplementation((params = {}) => Promise.resolve(
      params.page ? listResponse({ rows: [], totalCount: 50, totalVehicles: 50 }) : listResponse({ totalCount: 60, totalVehicles: 60 })
    ));
    renderPanel();
    await screen.findByText("Sihaya");
    await waitFor(() => expect(screen.getByText("Next")).not.toBeDisabled());
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ page: 1 })));
    await waitFor(() => expect(vi.mocked(vehiclesApi.list)).toHaveBeenLastCalledWith(expect.objectContaining({ page: 0 })));
    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
  });

  it("widens the status filter to All for a deep-linked vehicle", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse());
    renderPanel({ focusRequest: { vehicleId: "5001", nonce: 1 } });

    await waitFor(() => expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ q: "5001", status: "all", page: 0 })));
    expect(await screen.findByRole("radio", { name: "All vehicles" })).toBeChecked();
  });
});

describe("VehiclesPanel vehicle deletion", () => {
  function deleteListResponse(capabilities: Record<string, unknown>, row: Record<string, unknown>) {
    return {
      capabilities,
      totalCount: 1,
      totalVehicles: 1,
      rows: [{ ...listResponse().rows[0], ...row }]
    };
  }

  const deletableVehicle = { id: "5101", name: "Sandcrawler Delete" };

  beforeEach(() => {
    vi.mocked(vehiclesApi.pendingDeletes).mockResolvedValue({ supported: true, total: 0, pending: [], byTarget: [] });
  });

  async function awaitFreshRows(vehicleName: string) {
    await screen.findByText(vehicleName);
    return screen.getByRole("button", { name: `Delete ${vehicleName}` });
  }

  it("hides the Delete Vehicle action when the schema does not support it", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse({ vehicles: true }, { id: "5100", name: "Sandcrawler NoDelete" }));

    renderPanel();
    await screen.findByText("Sandcrawler NoDelete");

    expect(screen.queryByRole("button", { name: /^Delete /i })).not.toBeInTheDocument();
  });

  it("confirms with the owner and deletes immediately when the map is already write-safe", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse({ vehicles: true, vehicleDelete: true, vehicleDeleteQueue: false }, deletableVehicle));
    vi.mocked(vehiclesApi.deleteVehicle).mockResolvedValue({
      supported: true,
      backupCreated: true,
      result: { ok: true, vehicleId: 5101, actorId: "5101", deletedModuleCount: 2 }
    });

    const props = renderPanel();
    const deleteButton = await awaitFreshRows("Sandcrawler Delete");
    expect(deleteButton).toBeEnabled();

    fireEvent.click(deleteButton);

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      'Delete "Sandcrawler Delete"? This permanently deletes the vehicle and everything stored in it.',
      {
        title: "Delete Vehicle",
        confirmLabel: "Delete",
        danger: true,
        details: [{ label: "Owner", value: "Duncan_Idaho", tone: "danger" }],
        warning: expect.stringContaining("straight to the database")
      }
    ));
    await waitFor(() => expect(vehiclesApi.deleteVehicle).toHaveBeenCalledWith("5101"));
    expect(await screen.findByText('"Sandcrawler Delete" was deleted.')).toBeInTheDocument();
    expect(vi.mocked(vehiclesApi.list).mock.calls.length).toBeGreaterThan(1);
  });

  it("disables Delete on a vehicle the server would refuse, and names the state", async () => {
    for (const [state, reason] of [
      ["VehicleRecovery", "Stored for Recovery — cannot be deleted as an ordinary vehicle"],
      ["VehicleBackup", "In Vehicle Backup — cannot be deleted until its owner takes it back out"],
      ["Travel", "In Transit — cannot be deleted until it arrives"]
    ]) {
      const name = `Blocked ${state}`;
      vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
        { vehicles: true, vehicleDelete: true, vehicleDeleteQueue: false },
        { id: "5110", name, lifecycle_state: state }
      ));
      const { unmount } = render(<VehiclesPanel onError={vi.fn()} confirmAction={vi.fn().mockResolvedValue(true)} formatMutationResult={vi.fn().mockReturnValue("")} />);
      const button = await screen.findByRole("button", { name: `Cannot delete ${name}: ${reason}` });
      // Blocked, but still focusable so the reason is reachable by keyboard.
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled();
      button.focus();
      expect(button).toHaveFocus();
      expect(button).toHaveAttribute("title", reason);
      fireEvent.click(button);
      expect(vehiclesApi.deleteVehicle).not.toHaveBeenCalled();
      expect(vehiclesApi.deleteStoredVehicle).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("deletes a stored vehicle through its own route, naming the owner and stored date", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
      { vehicles: true, vehicleDelete: true, vehicleDeleteQueue: true, vehicleStoredDelete: true },
      { id: "5120", name: "Stored Buggy", owner: "Gurney_H", lifecycle_state: "VehicleRecovery", stored_at: "2026-07-02T10:00:00.000Z", stored_reason: "RecoveredFromLostState" }
    ));
    vi.mocked(vehiclesApi.deleteStoredVehicle).mockResolvedValue({
      supported: true, backupCreated: true, result: { ok: true, vehicleId: 5120, storedOwner: "Gurney_H" }
    });

    const props = renderPanel();
    await screen.findByText("Stored Buggy");
    const button = screen.getByRole("button", { name: "Delete stored vehicle Stored Buggy" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("title", "Delete Stored Vehicle");
    fireEvent.click(button);

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledTimes(1));
    const [message, options] = vi.mocked(props.confirmAction).mock.calls[0];
    expect(message).toContain("Gurney_H will no longer be able to recover it");
    expect(options).toMatchObject({ title: "Delete Stored Vehicle", confirmLabel: "Delete Stored Vehicle", danger: true });
    expect(options?.warning).toContain("refused while the owner is online");
    expect(options?.details?.[0]).toEqual({ label: "Owner", value: "Gurney_H", tone: "danger" });
    expect(options?.details?.[1].label).toBe("Stored");
    expect(options?.details?.[1].value).toMatch(/2026.*days ago\)$/);
    expect(options?.details?.[2]).toEqual({ label: "Reason", value: "Recovered from a lost state" });

    await waitFor(() => expect(vehiclesApi.deleteStoredVehicle).toHaveBeenCalledWith("5120"));
    expect(vehiclesApi.deleteVehicle).not.toHaveBeenCalled();
    expect(await screen.findByText('Stored vehicle "Stored Buggy" was deleted.')).toBeInTheDocument();
  });

  it("shows the server's refusal when the stored vehicle's owner is online", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
      { vehicles: true, vehicleDelete: true, vehicleStoredDelete: true },
      { id: "5121", name: "Stored Bike", owner: "Chani_K", lifecycle_state: "VehicleRecovery", stored_at: "2026-05-28T10:00:00.000Z", stored_reason: "Normal" }
    ));
    vi.mocked(vehiclesApi.deleteStoredVehicle).mockRejectedValue(new Error("Chani_K is online. A stored vehicle can only be deleted while its owner is offline."));

    const props = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Delete stored vehicle Stored Bike" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Chani_K is online.");
    // A Normal recovery needs no Reason line.
    expect(vi.mocked(props.confirmAction).mock.calls[0][1]?.details).toHaveLength(2);
  });

  it("words a recent stored date by calendar day", async () => {
    const yesterdayEvening = new Date();
    yesterdayEvening.setDate(yesterdayEvening.getDate() - 1);
    yesterdayEvening.setHours(23, 30, 0, 0);
    for (const [storedAt, wording] of [[new Date().toISOString(), /\(today\)$/], [yesterdayEvening.toISOString(), /\(yesterday\)$/]] as const) {
      vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
        { vehicles: true, vehicleDelete: true, vehicleStoredDelete: true },
        { id: "5123", name: "Fresh Bike", owner: "Chani_K", lifecycle_state: "VehicleRecovery", stored_at: storedAt, stored_reason: "Normal" }
      ));
      const confirmAction = vi.fn().mockResolvedValue(false);
      const { unmount } = render(<VehiclesPanel onError={vi.fn()} confirmAction={confirmAction} formatMutationResult={vi.fn().mockReturnValue("")} />);
      fireEvent.click(await screen.findByRole("button", { name: "Delete stored vehicle Fresh Bike" }));
      await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
      expect(confirmAction.mock.calls[0][1]?.details?.[1].value).toMatch(wording);
      expect(vehiclesApi.deleteStoredVehicle).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("keeps Vehicle Backup and In Transit blocked even when stored deletes are supported", async () => {
    for (const state of ["VehicleBackup", "Travel"]) {
      vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
        { vehicles: true, vehicleDelete: true, vehicleStoredDelete: true },
        { id: "5122", name: `Still Blocked ${state}`, lifecycle_state: state }
      ));
      const { unmount } = render(<VehiclesPanel onError={vi.fn()} confirmAction={vi.fn().mockResolvedValue(true)} formatMutationResult={vi.fn().mockReturnValue("")} />);
      expect(await screen.findByRole("button", { name: new RegExp(`^Cannot delete Still Blocked ${state}`) })).toHaveAttribute("aria-disabled", "true");
      unmount();
    }
  });

  it("does not delete when the confirm dialog is declined", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
      { vehicles: true, vehicleDelete: true, vehicleDeleteQueue: false },
      { id: "5102", name: "Sandcrawler Declined Delete" }
    ));

    renderPanel({ confirmAction: vi.fn().mockResolvedValue(false) });
    fireEvent.click(await awaitFreshRows("Sandcrawler Declined Delete"));

    await waitFor(() => expect(vehiclesApi.deleteVehicle).not.toHaveBeenCalled());
  });

  it("queues the delete when the map is live and warns that it will apply on the next restart", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
      { vehicles: true, vehicleDelete: true, vehicleDeleteQueue: true },
      { id: "5103", name: "Sandcrawler Queue Delete" }
    ));
    vi.mocked(vehiclesApi.deleteVehicle).mockResolvedValue({
      supported: true,
      backupCreated: false,
      result: { ok: true, queued: true, vehicleId: 5103, map: "HaggaBasin", partitionId: 3 }
    });

    const props = renderPanel();
    fireEvent.click(await awaitFreshRows("Sandcrawler Queue Delete"));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      'Delete "Sandcrawler Queue Delete"? This permanently deletes the vehicle and everything stored in it.',
      expect.objectContaining({ warning: expect.stringContaining("queued and applied") })
    ));
    await waitFor(() => expect(vehiclesApi.deleteVehicle).toHaveBeenCalledWith("5103"));
    expect(await screen.findByText(/is queued and applies when this map next restarts or stops/)).toBeInTheDocument();
    expect(vehiclesApi.pendingDeletes).toHaveBeenCalled();
  });

  it("shows the queued-delete pill and blocks permission edits on that row", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
      { vehicles: true, vehicleDelete: true, vehicleDeleteQueue: true, vehiclePermissions: true },
      { id: "5104", name: "Sandcrawler Pending Delete" }
    ));
    vi.mocked(vehiclesApi.pendingDeletes).mockResolvedValue({
      supported: true,
      total: 1,
      pending: [{ vehicleId: 5104, map: "HaggaBasin", partitionId: 3, queuedAt: new Date().toISOString(), attempts: 0, lastError: "" }],
      byTarget: [{ map: "HaggaBasin", partitionId: 3, partitionMap: "Survival_1", dimensionIndex: 0, count: 1 }]
    });
    vi.mocked(vehiclesApi.permissions).mockResolvedValue({
      supported: true,
      vehicleId: 5104,
      actorId: "5104",
      map: "HaggaBasin",
      mapNameId: 1,
      entries: [{ playerId: "4", name: "Duncan_Idaho", rank: 1, label: "", canonical: true }]
    } as never);

    renderPanel();
    await screen.findByText("Sandcrawler Pending Delete");

    expect(await screen.findByRole("button", { name: "Cancel queued delete for Sandcrawler Pending Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Sandcrawler Pending Delete" })).not.toBeInTheDocument();

    // Server-side, this vehicle rejects every other mutation while its
    // delete is pending -- the Permissions tab must not offer a control that
    // would just 409.
    fireEvent.click(await screen.findByLabelText("Show components for Sandcrawler Pending Delete"));
    fireEvent.click(await screen.findByRole("tab", { name: "Permissions" }));
    const saveButton = await screen.findByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute("title", "This vehicle has a pending delete queued and cannot be modified. Cancel the delete first.");
  });

  it("cancelling the queued delete calls the API and refreshes the pending list", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
      { vehicles: true, vehicleDelete: true, vehicleDeleteQueue: true },
      { id: "5105", name: "Sandcrawler Cancel Delete" }
    ));
    vi.mocked(vehiclesApi.pendingDeletes).mockResolvedValue({
      supported: true,
      total: 1,
      pending: [{ vehicleId: 5105, map: "HaggaBasin", partitionId: 3, queuedAt: new Date().toISOString(), attempts: 0, lastError: "" }],
      byTarget: [{ map: "HaggaBasin", partitionId: 3, partitionMap: "Survival_1", dimensionIndex: 0, count: 1 }]
    });
    vi.mocked(vehiclesApi.cancelQueuedDelete).mockResolvedValue({ supported: true, result: { ok: true, vehicleId: 5105, pending: 0 } });

    const props = renderPanel();
    await screen.findByText("Sandcrawler Cancel Delete");

    fireEvent.click(await screen.findByRole("button", { name: "Cancel queued delete for Sandcrawler Cancel Delete" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      'Cancel the queued delete for "Sandcrawler Cancel Delete"?',
      { title: "Cancel Queued Delete", confirmLabel: "Cancel Delete" }
    ));
    await waitFor(() => expect(vehiclesApi.cancelQueuedDelete).toHaveBeenCalledWith("5105"));
    expect(await screen.findByText('Queued delete for "Sandcrawler Cancel Delete" was canceled.')).toBeInTheDocument();
  });
});
