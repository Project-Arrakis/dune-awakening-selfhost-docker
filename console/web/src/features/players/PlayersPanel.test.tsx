import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playersApi } from "../../api/players";
import { mapsApi } from "../../api/maps";
import { invalidateInstanceNames } from "../maps/instanceNames";
import { PlayersPanel } from "./PlayersPanel";

vi.mock("../../api/maps", () => ({ mapsApi: { sietchDimensions: vi.fn() } }));

vi.mock("../../api/players", () => ({
  playersApi: {
    list: vi.fn(),
    profile: vi.fn(),
    deletedCharacters: vi.fn()
  }
}));
vi.mock("../../api/vehicles", () => ({ vehiclesApi: { deleteVehicle: vi.fn(), pendingDeletes: vi.fn().mockResolvedValue({ supported: true, total: 0, pending: [], byTarget: [] }) } }));

const bannedPlayer = {
  actor_id: "82",
  character_name: "Vixen",
  last_seen: "2026-08-07T10:00:00Z",
  actual_online_status: "Online",
  online_status: "Banned",
  is_banned: true,
  map: "HaggaBasin",
  partition_id: 1,
  partitionMap: "Survival_1",
  fls_id: "254A06043E9F0B16",
  total_playtime_seconds: 3665
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateInstanceNames();
  vi.mocked(mapsApi.sietchDimensions).mockResolvedValue({ stdout: "", exitCode: 1 } as never);
  vi.mocked(playersApi.list).mockResolvedValue({
    rows: [bannedPlayer],
    totalCount: 1,
    totalPlayers: 1,
    capabilities: { statusFilterApplied: true }
  });
  vi.mocked(playersApi.profile).mockResolvedValue({ player: bannedPlayer });
  vi.mocked(playersApi.deletedCharacters).mockResolvedValue({
    supported: true,
    capabilities: { deletedCharacters: true },
    characters: [],
    unattributed: { bases: [], vehicles: [] },
    totals: {
      deletedCharacters: 0,
      deletedCharactersHoldingAssets: 0,
      deletedCharactersWithoutAssets: 0,
      attributedBases: 0,
      attributedVehicles: 0,
      unattributedBases: 0,
      unattributedVehicles: 0,
      orphanedBases: 0,
      orphanedVehicles: 0
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlayersPanel persistent bans", () => {
  it("shows the configured Sietch name next to the player's game map", async () => {
    vi.mocked(mapsApi.sietchDimensions).mockImplementation((_map?: string, wantIds?: boolean) => Promise.resolve({
      stdout: wantIds
        ? "1\n"
        : ["DIMENSION  DISPLAY NAME                     PASSWORD", "0          Sietch New                       (unset)"].join("\n"),
      exitCode: 0
    }) as never);

    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);

    expect(await screen.findByText("HaggaBasin (Sietch New)")).toBeInTheDocument();
    expect(vi.mocked(mapsApi.sietchDimensions).mock.calls.map((call) => call[0])).toEqual(["Survival_1", "Survival_1"]);
  });

  it("expands the player list until a player detail is opened", async () => {
    render(<PlayersPanel
      onError={vi.fn()}
      renderCharacterAdmin={({ onClose }) => <button onClick={onClose}>Close player detail</button>}
    />);

    const tableWrap = await screen.findByRole("region", { name: "Scrollable data table" });
    expect(tableWrap).toHaveClass("players-table-wrap-expanded");
    expect(tableWrap).not.toHaveClass("players-table-wrap-compact");

    fireEvent.click(screen.getByText("Vixen"));
    await waitFor(() => expect(tableWrap).toHaveClass("players-table-wrap-compact"));
    expect(tableWrap).not.toHaveClass("players-table-wrap-expanded");

    fireEvent.click(screen.getByRole("button", { name: "Close player detail" }));
    await waitFor(() => expect(tableWrap).toHaveClass("players-table-wrap-expanded"));
  });

  it("renders banned status and requests the banned filter", async () => {
    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);

    expect(await screen.findByText("Banned", { selector: ".player-status-cell span" })).toBeInTheDocument();
    expect(screen.getByText("Currently Active")).toBeInTheDocument();
    expect(screen.getByText("1h 1m")).toBeInTheDocument();
    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent?.replace(/[↑↓]/g, "").trim());
    expect(headers.indexOf("Total Playtime")).toBe(headers.indexOf("Last Online") + 1);
    const filter = screen.getByLabelText("Filter");
    expect(screen.getByRole("option", { name: "Banned" })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "banned" } });

    await waitFor(() => expect(playersApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: "banned" })));
  });

  it("automatically refreshes an open player profile", async () => {
    vi.useFakeTimers();
    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={({ detail }) => <div data-testid="open-player-map">{String((detail?.player as Record<string, unknown> | undefined)?.map || "Loading")}</div>} />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByText("Vixen"));
    await act(async () => { await Promise.resolve(); });
    expect(playersApi.profile).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("open-player-map")).toHaveTextContent("HaggaBasin");

    vi.mocked(playersApi.profile).mockResolvedValue({ player: { ...bannedPlayer, map: "DeepDesert_1" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(playersApi.profile).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("open-player-map")).toHaveTextContent("DeepDesert_1");
  });
});

describe("PlayersPanel view mode", () => {
  it("swaps the players list for the deleted-characters view", async () => {
    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);
    expect(await screen.findByText("Vixen")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Deleted Characters" }));

    await waitFor(() => expect(screen.getByText("Unattributed Orphans")).toBeInTheDocument());
    // The players table, its filter and its search are gone, not merely hidden.
    expect(screen.queryByText("Vixen")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Filter")).not.toBeInTheDocument();
    expect(playersApi.deletedCharacters).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("radio", { name: "Active Players" }));
    expect(await screen.findByText("Vixen")).toBeInTheDocument();
  });

  it("stops polling the players list while the deleted view is open", async () => {
    vi.useFakeTimers();
    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);
    await act(async () => { await Promise.resolve(); });

    const callsBefore = vi.mocked(playersApi.list).mock.calls.length;
    fireEvent.click(screen.getByRole("radio", { name: "Deleted Characters" }));
    await act(async () => { await Promise.resolve(); });

    // Three full refresh intervals with nobody looking at the players list.
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    }
    expect(vi.mocked(playersApi.list).mock.calls.length).toBe(callsBefore);
  });

  it("closes an open player detail when leaving the players list", async () => {
    render(<PlayersPanel
      onError={vi.fn()}
      renderCharacterAdmin={() => <div data-testid="player-detail">Detail</div>}
    />);
    expect(await screen.findByText("Vixen")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Vixen"));
    await waitFor(() => expect(screen.getByTestId("player-detail")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("radio", { name: "Deleted Characters" }));
    await waitFor(() => expect(screen.queryByTestId("player-detail")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("radio", { name: "Active Players" }));
    expect(await screen.findByText("Vixen")).toBeInTheDocument();
    expect(screen.queryByTestId("player-detail")).not.toBeInTheDocument();
  });
});
