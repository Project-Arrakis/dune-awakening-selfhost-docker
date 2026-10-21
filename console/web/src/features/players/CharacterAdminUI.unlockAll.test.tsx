import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApi } from "../../api/admin";
import { playersApi } from "../../api/players";
import { CharacterAdminUI } from "./CharacterAdminUI";

vi.mock("../../api/admin", () => ({
  adminApi: { itemCatalog: vi.fn(), skillModules: vi.fn(), structuredVehicles: vi.fn() }
}));

vi.mock("../../api/players", () => ({
  playersApi: {
    inventory: vi.fn(),
    specs: vi.fn(),
    craftingRecipes: vi.fn(),
    researchItems: vi.fn(),
    unlockAllCraftingRecipes: vi.fn(),
    unlockAllResearchItems: vi.fn()
  }
}));

vi.mock("./PlayerSummary", () => ({ PlayerSummary: () => <div>Summary</div> }));
vi.mock("./PlayerDetailTab", () => ({ PlayerDetailTab: () => <div>Inventory</div> }));

const props = () => ({
  fallback: {},
  dbPlayerId: "101",
  actionPlayerId: "FLS_TEST",
  playerName: "Chani",
  onError: vi.fn(),
  onRefresh: vi.fn(),
  onClose: vi.fn(),
  confirmAction: vi.fn().mockResolvedValue(true),
  waitForTask: vi.fn(),
  formatMutationResult: vi.fn().mockReturnValue("Action completed."),
  restartGate: vi.fn().mockResolvedValue("immediate" as const),
  detail: { player: { actual_online_status: "Offline" }, capabilities: {} }
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(adminApi.itemCatalog).mockResolvedValue({ rows: [] });
  vi.mocked(adminApi.structuredVehicles).mockResolvedValue({ vehicles: [] });
  vi.mocked(adminApi.skillModules).mockResolvedValue({ stdout: "" });
  vi.mocked(playersApi.inventory).mockResolvedValue({} as Awaited<ReturnType<typeof playersApi.inventory>>);
  vi.mocked(playersApi.specs).mockResolvedValue({ rows: [], skillModules: [], capabilities: {} });
  vi.mocked(playersApi.craftingRecipes).mockResolvedValue({
    capabilities: {},
    rows: [{ recipeId: "HealthPackRecipe", displayName: "Healkit", category: "Essentials", source: "Catalog", qualityLevel: 0, unlocked: false }]
  });
  vi.mocked(playersApi.researchItems).mockResolvedValue({
    capabilities: {},
    rows: [{ itemKey: "RCP_HealthPackRecipe", displayName: "Healkit", category: "Essentials", productGroup: "Salvage Products", type: "Recipe", unlockedState: "NotPurchased", unlocked: false, actionable: true, unlockKind: "recipe", unlockId: "HealthPackRecipe" }]
  });
});

describe("Crafting tab Unlock All (#1235)", () => {
  it("unlocks every schematic after one confirmation, keeping per-item unlock available", async () => {
    const p = props();
    vi.mocked(playersApi.unlockAllCraftingRecipes).mockResolvedValue({ supported: true, backupCreated: true, result: { total: 729, unlocked: 550, alreadyUnlocked: 179 } });
    render(<CharacterAdminUI {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Crafting" }));
    await screen.findByRole("button", { name: "Unlock" });
    fireEvent.click(screen.getByRole("button", { name: "Unlock All" }));

    await waitFor(() => expect(playersApi.unlockAllCraftingRecipes).toHaveBeenCalledWith("101", { confirmation: "UNLOCK ALL CRAFTING RECIPES" }));
    expect(p.confirmAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/550 unlocked, 179 already known/)).toBeInTheDocument();
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const p = { ...props(), confirmAction: vi.fn().mockResolvedValue(false) };
    render(<CharacterAdminUI {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Crafting" }));
    await screen.findByRole("button", { name: "Unlock" });
    fireEvent.click(screen.getByRole("button", { name: "Unlock All" }));
    await waitFor(() => expect(p.confirmAction).toHaveBeenCalledTimes(1));
    expect(playersApi.unlockAllCraftingRecipes).not.toHaveBeenCalled();
  });

  it("shows the server's refusal, for example an online player", async () => {
    vi.mocked(playersApi.unlockAllCraftingRecipes).mockRejectedValue(new Error("Crafting recipe unlocks require the player to be offline."));
    render(<CharacterAdminUI {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Crafting" }));
    await screen.findByRole("button", { name: "Unlock" });
    fireEvent.click(screen.getByRole("button", { name: "Unlock All" }));
    expect(await screen.findByText(/require the player to be offline/)).toBeInTheDocument();
  });
});

describe("Research tab Unlock All (#1235)", () => {
  it("unlocks all research and says how many group markers were skipped", async () => {
    const p = props();
    vi.mocked(playersApi.unlockAllResearchItems).mockResolvedValue({ supported: true, backupCreated: true, result: { total: 959, unlocked: 347, repaired: 0, alreadyUnlocked: 608, skippedGroups: ["DA_GRP_A", "DA_GRP_B"] } });
    render(<CharacterAdminUI {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Research" }));
    fireEvent.click(await screen.findByRole("button", { name: "Unlock All" }));

    await waitFor(() => expect(playersApi.unlockAllResearchItems).toHaveBeenCalledWith("101", { confirmation: "UNLOCK ALL RESEARCH" }));
    expect(p.confirmAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/347 unlocked, 2 group markers skipped/)).toBeInTheDocument();
  });

  it("reports nothing to unlock when everything is already researched", async () => {
    vi.mocked(playersApi.unlockAllResearchItems).mockResolvedValue({ supported: true, result: { total: 959, unlocked: 0, repaired: 0, alreadyUnlocked: 955, skippedGroups: ["DA_GRP_A"] } });
    render(<CharacterAdminUI {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Research" }));
    fireEvent.click(await screen.findByRole("button", { name: "Unlock All" }));
    expect(await screen.findByText(/Nothing to unlock \(1 group marker cannot be unlocked directly\)/)).toBeInTheDocument();
  });
});
