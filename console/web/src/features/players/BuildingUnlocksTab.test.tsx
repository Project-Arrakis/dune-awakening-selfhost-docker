import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playersApi } from "../../api/players";
import { BuildingUnlocksTab } from "./BuildingUnlocksTab";

vi.mock("../../api/players", () => ({
  playersApi: {
    buildingUnlocks: vi.fn(),
    grantBuildingUnlock: vi.fn()
  }
}));

const rows = [
  { itemId: "BasicLighting_Patent", name: "Basic Lighting", group: "Furniture & Decorations", status: "Available", experimental: false },
  { itemId: "Windtrap_Patent", name: "Windtrap", group: "Crafting & Utilities", status: "Owned", experimental: false },
  { itemId: "Developer_Storage_Container_Patent", name: "Developer Storage Container", group: "Experimental", status: "Available", experimental: true }
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(playersApi.buildingUnlocks).mockResolvedValue({
    capabilities: { buildingUnlockOwnership: true },
    rows
  });
});

describe("BuildingUnlocksTab", () => {
  it("separates verified unlocks, hides experimental entries, and prevents duplicate grants", async () => {
    render(<BuildingUnlocksTab dbPlayerId="123" playerName="Chani" confirmAction={vi.fn().mockResolvedValue(true)} />);

    expect(await screen.findByText("Basic Lighting")).toBeInTheDocument();
    expect(screen.getByText("Windtrap")).toBeInTheDocument();
    expect(screen.queryByText("Developer Storage Container")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Owned" })).toBeDisabled();
  });

  it("grants one real token and changes the row to pending", async () => {
    const confirmAction = vi.fn().mockResolvedValue(true);
    vi.mocked(playersApi.grantBuildingUnlock).mockResolvedValue({ ok: true, status: "Pending" });
    render(<BuildingUnlocksTab dbPlayerId="123" playerName="Chani" confirmAction={confirmAction} />);

    fireEvent.click(await screen.findByRole("button", { name: "Grant" }));
    await waitFor(() => expect(playersApi.grantBuildingUnlock).toHaveBeenCalledWith("123", {
      itemId: "BasicLighting_Patent",
      confirmation: "GRANT BUILDING UNLOCK"
    }));
    expect(confirmAction).toHaveBeenCalled();
    expect(await screen.findByText("Pending Login")).toBeInTheDocument();
    expect(screen.getByText(/Dune will process it on the next login/i)).toBeInTheDocument();
  });
});
