import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playersApi } from "../../api/players";
import { PlayersPanel } from "./PlayersPanel";

vi.mock("../../api/players", () => ({
  playersApi: {
    list: vi.fn(),
    profile: vi.fn()
  }
}));

const bannedPlayer = {
  actor_id: "82",
  character_name: "Vixen",
  last_seen: "2026-08-07T10:00:00Z",
  actual_online_status: "Online",
  online_status: "Banned",
  is_banned: true,
  map: "Survival_1",
  fls_id: "254A06043E9F0B16",
  total_playtime_seconds: 3665
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(playersApi.list).mockResolvedValue({
    rows: [bannedPlayer],
    totalCount: 1,
    totalPlayers: 1,
    capabilities: { statusFilterApplied: true }
  });
  vi.mocked(playersApi.profile).mockResolvedValue({ player: bannedPlayer });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlayersPanel persistent bans", () => {
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
    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent?.replace(/[ ↑↓]/g, ""));
    expect(headers.indexOf("TotalPlaytime")).toBe(headers.indexOf("LastOnline") + 1);
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
    expect(screen.getByTestId("open-player-map")).toHaveTextContent("Survival_1");

    vi.mocked(playersApi.profile).mockResolvedValue({ player: { ...bannedPlayer, map: "DeepDesert_1" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(playersApi.profile).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("open-player-map")).toHaveTextContent("DeepDesert_1");
  });
});
