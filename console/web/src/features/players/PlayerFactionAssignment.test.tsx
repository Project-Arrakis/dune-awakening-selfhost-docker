import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playersApi } from "../../api/players";
import { PlayerFactionAssignment } from "./PlayerFactionAssignment";

vi.mock("../../api/players", () => ({ playersApi: { setFaction: vi.fn() } }));

function renderAssignment(overrides: Partial<Parameters<typeof PlayerFactionAssignment>[0]> = {}) {
  const props = {
    playerId: "101",
    playerName: "Kovalt",
    currentFaction: "Neutral",
    guild: "—",
    supported: true,
    confirmAction: vi.fn().mockResolvedValue(true),
    onRefresh: vi.fn(),
    onActionLog: vi.fn(),
    ...overrides
  };
  render(<PlayerFactionAssignment {...props} />);
  return props;
}

beforeEach(() => vi.clearAllMocks());

describe("PlayerFactionAssignment", () => {
  it("assigns a guildless player to a House through the guarded API", async () => {
    vi.mocked(playersApi.setFaction).mockResolvedValue({
      supported: true,
      result: { message: "Atreides faction assignment applied." }
    });
    const props = renderAssignment();

    fireEvent.change(screen.getByLabelText("New player faction"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Change Faction" }));

    const confirmMock = props.confirmAction as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0]).toContain("Neutral to Atreides");
    await waitFor(() => expect(playersApi.setFaction).toHaveBeenCalledWith("101", {
      factionId: 1,
      confirmation: "CHANGE PLAYER FACTION"
    }));
    expect(await screen.findByText("Atreides faction assignment applied.")).toBeInTheDocument();
    expect(props.onRefresh).toHaveBeenCalled();
    expect(props.onActionLog).toHaveBeenCalledWith("Change Faction", "Kovalt", "Atreides", "Succeeded");
  });

  it("warns about normal guild compatibility effects", async () => {
    vi.mocked(playersApi.setFaction).mockResolvedValue({ supported: true, result: {} });
    const props = renderAssignment({ currentFaction: "Atreides", guild: "Desert Power" });

    fireEvent.change(screen.getByLabelText("New player faction"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Change Faction" }));

    const confirmMock = props.confirmAction as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0]).toMatch(/realign the guild.*remove the player/i);
    expect(confirmMock.mock.calls[0][1]?.details).toContainEqual({ label: "Guild", value: "Desert Power" });
  });

  it("disables assignment when the schema capability is unavailable", () => {
    renderAssignment({ supported: false });
    expect(screen.getByLabelText("New player faction")).toBeDisabled();
    expect(screen.getByText(/unavailable in the detected database schema/i)).toBeInTheDocument();
  });
});
