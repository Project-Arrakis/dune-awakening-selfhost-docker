import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playersApi } from "../../api/players";
import { CustomizationsTab } from "./CustomizationsTab";

vi.mock("../../api/players", () => ({
  playersApi: {
    customizations: vi.fn(),
    grantCustomizations: vi.fn()
  }
}));

const groups = [
  { id: "atreides", name: "Atreides", count: 2 },
  { id: "dune-man", name: "Dune Man", count: 1 }
];

const rows = [
  { itemId: "B1C3_Atre_Maula_Pistol", name: "Atreides Pistol", groupId: "atreides", group: "Atreides", status: "Available" },
  { itemId: "B1C3_Atre_Sword", name: "Atreides Sword", groupId: "atreides", group: "Atreides", status: "Pending" },
  { itemId: "MTX_B1C2_DuneManCoverallsSetVariant_Top", name: "Dune Man Jacket", groupId: "dune-man", group: "Dune Man", status: "Available" }
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(playersApi.customizations).mockResolvedValue({ groups, rows, capabilities: { customizationOwnership: false, customizationPending: true } });
});

describe("CustomizationsTab", () => {
  it("shows grouped sets and marks tokens already waiting for login", async () => {
    render(<CustomizationsTab dbPlayerId="123" playerName="Chani" confirmAction={vi.fn().mockResolvedValue(true)} />);
    expect(await screen.findByText("Atreides Pistol")).toBeInTheDocument();
    expect(screen.getByText("Dune Man Jacket")).toBeInTheDocument();
    expect(screen.getByText("Pending Login")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Grant Set" })).toHaveLength(2);
  });

  it("grants a complete set in one request and skips pending tokens", async () => {
    const confirmAction = vi.fn().mockResolvedValue(true);
    vi.mocked(playersApi.grantCustomizations).mockResolvedValue({
      ok: true,
      granted: 1,
      skipped: 1,
      failed: 0,
      results: [
        { itemId: "B1C3_Atre_Maula_Pistol", status: "Processing", ok: true },
        { itemId: "B1C3_Atre_Sword", status: "Pending", ok: true, skipped: true }
      ]
    });
    render(<CustomizationsTab dbPlayerId="123" playerName="Chani" confirmAction={confirmAction} />);
    await screen.findByText("Atreides Pistol");
    fireEvent.click(screen.getAllByRole("button", { name: "Grant Set" })[0]);
    await waitFor(() => expect(playersApi.grantCustomizations).toHaveBeenCalledWith("123", {
      groupId: "atreides",
      itemId: undefined,
      confirmation: "GRANT CUSTOMIZATIONS"
    }));
    expect(confirmAction).toHaveBeenCalled();
    expect(await screen.findByText(/1 granted · 1 already pending/i)).toBeInTheDocument();
  });
});
