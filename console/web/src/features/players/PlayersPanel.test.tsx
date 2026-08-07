import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  fls_id: "254A06043E9F0B16"
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

describe("PlayersPanel persistent bans", () => {
  it("renders banned status and requests the banned filter", async () => {
    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);

    expect(await screen.findByText("Banned", { selector: ".player-status-cell span" })).toBeInTheDocument();
    expect(screen.getByText("Currently Active")).toBeInTheDocument();
    const filter = screen.getByLabelText("Filter");
    expect(screen.getByRole("option", { name: "Banned" })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "banned" } });

    await waitFor(() => expect(playersApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: "banned" })));
  });
});
