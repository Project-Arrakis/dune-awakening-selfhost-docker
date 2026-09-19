import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApi } from "../../api/admin";
import { playersApi } from "../../api/players";
import { CharacterAdminUI } from "./CharacterAdminUI";

vi.mock("../../api/admin", () => ({
  adminApi: {
    itemCatalog: vi.fn()
  }
}));

vi.mock("../../api/players", () => ({
  playersApi: {
    inventory: vi.fn(),
    characterRecovery: vi.fn(),
    recoverDeletedCharacter: vi.fn()
  }
}));

vi.mock("./PlayerSummary", () => ({ PlayerSummary: () => <div>Summary</div> }));
vi.mock("./PlayerDetailTab", () => ({ PlayerDetailTab: () => <div>Inventory</div> }));
vi.mock("./PlayerFactionAssignment", () => ({ PlayerFactionAssignment: () => <div>Faction</div> }));

const recovery = {
  ok: true,
  online: false,
  active: { characterStateId: "60", characterName: "TempDrew", pawnId: "4832", itemCount: 26, transferCount: 0 },
  candidates: [{
    characterStateId: "57",
    characterName: "Drew",
    lastAvatarActivity: "2026-08-17T17:45:22Z",
    lastLoginTime: "2026-08-22T22:06:06Z",
    deletedAt: "2026-08-22T22:06:07Z",
    controllerId: "3764",
    pawnId: "3818",
    playerStateActorId: "3789",
    map: "HaggaBasin",
    partitionId: "1",
    sietch: "Abbir",
    inventoryCount: 14,
    itemCount: 50,
    transferCount: 5,
    removalReason: "new char in fls",
    removalEventTime: "2026-08-22T22:06:07Z",
    replacementDetected: true,
    recoverable: true
  }],
  suggestedCandidateId: "57",
  canRecover: true,
  message: "1 recoverable deleted character state was found."
};

describe("CharacterAdminUI deleted-character recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(adminApi.itemCatalog).mockResolvedValue({ rows: [] });
    vi.mocked(playersApi.inventory).mockResolvedValue({} as Awaited<ReturnType<typeof playersApi.inventory>>);
    vi.mocked(playersApi.characterRecovery).mockResolvedValue(recovery);
    vi.mocked(playersApi.recoverDeletedCharacter).mockResolvedValue({
      supported: true,
      backupCreated: true,
      result: { message: "Drew's saved character data was recovered with 50 items." }
    });
  });

  it("shows the retained character details and sends the guarded recovery request", async () => {
    const confirmAction = vi.fn().mockResolvedValue(true);
    render(<CharacterAdminUI
      detail={{ player: { actual_online_status: "Offline" }, capabilities: {} }}
      fallback={{}}
      dbPlayerId="4832"
      actionPlayerId="D76346BB09789D7E"
      playerName="TempDrew"
      onError={vi.fn()}
      onRefresh={vi.fn()}
      onClose={vi.fn()}
      confirmAction={confirmAction}
      waitForTask={vi.fn()}
      formatMutationResult={(result) => String((result as { message?: string })?.message || "Action completed.")}
      restartGate={vi.fn().mockResolvedValue("immediate")}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(await screen.findByRole("option", { name: /Drew · 50 Items/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recover Character" }));

    await waitFor(() => expect(playersApi.recoverDeletedCharacter).toHaveBeenCalledWith("4832", "57", "RECOVER DELETED CHARACTER"));
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining("current Funcom character name remains TempDrew"), expect.objectContaining({
      title: "Recover Deleted Character",
      confirmLabel: "Recover Character",
      danger: true
    }));
  });
});
