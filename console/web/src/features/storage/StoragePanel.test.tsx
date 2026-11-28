import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { adminApi } from "../../api/admin";
import { serverApi } from "../../api/server";
import { type Task } from "../../api/setup";
import { worldDataApi } from "../../api/worldData";
import { clearCatalogCache } from "../../components/common/ItemCatalog";
import { StoragePanel } from "./StoragePanel";

vi.mock("../../api/admin", () => ({
  adminApi: {
    itemCatalog: vi.fn()
  }
}));

vi.mock("../../api/server", () => ({
  serverApi: {
    restartService: vi.fn()
  }
}));

vi.mock("../../api/worldData", () => ({
  worldDataApi: {
    storage: vi.fn(),
    storageItems: vi.fn(),
    storageGiveItem: vi.fn(),
    storageFillItem: vi.fn(),
    storageExportUrl: (id: string) => `/api/storage/${id}/export`
  }
}));

const mockConfirmAction = vi.fn();
const mockOnError = vi.fn();

function taskFixture(status: Task["status"]): Task {
  return {
    id: "task-1",
    type: "server",
    operation: "restartService",
    status,
    currentStep: "",
    progressMessage: "",
    logLines: [],
    startedAt: "2026-07-31T00:00:00Z",
    finishedAt: null,
    errorMessage: status === "failed" ? "bind failed" : null,
    warnings: [],
  };
}

const defaultProps = {
  onError: mockOnError,
  confirmAction: mockConfirmAction,
  formatMutationResult: (result: unknown) => String(result),
  waitForTask: async (task: { status: string }) => task as never,
  canChangeItems: true,
  canRestartServer: true
};

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirmAction.mockResolvedValue(true);
  vi.mocked(worldDataApi.storage).mockResolvedValue({
    rows: [{ id: 105, actor_name: "Dev-1" }, { id: 106, actor_name: "Dev-2" }],
    capabilities: { storageGiveItem: true, storageFillItem: true }
  });
  vi.mocked(worldDataApi.storageItems).mockResolvedValue({ rows: [], capabilities: {} });
  clearCatalogCache();
  // A variable, because the route also returns fields (group) that
  // ItemCatalogEntry does not declare.
  const catalogRows = [
    { id: "Sword_A", itemId: "Sword_A", name: "Ranger Sword", category: "weapons", source: "Weapons", volume: 2 },
    { id: "Sword_B", itemId: "Sword_B", name: "Ranger Sword", category: "weapons", source: "Weapons", volume: 2 },
    { id: "Cut_Top", itemId: "Cut_Top", name: "Cut Jacket", category: "clothing", source: "Clothing" },
    { id: "AzuriteOre", itemId: "AzuriteOre", name: "Copper Ore", category: "resources", source: "Resources", group: "raw_resource", volume: 0.2 }
  ];
  vi.mocked(adminApi.itemCatalog).mockResolvedValue({ rows: catalogRows });
});

