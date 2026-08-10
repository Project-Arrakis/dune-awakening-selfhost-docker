import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsApi } from "../../api/maps";
import { vehiclesApi, type VehiclesListResponse } from "../../api/vehicles";
import { invalidateInstanceNames } from "../maps/instanceNames";
import { PlayerVehiclesTab } from "./PlayerVehiclesTab";

vi.mock("../../api/maps", () => ({ mapsApi: { sietchDimensions: vi.fn() } }));
vi.mock("../../api/vehicles", () => ({ vehiclesApi: { forPlayer: vi.fn() } }));

function response(overrides: Partial<VehiclesListResponse> = {}): VehiclesListResponse {
  return {
    capabilities: { vehicles: true },
    totalCount: 2,
    totalVehicles: 12,
    rows: [
      { id: "1", name: "Owned Bike", type: "Sandbike", owner: "Kovalt", relationship: "Owner", shared_with: [], condition_percent: 90, current_fuel: 50, max_fuel: 100, fuel_percent: 50, map: "HaggaBasin", partition_id: 1, x: 10, y: 20, z: 0, modules: [] },
      { id: "2", name: "Shared Buggy", type: "Buggy", owner: "Duncan", relationship: "Co-Owner", shared_with: [], condition_percent: 80, current_fuel: null, max_fuel: null, fuel_percent: null, map: "DeepDesert", partition_id: 2, x: 0, y: 0, z: 0, modules: [{ templateId: "Wheel", name: "Buggy Tread", condition: 80, maxCondition: 100, conditionPercent: 80 }] }
    ],
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateInstanceNames();
  vi.mocked(mapsApi.sietchDimensions).mockResolvedValue({ stdout: "", exitCode: 1 } as never);
});

describe("PlayerVehiclesTab", () => {
  it("shows owned and shared vehicles with the same expandable vehicle presentation", async () => {
    vi.mocked(vehiclesApi.forPlayer).mockResolvedValue(response());
    render(<PlayerVehiclesTab playerId="42" playerName="Kovalt" />);

    expect(await screen.findByText("Owned Bike")).toBeInTheDocument();
    expect(screen.getByText("Hagga Basin · Partition 1")).toBeInTheDocument();
    expect(vehiclesApi.forPlayer).toHaveBeenCalledWith("42");
    expect(screen.getByText("Co-Owner")).toBeInTheDocument();
    expect(screen.getByText("Duncan")).toBeInTheDocument();
    expect(screen.getByLabelText("Player vehicle totals")).toHaveTextContent("2 Total");
    expect(screen.getByLabelText("Player vehicle totals")).toHaveTextContent("1 Owned");
    expect(screen.getByLabelText("Player vehicle totals")).toHaveTextContent("1 Shared");

    fireEvent.click(screen.getByLabelText("Show components for Shared Buggy"));
    expect(screen.getByText("Buggy Tread")).toBeInTheDocument();
  });

  it("refreshes the filtered list on demand", async () => {
    vi.mocked(vehiclesApi.forPlayer).mockResolvedValue(response({ rows: [], totalCount: 0 }));
    render(<PlayerVehiclesTab playerId="42" playerName="Kovalt" />);
    expect(await screen.findByText("Kovalt has no owned or shared vehicles.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(vehiclesApi.forPlayer).toHaveBeenCalledTimes(2));
  });
});
