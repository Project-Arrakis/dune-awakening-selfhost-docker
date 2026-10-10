import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playersApi } from "../../api/players";
import { setupApi } from "../../api/setup";
import { PlayerTeleportControls } from "./PlayerTeleportControls";

vi.mock("../../api/players", () => ({
  playersApi: {
    teleportDestinations: vi.fn(),
    position: vi.fn(),
    teleport: vi.fn()
  }
}));

vi.mock("../../api/setup", () => ({ setupApi: { task: vi.fn() } }));

const commonProps = {
  playerId: "42",
  playerName: "Test Player",
  confirmAction: vi.fn().mockResolvedValue(true),
  onRefresh: vi.fn(),
  onActionLog: vi.fn()
};

beforeEach(() => {
  vi.clearAllMocks();
  commonProps.confirmAction.mockResolvedValue(true);
});

describe("PlayerTeleportControls", () => {
  it("moves an offline player to coordinates in the selected map partition", async () => {
    vi.mocked(playersApi.teleportDestinations).mockResolvedValue({
      source: { map: "OrbitalMonitor", partition_id: 32, online_status: "Offline", online: false },
      partitions: [
        { map: "HaggaBasin", partition_id: 1, name: "Abbir", marker_count: 0, alive: true, ready: true, selectable: true },
        { map: "DeepDesert", partition_id: 8, name: "Deep Desert PvE", marker_count: 0, alive: false, ready: false, selectable: true },
        { map: "OrbitalMonitor", partition_id: 32, name: "Current Partition", marker_count: 0, current: true, selectable: false }
      ],
      players: [],
      bases: []
    });
    vi.mocked(playersApi.teleport).mockResolvedValue({
      path: "offline",
      supported: true,
      message: "Offline player respawn location was saved.",
      result: { playerId: "FLS42", partitionId: 1, x: 100, y: 200, z: 300 }
    });

    render(<PlayerTeleportControls {...commonProps} isOnline={false} />);

    const partitionSelect = await screen.findByLabelText("Teleport destination map and partition");
    expect(partitionSelect).toHaveValue("1");
    expect(screen.getByRole("option", { name: /Current Partition/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Teleport X coordinate"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Teleport Y coordinate"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText("Teleport Z coordinate"), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Teleport" }));

    await waitFor(() => expect(playersApi.teleport).toHaveBeenCalledWith("42", {
      mode: "coordinates",
      partitionId: 1,
      x: 100,
      y: 200,
      z: 300
    }));
    expect(setupApi.task).not.toHaveBeenCalled();
    expect(await screen.findByText("Offline player respawn location was saved.")).toBeInTheDocument();
  });

  it("keeps an online coordinate teleport on the current partition", async () => {
    vi.mocked(playersApi.teleportDestinations).mockResolvedValue({
      source: { map: "HaggaBasin", partition_id: 1, online_status: "Online", online: true },
      partitions: [
        { map: "HaggaBasin", partition_id: 1, name: "Abbir", marker_count: 1, alive: true, ready: true, current: true, selectable: true },
        { map: "DeepDesert", partition_id: 8, name: "Deep Desert PvE", marker_count: 0, alive: true, ready: true, selectable: false }
      ],
      players: [],
      bases: []
    });
    vi.mocked(playersApi.teleport).mockResolvedValue({
      task: {
        id: "teleport-1",
        type: "admin",
        operation: "adminTeleport",
        status: "succeeded",
        currentStep: "Complete",
        progressMessage: "Teleported",
        logLines: [],
        warnings: [],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        errorMessage: null
      }
    });

    render(<PlayerTeleportControls {...commonProps} isOnline />);

    const partitionSelect = await screen.findByLabelText("Teleport destination map and partition");
    const deepDesert = screen.getByRole("option", { name: /Deep Desert PvE/ });
    expect(deepDesert).toBeDisabled();
    expect(partitionSelect).toHaveValue("1");
    fireEvent.change(screen.getByLabelText("Teleport X coordinate"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Teleport Y coordinate"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Teleport Z coordinate"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Teleport" }));

    await waitFor(() => expect(playersApi.teleport).toHaveBeenCalledWith("42", {
      mode: "coordinates",
      partitionId: 1,
      x: 10,
      y: 20,
      z: 30
    }));
  });
});
