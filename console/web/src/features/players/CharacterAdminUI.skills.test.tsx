import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApi } from "../../api/admin";
import { playersApi } from "../../api/players";
import { CharacterAdminUI } from "./CharacterAdminUI";

vi.mock("../../api/admin", () => ({
  adminApi: {
    itemCatalog: vi.fn(),
    skillModules: vi.fn()
  }
}));

vi.mock("../../api/players", () => ({
  playersApi: {
    inventory: vi.fn(),
    specs: vi.fn(),
    setSkillModule: vi.fn(),
    setSkillPoints: vi.fn()
  }
}));

vi.mock("./PlayerSummary", () => ({ PlayerSummary: () => <div>Summary</div> }));
vi.mock("./PlayerDetailTab", () => ({ PlayerDetailTab: () => <div>Inventory</div> }));

const baseProps = {
  fallback: {},
  dbPlayerId: "101",
  actionPlayerId: "FLS_TEST",
  playerName: "OfflinePlayer",
  onError: vi.fn(),
  onRefresh: vi.fn(),
  onClose: vi.fn(),
  confirmAction: vi.fn().mockResolvedValue(true),
  waitForTask: vi.fn(),
  formatMutationResult: vi.fn().mockReturnValue("Action completed.")
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(adminApi.itemCatalog).mockResolvedValue({ rows: [] });
  vi.mocked(adminApi.skillModules).mockResolvedValue({
    stdout: "Energy Capsule [Trooper]\n  id: Skills.Ability.EnergyCapsule\n  max level: 1"
  });
  vi.mocked(playersApi.inventory).mockResolvedValue({} as Awaited<ReturnType<typeof playersApi.inventory>>);
  vi.mocked(playersApi.specs).mockResolvedValue({ rows: [], skillModules: [], capabilities: {} });
});

describe("CharacterAdminUI skill live grants", () => {
  it("does not let an offline player create an unsaved skill draft", async () => {
    render(<CharacterAdminUI
      {...baseProps}
      detail={{ player: { actual_online_status: "Offline" }, capabilities: {} }}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));

    expect(await screen.findByText("The player must be online to change skills or restore starter skills.")).toBeInTheDocument();
    const rankButton = await screen.findByRole("button", { name: "Set Energy Capsule rank 1" });
    await waitFor(() => expect(rankButton).toBeDisabled());
    expect(rankButton).toHaveAttribute("title", "The player must be online to change skills");

    fireEvent.click(rankButton);
    expect(screen.getByText("0 Unsaved Changes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(playersApi.setSkillModule).not.toHaveBeenCalled();
  });
});