describe("StoragePanel", () => {
  it("renders the apply-restart action with a visibility note", async () => {
    render(<StoragePanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Apply Fills (Restart Survival)")).toBeInTheDocument();
    });
    expect(screen.getByText(/Fills become visible in-game after the Survival server restarts/i)).toBeInTheDocument();
  });

  it("restarts the survival service after confirmation and reports success", async () => {
    vi.mocked(serverApi.restartService).mockResolvedValue({
      task: taskFixture("running")
    });
    const waitForTask = vi.fn().mockResolvedValue(taskFixture("succeeded"));
    render(<StoragePanel {...defaultProps} waitForTask={waitForTask} />);
    await waitFor(() => {
      expect(screen.getByText("Apply Fills (Restart Survival)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Apply Fills (Restart Survival)"));
    await waitFor(() => {
      expect(serverApi.restartService).toHaveBeenCalledWith("survival");
      expect(waitForTask).toHaveBeenCalledWith(taskFixture("running"));
      expect(screen.getByText("Restart completed. Container fills are now visible in-game.")).toBeInTheDocument();
    });
  });

  it("uses a danger confirmation dialog that mentions player disconnect", async () => {
    vi.mocked(serverApi.restartService).mockResolvedValue({
      task: taskFixture("running")
    });
    const waitForTask = vi.fn().mockResolvedValue(taskFixture("succeeded"));
    render(<StoragePanel {...defaultProps} waitForTask={waitForTask} />);
    await waitFor(() => {
      expect(screen.getByText("Apply Fills (Restart Survival)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Apply Fills (Restart Survival)"));
    await waitFor(() => {
      expect(mockConfirmAction).toHaveBeenCalledWith(
        expect.stringMatching(/All connected players will be disconnected/i),
        expect.objectContaining({ danger: true, confirmLabel: "Restart Survival" })
      );
    });
  });

  it("does not restart when confirmation is cancelled", async () => {
    mockConfirmAction.mockResolvedValue(false);
    render(<StoragePanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Apply Fills (Restart Survival)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Apply Fills (Restart Survival)"));
    await waitFor(() => {
      expect(serverApi.restartService).not.toHaveBeenCalled();
    });
  });

  it("reports a failed restart task", async () => {
    vi.mocked(serverApi.restartService).mockResolvedValue({
      task: taskFixture("running")
    });
    const waitForTask = vi.fn().mockResolvedValue(taskFixture("failed"));
    render(<StoragePanel {...defaultProps} waitForTask={waitForTask} />);
    await waitFor(() => {
      expect(screen.getByText("Apply Fills (Restart Survival)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Apply Fills (Restart Survival)"));
    await waitFor(() => {
      expect(screen.getByText(/Restart failed: bind failed/i)).toBeInTheDocument();
    });
  });

  it("does not claim success when the task is still running after the poll cap", async () => {
    vi.mocked(serverApi.restartService).mockResolvedValue({
      task: taskFixture("running")
    });
    const waitForTask = vi.fn().mockResolvedValue(taskFixture("running"));
    render(<StoragePanel {...defaultProps} waitForTask={waitForTask} />);
    await waitFor(() => {
      expect(screen.getByText("Apply Fills (Restart Survival)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Apply Fills (Restart Survival)"));
    await waitFor(() => {
      expect(screen.getByText(/Restart is still running/i)).toBeInTheDocument();
    });
  });
});

describe("StoragePanel write access", () => {
  async function openBox(grants: { canChangeItems: boolean; canRestartServer: boolean }) {
    render(<StoragePanel {...defaultProps} {...grants} />);
    fireEvent.click(await screen.findByText("105"));
    await screen.findByText("Storage 105");
  }
  const button = (name: string) => screen.queryByRole("button", { name });
  const fillNote = () => screen.queryByText(/Fills become visible in-game after the Survival server restarts/i);

  it("offers no item or restart controls to a read-only session", async () => {
    await openBox({ canChangeItems: false, canRestartServer: false });

    expect(screen.getByRole("link", { name: "Export JSON" })).toBeInTheDocument();
    expect(button("Refresh Storage")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Quantity" })).toBeNull();
    for (const name of ["Give Item", "Fill Container", "Apply Fills (Restart Survival)"]) expect(button(name)).toBeNull();
    expect(fillNote()).toBeNull();
    expect(screen.queryByText(/Fill Container accepts refined resources/i)).toBeNull();
    // The item search needs its own permission, so it is not even loaded.
    expect(adminApi.itemCatalog).not.toHaveBeenCalled();
  });

  it("offers Give and Fill without the restart to a session that cannot restart services", async () => {
    await openBox({ canChangeItems: true, canRestartServer: false });

    expect(button("Give Item")).toBeInTheDocument();
    expect(button("Fill Container")).toBeInTheDocument();
    expect(fillNote()).toBeInTheDocument();
    expect(button("Apply Fills (Restart Survival)")).toBeNull();
  });

  it("offers the restart alone to a session that cannot change items", async () => {
    await openBox({ canChangeItems: false, canRestartServer: true });

    expect(button("Apply Fills (Restart Survival)")).toBeInTheDocument();
    expect(button("Give Item")).toBeNull();
    expect(button("Fill Container")).toBeNull();
  });
});

describe("StoragePanel item search", () => {
  async function openBox() {
    render(<StoragePanel {...defaultProps} />);
    fireEvent.click(await screen.findByText("105"));
    await screen.findByText("Storage 105");
  }

  function search(text: string) {
    const input = screen.getByRole("combobox", { name: "Item to give or fill" }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: text } });
    return input;
  }

  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

  it("starts at quantity 1 with give and fill disabled until an item is chosen", async () => {
    await openBox();

    expect((screen.getByRole("spinbutton", { name: "Quantity" }) as HTMLInputElement).value).toBe("1");
    expect(button("Give Item").disabled).toBe(true);
    expect(button("Fill Container").disabled).toBe(true);
  });

  it("gives the chosen item by id, naming it in the confirmation", async () => {
    vi.mocked(worldDataApi.storageGiveItem).mockResolvedValue({ supported: true });
    await openBox();
    search("sword ranger");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    // Same name and category: the ids tell them apart.
    expect(screen.getAllByRole("option")[1].textContent).toContain("Sword_B");
    fireEvent.mouseDown(screen.getAllByRole("option")[1]);
    fireEvent.click(button("Give Item"));

    await waitFor(() => expect(worldDataApi.storageGiveItem).toHaveBeenCalledWith("105", { itemId: "Sword_B", quantity: 1, confirmation: "GIVE ITEM TO STORAGE" }));
    expect(mockConfirmAction).toHaveBeenCalledWith("Give 1 x Ranger Sword (Sword_B) to storage 105?");
  });

  it("keeps the typed text when it replaces a chosen item, and drops the choice", async () => {
    await openBox();
    search("ranger");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
    fireEvent.mouseDown(screen.getAllByRole("option")[0]);
    const input = search("Ranger Swordx");

    expect(input.value).toBe("Ranger Swordx");
    expect(button("Give Item").disabled).toBe(true);
  });

  it("warns when the console does not know the item's volume", async () => {
    await openBox();
    await choose("jacket");

    expect(screen.getByText(/does not know this item's volume/)).toBeInTheDocument();
  });

  async function choose(text: string) {
    search(text);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    fireEvent.mouseDown(screen.getByRole("option"));
  }

  it("fills the chosen item by id and quantity, naming it in the confirmation", async () => {
    vi.mocked(worldDataApi.storageFillItem).mockResolvedValue({ supported: true });
    await openBox();
    await choose("copper");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity" }), { target: { value: "50" } });
    fireEvent.click(button("Fill Container"));

    await waitFor(() => expect(worldDataApi.storageFillItem).toHaveBeenCalledWith("105", { itemId: "AzuriteOre", quantity: 50, confirmation: "FILL ITEM TO STORAGE" }));
    expect(mockConfirmAction).toHaveBeenCalledWith("Fill container 105 with 50 x Copper Ore (AzuriteOre)? Only refined resources and components are allowed.");
    expect(worldDataApi.storageGiveItem).not.toHaveBeenCalled();
  });

  it("fills nothing if the confirmation is declined", async () => {
    mockConfirmAction.mockResolvedValue(false);
    await openBox();
    await choose("copper");
    fireEvent.click(button("Fill Container"));

    await act(async () => {});
    expect(mockConfirmAction).toHaveBeenCalledTimes(1);
    expect(worldDataApi.storageFillItem).not.toHaveBeenCalled();
  });

  it("says why give and fill are disabled while typed text has chosen nothing", async () => {
    await openBox();
    const reason = "Choose an item from the list first.";
    expect(screen.queryByText(reason)).toBeNull();
    expect(button("Give Item").title).toBe(reason);

    search("AzuriteOre");

    const hint = screen.getByText(reason);
    for (const name of ["Give Item", "Fill Container"]) {
      expect(button(name).disabled).toBe(true);
      expect(button(name).title).toBe(reason);
      expect(button(name).getAttribute("aria-describedby")).toBe(hint.id);
    }

    await choose("copper");
    expect(screen.queryByText(reason)).toBeNull();
    expect(button("Give Item").title).toBe("");
    expect(button("Give Item").hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps the missing-schema reason on a button the tables cannot serve", async () => {
    vi.mocked(worldDataApi.storage).mockResolvedValue({ rows: [{ id: 105, actor_name: "Dev-1" }], capabilities: { storageGiveItem: false, storageFillItem: false } });
    await openBox();

    expect(button("Give Item").title).toBe("Storage give-item schema not detected");
    expect(button("Fill Container").title).toBe("Storage fill-item schema not detected");
  });

  it("warns in the confirmation before giving an item of unknown volume, and gives nothing if declined", async () => {
    mockConfirmAction.mockResolvedValue(false);
    await openBox();
    await choose("jacket");
    fireEvent.click(button("Give Item"));

    await waitFor(() => expect(mockConfirmAction).toHaveBeenCalledWith(
      "Give 1 x Cut Jacket (Cut_Top) to storage 105?",
      { danger: true, warning: expect.stringMatching(/cannot give or fill items with a known volume into that container/) }
    ));
    expect(worldDataApi.storageGiveItem).not.toHaveBeenCalled();
  });

  describe("the outcome of an action", () => {
    const props = { ...defaultProps, formatMutationResult: (response: unknown) => (response as { result: { message: string } }).result.message };

    async function give(response: () => Promise<unknown>) {
      vi.mocked(worldDataApi.storageGiveItem).mockImplementation(response as never);
      render(<StoragePanel {...props} />);
      fireEvent.click(await screen.findByText("105"));
      await screen.findByText("Storage 105");
      await choose("copper");
      fireEvent.click(button("Give Item"));
    }

    const drawer = () => document.querySelector(".storage-drawer") as HTMLElement;

    it("is shown under the controls and announced", async () => {
      await give(async () => ({ result: { message: "1 x AzuriteOre given.", clamped: false } }));

      const note = await within(drawer()).findByText("1 x AzuriteOre given.");
      expect(note.getAttribute("role")).toBe("status");
      expect(note.className).toBe("info-note");
      expect(screen.getAllByText("1 x AzuriteOre given.")).toHaveLength(1);
      const row = drawer().querySelector(".storage-give-row") as HTMLElement;
      expect(row.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("looks like a warning when only part was delivered", async () => {
      await give(async () => ({ result: { message: "Only 2 of 3 fit.", clamped: true } }));

      const note = await within(drawer()).findByText("Only 2 of 3 fit.");
      expect(note.className).toBe("confirm-modal-warning");
      expect(note.getAttribute("role")).toBe("status");
    });

    it("is an alert when the action failed", async () => {
      await give(async () => { throw new Error("Storage is full by item slot count"); });

      const note = await within(drawer()).findByRole("alert");
      expect(note.textContent).toBe("Storage is full by item slot count");
      expect(note.className).toBe("danger-note");
      expect(mockOnError).toHaveBeenCalledWith("Storage is full by item slot count");
    });

    it("is not shown for another container", async () => {
      await give(async () => ({ result: { message: "1 x AzuriteOre given." } }));
      await within(drawer()).findByText("1 x AzuriteOre given.");

      fireEvent.click(screen.getByText("106"));
      await screen.findByText("Storage 106");

      expect(screen.queryByText("1 x AzuriteOre given.")).toBeNull();
    });

    it("stays with its own container when it arrives after another was opened", async () => {
      let arrive: (value: unknown) => void = () => {};
      await give(() => new Promise((resolve) => { arrive = resolve; }));
      await waitFor(() => expect(worldDataApi.storageGiveItem).toHaveBeenCalled());
      fireEvent.click(screen.getByText("106"));
      await screen.findByText("Storage 106");

      await act(async () => { arrive({ result: { message: "1 x AzuriteOre given." } }); });

      expect(screen.queryByText("1 x AzuriteOre given.")).toBeNull();
    });
  });
});

describe("StoragePanel when the item list cannot be loaded", () => {
  const forbidden = () => Object.assign(new Error("Forbidden"), { status: 403 });
  const typedBox = () => screen.queryByRole("textbox", { name: "Item name or ID" }) as HTMLInputElement | null;
  const combobox = () => screen.getByRole("combobox", { name: "Item to give or fill" });
  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

  beforeEach(() => {
    vi.mocked(adminApi.itemCatalog).mockRejectedValue(forbidden());
  });

  async function openBox() {
    render(<StoragePanel {...defaultProps} />);
    fireEvent.click(await screen.findByText("105"));
    await screen.findByText("Storage 105");
  }

  async function typeItem(text: string) {
    await waitFor(() => expect(typedBox()).not.toBeNull());
    fireEvent.change(typedBox() as HTMLInputElement, { target: { value: text } });
  }

  it("takes a typed item and gives it by name, saying nothing about its volume", async () => {
    vi.mocked(worldDataApi.storageGiveItem).mockResolvedValue({ supported: true });
    await openBox();
    await typeItem("Copper Ore");
    fireEvent.click(button("Give Item"));

    await waitFor(() => expect(worldDataApi.storageGiveItem).toHaveBeenCalledWith("105", { itemName: "Copper Ore", quantity: 1, confirmation: "GIVE ITEM TO STORAGE" }));
    // One argument: no danger flag and no volume warning.
    expect(mockConfirmAction.mock.calls).toEqual([["Give 1 x Copper Ore to storage 105?"]]);
  });

  it("fills with a typed id and quantity, showing the typed text in the confirmation", async () => {
    vi.mocked(worldDataApi.storageFillItem).mockResolvedValue({ supported: true });
    await openBox();
    await typeItem("AzuriteOre");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity" }), { target: { value: "50" } });
    fireEvent.click(button("Fill Container"));

    await waitFor(() => expect(worldDataApi.storageFillItem).toHaveBeenCalledWith("105", { itemName: "AzuriteOre", quantity: 50, confirmation: "FILL ITEM TO STORAGE" }));
    expect(mockConfirmAction.mock.calls).toEqual([["Fill container 105 with 50 x AzuriteOre? Only refined resources and components are allowed."]]);
    expect(worldDataApi.storageGiveItem).not.toHaveBeenCalled();
  });

  it("keeps the failed message and Try again, and asks for no choice from the list", async () => {
    await openBox();
    await typeItem("   ");

    expect(button("Give Item").disabled).toBe(true);
    expect(button("Fill Container").disabled).toBe(true);

    fireEvent.focus(combobox());
    fireEvent.change(combobox(), { target: { value: "copper" } });

    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByText("The item list could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("Choose an item from the list first.")).toBeNull();
    for (const name of ["Give Item", "Fill Container"]) {
      expect(button(name).title).toBe("");
      expect(button(name).hasAttribute("aria-describedby")).toBe(false);
    }
  });

  it("removes the typed box once a retry loads the list", async () => {
    await openBox();
    await typeItem("Copper Ore");
    fireEvent.focus(combobox());
    const retry = await screen.findByRole("button", { name: "Try again" });

    vi.mocked(adminApi.itemCatalog).mockResolvedValue({ rows: [{ id: "AzuriteOre", itemId: "AzuriteOre", name: "Copper Ore", category: "resources", source: "Resources", volume: 0.2 }] });
    fireEvent.click(retry);

    await waitFor(() => expect(typedBox()).toBeNull());
    // The typed text no longer counts: an item is chosen from the list again.
    expect(button("Give Item").disabled).toBe(true);
    expect(button("Give Item").title).toBe("Choose an item from the list first.");
  });

  it("shows no typed box while the list loads or after it has loaded", async () => {
    let arrive: (value: { rows: [] }) => void = () => {};
    vi.mocked(adminApi.itemCatalog).mockReturnValue(new Promise((resolve) => { arrive = resolve; }));
    await openBox();
    expect(typedBox()).toBeNull();

    await act(async () => { arrive({ rows: [] }); });

    expect(typedBox()).toBeNull();
  });
});
