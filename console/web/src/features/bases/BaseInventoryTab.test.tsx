import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { basesApi, type BaseContainerSlots, type BaseInventory } from "../../api/bases";
import { BaseInventoryTab } from "./BaseInventoryTab";

vi.mock("../../api/bases", () => ({
  basesApi: {
    inventory: vi.fn(),
    containerSlots: vi.fn(),
    deleteContainerItem: vi.fn(),
    addContainerItem: vi.fn()
  }
}));

// The add panel mounts ItemCatalogSelector, which fetches the full item
// catalog, and separately loads the augment subset. Neither is what these
// tests are about, so both resolve empty -- the item is selected by driving
// the selector's own input instead.
vi.mock("../../api/admin", () => ({
  adminApi: {
    itemCatalog: vi.fn(async () => ({
      rows: [
        { itemId: "ScrapMetal", id: "ScrapMetal", name: "Scrap Metal", category: "resource", source: "Resources" },
        { itemId: "UniqueSword_05", id: "UniqueSword_05", name: "Karpov 38", category: "weapon", source: "Weapons" }
      ]
    }))
  }
}));

const IMAGE = "/images/items/image-unavailable.png";

// One base holding the same template in two groups, so the group chips have
// something to actually change.
const PAYLOAD: BaseInventory = {
  supported: true,
  baseId: 1006,
  groups: [
    { key: "storage", name: "Storage", containerCount: 2, itemCount: 1240 },
    { key: "refining", name: "Refining", containerCount: 1, itemCount: 420 },
    // Empty groups are always present in the response; the chips filter them out.
    { key: "crafting", name: "Crafting", containerCount: 0, itemCount: 0 },
    { key: "other", name: "Other", containerCount: 0, itemCount: 0 }
  ],
  containers: [
    {
      placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage",
      usedSlots: 2, maxSlots: 45, itemCount: 1200,
      items: [
        { templateId: "Stone", name: "Granite Stone", quantity: 1000 },
        { templateId: "MagnetiteOre", name: "Iron Ore", quantity: 200 }
      ]
    },
    {
      placeableId: "40002", name: "", typeName: "Small Storage Container", group: "storage",
      usedSlots: 1, maxSlots: 10, itemCount: 40,
      items: [{ templateId: "SpiceSand", name: "Spice Sand", quantity: 40 }]
    },
    {
      placeableId: "40003", name: "", typeName: "Small Ore Refinery", group: "refining",
      usedSlots: 1, maxSlots: 5, itemCount: 420,
      items: [{ templateId: "MagnetiteOre", name: "Iron Ore", quantity: 420 }]
    }
  ],
  items: [
    {
      templateId: "Stone", name: "Granite Stone", image: IMAGE, category: "resources",
      quantity: 1000, containerCount: 1,
      containers: [{ placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage", quantity: 1000 }]
    },
    {
      templateId: "MagnetiteOre", name: "Iron Ore", image: IMAGE, category: "resources",
      quantity: 620, containerCount: 2,
      containers: [
        { placeableId: "40003", name: "", typeName: "Small Ore Refinery", group: "refining", quantity: 420 },
        { placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage", quantity: 200 }
      ]
    },
    {
      templateId: "SpiceSand", name: "Spice Sand", image: IMAGE, category: "resources",
      quantity: 40, containerCount: 1,
      containers: [{ placeableId: "40002", name: "", typeName: "Small Storage Container", group: "storage", quantity: 40 }]
    }
  ],
  totals: { items: 1660, distinct: 3, containers: 3, usedSlots: 4, maxSlots: 60 }
};

// The Vault's slots. Deliberately two stacks of the SAME template: that is the
// case the merged items[] collapses into one line and the per-slot view must
// keep apart.
const SLOTS: BaseContainerSlots = {
  supported: true,
  found: true,
  baseId: 1006,
  placeableId: "40001",
  typeName: "Storage Container",
  group: "storage",
  maxSlots: 45,
  usedSlots: 3,
  deleteSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" },
  addSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" },
  inventories: [
    {
      inventoryId: "9001",
      maxSlots: 45,
      usedSlots: 3,
      slots: [
        { itemId: "501", templateId: "Stone", name: "Granite Stone", positionIndex: 0, quantity: 600, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] },
        { itemId: "502", templateId: "MagnetiteOre", name: "Iron Ore", positionIndex: 1, quantity: 200, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] },
        { itemId: "503", templateId: "Stone", name: "Granite Stone", positionIndex: 2, quantity: 400, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] }
      ]
    }
  ]
};

function mockInventory(payload: BaseInventory = PAYLOAD) {
  vi.mocked(basesApi.inventory).mockResolvedValue(payload as never);
}

function mockSlots(payload: BaseContainerSlots = SLOTS) {
  vi.mocked(basesApi.containerSlots).mockResolvedValue(payload as never);
}

// Typed with the real signature rather than inferred from `async () => true`,
// so assertions can reach the options argument (the crafting warning) instead
// of indexing into an empty tuple.
type ConfirmOptions = {
  title?: string;
  confirmLabel?: string;
  warning?: string;
  danger?: boolean;
  details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[];
};
const confirmAction = vi.fn(async (_message: string, _options?: ConfirmOptions) => true);
const onError = vi.fn();

function renderTab() {
  render(<BaseInventoryTab baseId="1006" baseName="Test Base" confirmAction={confirmAction} onError={onError} />);
}

// Opens the Vault's contents overlay and waits for its slots to land. Finds
// the card by name rather than taking the first: the cards sort on their
// rendered label, so "Small Storage Container #40002" precedes "Vault".
//
// The overlay opens on GRID, so this waits for cells, then switches to list
// for the tests that assert on rows. Tests about the grid itself call
// openVaultContents({ stayOnGrid: true }).
async function openVaultContents({ stayOnGrid = false } = {}) {
  const vault = [...document.querySelectorAll(".bases-inventory-cards .bases-card")]
    .find((card) => card.textContent?.includes("Vault")) as HTMLElement;
  fireEvent.click(within(vault).getByRole("button", { name: /View Contents/ }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  await waitFor(() => expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBeGreaterThan(0));
  if (stayOnGrid) return;
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /List/ }));
  await waitFor(() => expect(document.querySelectorAll(".bases-inventory-contents-row:not(.head)").length).toBeGreaterThan(0));
}

// Add Item lives only in list view (grid's empty cells are its own
// affordance there), so a test asserting on the button from a grid-view start
// has to switch first.
async function switchToList() {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /List/ }));
  await waitFor(() => expect(document.querySelectorAll(".bases-inventory-contents-row:not(.head)").length).toBeGreaterThan(0));
}

// The totals row is the single "the tab has loaded" signal every test needs.
async function loaded() {
  await waitFor(() => expect(screen.getByText("Distinct")).toBeTruthy());
}

// The tab opens on Containers, so anything testing the rollup switches first.
function showItems() {
  fireEvent.click(screen.getByRole("button", { name: "Items" }));
}

function itemRows() {
  return [...document.querySelectorAll(".bases-inventory-item-row")];
}

function cards() {
  return [...document.querySelectorAll(".bases-inventory-cards .bases-card")];
}

// Group names appear twice on screen -- once as a filter chip, once as a
// section heading -- so both need addressing by role/class, never by text.
function groupHeadings() {
  return [...document.querySelectorAll(".bases-inventory-group-head h4")].map((node) => node.textContent);
}

function total(label: string) {
  const term = [...document.querySelectorAll(".bases-inventory-totals dt")]
    .find((node) => node.textContent === label);
  return term?.nextElementSibling?.textContent;
}

beforeEach(() => {
  vi.clearAllMocks();
  confirmAction.mockResolvedValue(true);
  // Every test that opens the contents overlay needs slots; the ones that
  // don't are unaffected by the default.
  mockSlots();
});

describe("BaseInventoryTab", () => {
  it("shows the totals and the item rollup once loaded", async () => {
    mockInventory();
    renderTab();
    await loaded();
    showItems();

    expect(total("Items")).toBe("1,660");
    expect(total("Distinct")).toBe("3");
    expect(total("Containers")).toBe("3");
    // 4 of 60 slots.
    expect(total("Slots used")).toBe("7%");
    expect(itemRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Granite Stone"),
      expect.stringContaining("Iron Ore"),
      expect.stringContaining("Spice Sand")
    ]);
  });

  it("surfaces a load failure with a working retry", async () => {
    vi.mocked(basesApi.inventory).mockRejectedValueOnce(new Error("database is unreachable"));
    renderTab();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("database is unreachable");

    mockInventory();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await loaded();
    expect(basesApi.inventory).toHaveBeenCalledTimes(2);
  });

  it("expands an item to show which containers hold it", async () => {
    mockInventory();
    renderTab();
    await loaded();
    showItems();

    fireEvent.click(itemRows()[1]);
    const breakdown = document.querySelector(".bases-inventory-breakdown");
    expect(breakdown?.textContent).toContain("Small Ore Refinery #40003");
    expect(breakdown?.textContent).toContain("Vault");
    expect(breakdown?.textContent).toContain("420");
    expect(breakdown?.textContent).toContain("200");
  });

  it("switches between the item rollup and the container cards without refetching", async () => {
    mockInventory();
    renderTab();
    await loaded();

    // Opens on Containers.
    expect(itemRows()).toHaveLength(0);
    expect(cards()).toHaveLength(3);
    expect(groupHeadings()).toEqual(["Storage", "Refining"]);

    showItems();
    expect(cards()).toHaveLength(0);
    expect(itemRows()).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Containers" }));
    expect(cards()).toHaveLength(3);
    expect(basesApi.inventory).toHaveBeenCalledTimes(1);
  });

  it("sorts containers by their displayed label within each group", async () => {
    mockInventory({
      ...PAYLOAD,
      groups: [
        { key: "storage", name: "Storage", containerCount: 4, itemCount: 0 },
        { key: "refining", name: "Refining", containerCount: 0, itemCount: 0 },
        { key: "crafting", name: "Crafting", containerCount: 0, itemCount: 0 },
        { key: "other", name: "Other", containerCount: 0, itemCount: 0 }
      ],
      // Deliberately out of order, and mixing renamed with unrenamed: a
      // rename has to file under the name shown on the card, and "#9" has to
      // sort ahead of "#10" rather than lexically after it.
      containers: [
        { placeableId: "10", name: "", typeName: "Chest", group: "storage", usedSlots: 0, maxSlots: 20, itemCount: 0, items: [] },
        { placeableId: "9", name: "", typeName: "Chest", group: "storage", usedSlots: 0, maxSlots: 20, itemCount: 0, items: [] },
        { placeableId: "77", name: "Zeta Vault", typeName: "Storage Container", group: "storage", usedSlots: 0, maxSlots: 45, itemCount: 0, items: [] },
        { placeableId: "88", name: "Alpha Vault", typeName: "Storage Container", group: "storage", usedSlots: 0, maxSlots: 45, itemCount: 0, items: [] }
      ],
      items: [],
      totals: { items: 0, distinct: 0, containers: 4, usedSlots: 0, maxSlots: 130 }
    });
    renderTab();
    await loaded();

    const titles = cards().map((card) => card.querySelector(".bases-card-title")?.textContent);
    expect(titles).toEqual(["Alpha Vault", "Chest", "Chest", "Zeta Vault"]);
    // The two Chests are ordered #9 before #10, not lexically.
    expect(cards()[1].textContent).toContain("#9");
    expect(cards()[2].textContent).toContain("#10");
  });

  it("names an unrenamed container by its type and id", async () => {
    mockInventory();
    renderTab();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Containers" }));

    const silo = cards().find((card) => card.textContent?.includes("Small Storage Container"));
    expect(silo?.textContent).toContain("#40002");
  });

  it("filters both views by group, restating quantities to the group's share", async () => {
    mockInventory();
    renderTab();
    await loaded();
    showItems();

    fireEvent.click(screen.getByRole("button", { name: /Refining/ }));
    // Only Iron Ore lives in a refining container, and only 420 of its 620.
    const rows = itemRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Iron Ore");
    expect(rows[0].textContent).toContain("420");
    expect(rows[0].textContent).not.toContain("620");

    fireEvent.click(screen.getByRole("button", { name: "Containers" }));
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain("Small Ore Refinery");

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(cards()).toHaveLength(3);
  });

  it("only filters on submit, and Clear restores everything", async () => {
    mockInventory();
    renderTab();
    await loaded();
    showItems();

    const input = screen.getByLabelText("Filter base inventory");
    fireEvent.change(input, { target: { value: "iron" } });
    expect(itemRows()).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(itemRows()).toHaveLength(1);
    expect(itemRows()[0].textContent).toContain("Iron Ore");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(itemRows()).toHaveLength(3);
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("reports a filter that matches nothing", async () => {
    mockInventory();
    renderTab();
    await loaded();
    showItems();

    fireEvent.change(screen.getByLabelText("Filter base inventory"), { target: { value: "sandworm" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByText("No items match this filter.")).toBeTruthy();
  });

  it("caps the rollup and lifts the cap on demand", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      templateId: `Item${index}`,
      name: `Item ${index}`,
      image: IMAGE,
      category: "resources",
      quantity: 100 - index,
      containerCount: 1,
      containers: [{ placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage" as const, quantity: 100 - index }]
    }));
    mockInventory({ ...PAYLOAD, items: many });
    renderTab();
    await loaded();
    showItems();

    expect(itemRows()).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Show all 30 items" }));
    expect(itemRows()).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer items" }));
    expect(itemRows()).toHaveLength(25);
  });

  // An unreadable schema is a settled answer, not a failure: it arrives as a
  // normal 200 and must not offer a Retry, which could only fail identically.
  it("states an unsupported schema without offering a retry", async () => {
    mockInventory({
      supported: false,
      reason: "Unsupported by detected schema. Missing required table(s): dune.items",
      baseId: 1006,
      groups: [],
      containers: [],
      items: [],
      totals: { items: 0, distinct: 0, containers: 0, usedSlots: 0, maxSlots: 0 }
    });
    renderTab();

    expect(await screen.findByText(/Missing required table\(s\): dune\.items/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    // None of the tab's own controls render, so there is nothing to interact
    // with that would imply the data is merely empty.
    expect(screen.queryByRole("button", { name: "Containers" })).not.toBeInTheDocument();
    expect(screen.queryByText("Slots used")).not.toBeInTheDocument();
  });

  it("says so plainly when a base stores nothing", async () => {
    mockInventory({
      ...PAYLOAD,
      groups: PAYLOAD.groups.map((group) => ({ ...group, containerCount: 0, itemCount: 0 })),
      containers: [],
      items: [],
      totals: { items: 0, distinct: 0, containers: 0, usedSlots: 0, maxSlots: 0 }
    });
    renderTab();
    await loaded();

    expect(screen.getByText("No storage at this base.")).toBeTruthy();
    // A base with no containers has no group chips to offer beyond All.
    expect(document.querySelectorAll(".bases-inventory-chip")).toHaveLength(1);

    showItems();
    expect(screen.getByText("No stored items at this base.")).toBeTruthy();
  });

  it("opens a container's contents in an overlay and closes it four ways", async () => {
    mockInventory();
    renderTab();
    await loaded();

    const vault = cards().find((card) => card.textContent?.includes("Vault")) as HTMLElement;
    // The button reports the stack count without opening anything.
    expect(within(vault).getByRole("button", { name: /View Contents/ }).textContent).toContain("2 distinct");
    expect(screen.queryByRole("dialog")).toBeNull();

    function open() {
      fireEvent.click(within(cards().find((c) => c.textContent?.includes("Vault")) as HTMLElement)
        .getByRole("button", { name: /View Contents/ }));
      return screen.getByRole("dialog");
    }

    const dialog = open();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Header identifies the container, body lists every SLOT with quantities.
    // Slots arrive in their own request, so the body fills in after the open.
    expect(within(dialog).getByRole("heading", { name: "Vault" })).toBeTruthy();
    expect(dialog.textContent).toContain("Storage Container · #40001");
    // The overlay opens on grid, where names live in tile tooltips rather than
    // as text; switch to list to read them.
    await waitFor(() => expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBeGreaterThan(0));
    fireEvent.click(within(dialog).getByRole("button", { name: /List/ }));
    await waitFor(() => expect(within(dialog).getAllByText("Granite Stone").length).toBe(2));
    // Two stacks of one template stay apart at their own quantities rather
    // than merging into the 1,000 the rollup reports.
    expect(within(dialog).getByText("600")).toBeTruthy();
    expect(within(dialog).getByText("400")).toBeTruthy();
    expect(within(dialog).getByText("Iron Ore")).toBeTruthy();
    expect(within(dialog).getByText("200")).toBeTruthy();
    // Not the other containers' contents.
    expect(within(dialog).queryByText("Spice Sand")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.click(screen.getByRole("button", { name: "Close contents" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.mouseDown(document.querySelector(".modal-overlay") as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no contents button for an empty container", async () => {
    mockInventory({
      ...PAYLOAD,
      containers: [{
        placeableId: "40009", name: "", typeName: "Repair Station", group: "other",
        usedSlots: 0, maxSlots: 5, itemCount: 0, items: []
      }],
      groups: PAYLOAD.groups.map((g) => g.key === "other"
        ? { ...g, containerCount: 1, itemCount: 0 }
        : { ...g, containerCount: 0, itemCount: 0 })
    });
    renderTab();
    await loaded();

    expect(screen.queryByRole("button", { name: /View Contents/ })).toBeNull();
    expect(cards()[0].textContent).toContain("Empty");
  });

  it("keeps the overlay open when a filter would exclude its container", async () => {
    // The overlay resolves its container from the unfiltered response, so
    // applying a group chip behind it must not blank the dialog.
    mockInventory();
    renderTab();
    await loaded();

    fireEvent.click(within(cards().find((c) => c.textContent?.includes("Vault")) as HTMLElement)
      .getByRole("button", { name: /View Contents/ }));
    // Wait for the slots request, and read names from the list view -- the
    // grid the overlay opens on keeps them in tooltips.
    await waitFor(() => expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBeGreaterThan(0));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /List/ }));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Granite Stone"));
    fireEvent.click(screen.getByRole("button", { name: /Refining/ }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("Granite Stone");
  });

  it("fetches slots per container rather than with the tab", async () => {
    mockInventory();
    renderTab();
    await loaded();
    // The base tab must not carry every slot at the base -- that tripled the
    // response on large bases -- so nothing is requested until a container
    // is actually opened.
    expect(basesApi.containerSlots).not.toHaveBeenCalled();
    await openVaultContents();
    expect(basesApi.containerSlots).toHaveBeenCalledWith("1006", "40001");
  });

  it("shows each slot separately with its own slot number", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    const rows = [...document.querySelectorAll(".bases-inventory-contents-row:not(.head)")];
    expect(rows.length).toBe(3);
    // The two Granite Stone stacks are only distinguishable by slot number.
    expect(rows[0].textContent).toContain("#0");
    expect(rows[2].textContent).toContain("#2");
  });

  it("switches to a grid that renders every empty slot", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getByRole("button", { name: /Grid/ }));
    await waitFor(() => expect(document.querySelector(".bases-inventory-slot-grid")).toBeTruthy());
    // 45 capacity: 3 filled, 42 empty.
    expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBe(45);
    expect(document.querySelectorAll(".bases-inventory-slot-cell.empty").length).toBe(42);
  });

  it("keeps a duplicate or out-of-range slot reachable instead of dropping it", async () => {
    mockInventory();
    // position_index has no unique constraint and is not bounded by
    // max_item_count, so both of these are reachable in real data. An item the
    // delete button cannot reach is the worst outcome, so neither may vanish.
    mockSlots({
      ...SLOTS,
      inventories: [{
        inventoryId: "9001", maxSlots: 4, usedSlots: 3,
        slots: [
          { itemId: "601", templateId: "Stone", name: "Granite Stone", positionIndex: 1, quantity: 10, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] },
          { itemId: "602", templateId: "MagnetiteOre", name: "Iron Ore", positionIndex: 1, quantity: 20, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] },
          { itemId: "603", templateId: "SpiceSand", name: "Spice Sand", positionIndex: 99, quantity: 30, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] }
        ]
      }]
    });
    renderTab();
    await loaded();
    await openVaultContents();
    fireEvent.click(screen.getByRole("button", { name: /Grid/ }));

    await waitFor(() => expect(document.querySelector(".bases-inventory-slot-overflow-note")).toBeTruthy());
    // One wins the cell; the duplicate and the out-of-range one are listed below.
    const overflow = [...document.querySelectorAll(".bases-inventory-contents-row:not(.head)")];
    expect(overflow.length).toBe(2);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Iron Ore");
    expect(dialog.textContent).toContain("Spice Sand");
  });

  it("deletes a whole stack and refetches both the slots and the tab", async () => {
    mockInventory();
    vi.mocked(basesApi.deleteContainerItem).mockResolvedValue({
      supported: true,
      result: {
        ok: true, partial: false, typeName: "Storage Container", group: "storage",
        removed: { itemId: "501", templateId: "Stone", count: 600, remaining: 0 },
        message: "Stone was deleted from the database.",
        deleteSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" }
      }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getAllByRole("button", { name: /^Delete Granite Stone/ })[0]);
    await waitFor(() => expect(basesApi.deleteContainerItem).toHaveBeenCalled());
    // Whole-slot delete sends no count at all -- an explicit count equal to the
    // stack would be a different request shape.
    expect(vi.mocked(basesApi.deleteContainerItem).mock.calls[0].slice(0, 4))
      .toEqual(["1006", "40001", "501", "DELETE ITEM"]);
    expect(vi.mocked(basesApi.deleteContainerItem).mock.calls[0][4]).toBeUndefined();
    // Totals, group counts and the rollup are all derived, so the tab reloads too.
    await waitFor(() => expect(vi.mocked(basesApi.inventory).mock.calls.length).toBeGreaterThan(1));
  });

  it("does not call the API when the confirmation is declined", async () => {
    mockInventory();
    confirmAction.mockResolvedValue(false);
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getAllByRole("button", { name: /^Delete Granite Stone/ })[0]);
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(basesApi.deleteContainerItem).not.toHaveBeenCalled();
  });

  it("disables deletion when the map is running or its state cannot be verified", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      deleteSafety: {
        safe: false, known: true, map: "HaggaBasin", partitionId: 68,
        reason: "HaggaBasin · Partition 68 is running. Stop that map before deleting stored items."
      },
      // Both gates resolve from one liveness probe, so in practice they always
      // arrive together -- only the wording differs.
      addSafety: {
        safe: false, known: true, map: "HaggaBasin", partitionId: 68,
        reason: "HaggaBasin · Partition 68 is running. Stop that map before adding stored items."
      }
    });
    renderTab();
    await loaded();
    await openVaultContents();
    const button = screen.getAllByRole("button", { name: /^Delete Granite Stone/ })[0] as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/HaggaBasin · Partition 68 is running/i)).toBeTruthy();
    expect(confirmAction).not.toHaveBeenCalled();
    expect(basesApi.deleteContainerItem).not.toHaveBeenCalled();
  });

  it("sends a count for a partial removal and rejects an amount above the stack", async () => {
    mockInventory();
    vi.mocked(basesApi.deleteContainerItem).mockResolvedValue({
      supported: true,
      result: {
        ok: true, partial: true, typeName: "Storage Container", group: "storage",
        removed: { itemId: "501", templateId: "Stone", count: 150, remaining: 450 },
        message: "Removed 150 of Stone from the database, leaving 450.",
        deleteSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" }
      }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();

    // Selecting a slot moves its controls into the strip below the list.
    fireEvent.click(screen.getAllByRole("button", { name: "Granite Stone" })[0]);
    await waitFor(() => expect(document.querySelector(".bases-inventory-slot-detail")).toBeTruthy());
    const input = screen.getByLabelText(/Amount of Granite Stone/) as HTMLInputElement;

    // Above the stack: blocked in the UI as well as on the server.
    fireEvent.change(input, { target: { value: "9999" } });
    await waitFor(() => expect(document.querySelector(".bases-inventory-amount-error")).toBeTruthy());

    fireEvent.change(input, { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: /Remove 150/ }));
    await waitFor(() => expect(basesApi.deleteContainerItem).toHaveBeenCalled());
    expect(vi.mocked(basesApi.deleteContainerItem).mock.calls[0][4]).toBe(150);
    await waitFor(() => expect(input.value).toBe("450"));
  });

  it("shows grade on every slot, and an augments line only on a slot that has any", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      inventories: [{
        inventoryId: "9001",
        maxSlots: 45,
        usedSlots: 2,
        slots: [
          { itemId: "501", templateId: "Stone", name: "Granite Stone", positionIndex: 0, quantity: 600, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] },
          {
            itemId: "504", templateId: "UniqueSword_05", name: "Replica Pulse-sword", positionIndex: 1, quantity: 1,
            qualityLevel: 3, currentDurability: 100, maxDurability: 100,
            augments: [{ templateId: "T6_Augment_Melee1", name: "Blade Sharpener", qualityLevel: 2 }]
          }
        ]
      }]
    });
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getByRole("button", { name: "Granite Stone" }));
    await waitFor(() => expect(document.querySelector(".bases-inventory-slot-detail")).toBeTruthy());
    const stoneDetail = document.querySelector(".bases-inventory-slot-detail-body") as HTMLElement;
    expect(within(stoneDetail).getByText(/Grade 0/)).toBeTruthy();
    expect(within(stoneDetail).queryByText(/Augments:/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Replica Pulse-sword" }));
    await waitFor(() => expect(screen.getByText(/Grade 3/)).toBeTruthy());
    const swordDetail = document.querySelector(".bases-inventory-slot-detail-body") as HTMLElement;
    expect(within(swordDetail).getByText(/100% durability/)).toBeTruthy();
    expect(within(swordDetail).getByText("Augments: Blade Sharpener (Grade 2)")).toBeTruthy();
  });

  it("keeps crafting and refining contents read-only", async () => {
    mockInventory();
    // The game's own crafting routine consumes allocated ingredients from
    // these same rows, so removing one mid-craft can leave a recipe pointing
    // at an item that no longer exists. This warning is the only thing
    // standing between an operator and that, so it is worth pinning.
    mockSlots({
      ...SLOTS,
      placeableId: "40003",
      typeName: "Small Ore Refinery",
      group: "refining",
      inventories: [{
        inventoryId: "9003", maxSlots: 5, usedSlots: 1,
        slots: [{ itemId: "701", templateId: "MagnetiteOre", name: "Iron Ore", positionIndex: 0, quantity: 420, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] }]
      }]
    });
    renderTab();
    await loaded();

    const refinery = [...document.querySelectorAll(".bases-inventory-cards .bases-card")]
      .find((card) => card.textContent?.includes("Small Ore Refinery")) as HTMLElement;
    fireEvent.click(within(refinery).getByRole("button", { name: /View Contents/ }));
    await waitFor(() => expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBeGreaterThan(0));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /List/ }));
    await waitFor(() => expect(document.querySelectorAll(".bases-inventory-contents-row:not(.head)").length).toBe(1));

    const deleteButton = screen.getByRole("button", { name: /^Delete Iron Ore/ }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    expect(screen.getByText(/available only for Storage containers/i)).toBeTruthy();
    expect(confirmAction).not.toHaveBeenCalled();
    expect(basesApi.deleteContainerItem).not.toHaveBeenCalled();
  });

  it("does not warn about crafting for a plain storage container", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getAllByRole("button", { name: /^Delete Granite Stone/ })[0]);
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    // A chest holds no live game state, so the extra warning would be noise.
    expect(confirmAction.mock.calls[0][1]?.warning).toBeUndefined();
  });

  it("reports a failed delete through onError and leaves the slot listed", async () => {
    mockInventory();
    vi.mocked(basesApi.deleteContainerItem).mockRejectedValue(new Error("database is unreachable"));
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getAllByRole("button", { name: /^Delete Granite Stone/ })[0]);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("database is unreachable"));
    expect([...document.querySelectorAll(".bases-inventory-contents-row:not(.head)")].length).toBe(3);
  });

  // StrictMode double-invokes the load effect, so two requests are genuinely
  // open at once and whichever settles last writes state. A first attempt that
  // fails after the second succeeded must not replace the loaded tab with an
  // error banner.
  it("ignores a stale response that settles after a newer one", async () => {
    const gates: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    vi.mocked(basesApi.inventory).mockImplementation(() => new Promise((resolve, reject) => {
      gates.push({ resolve, reject });
    }) as never);

    render(<StrictMode><BaseInventoryTab baseId="1006" baseName="Test Base" confirmAction={confirmAction} onError={onError} /></StrictMode>);
    await waitFor(() => expect(gates.length).toBe(2));

    // Newest request wins the tab...
    gates[1].resolve(PAYLOAD);
    await loaded();

    // ...and the older one failing afterwards must change nothing.
    gates[0].reject(new Error("stale failure"));
    await waitFor(() => expect(screen.getByText("Distinct")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(/stale failure/)).toBeNull();
  });

  it("shows a container's slot usage on its card", async () => {
    mockInventory();
    renderTab();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Containers" }));

    const vault = cards().find((card) => card.textContent?.includes("Vault"));
    expect(within(vault as HTMLElement).getByText("2 / 45")).toBeTruthy();
  });

  // ---- Adding an item ----

  const addButton = () => screen.getByRole("button", { name: /Add Item/ }) as HTMLButtonElement;
  const addPanel = () => document.querySelector(".bases-inventory-add-panel");
  const emptyCells = () => [...document.querySelectorAll(".bases-inventory-slot-cell.empty")] as HTMLButtonElement[];

  // Picks a catalog option by template id. Not by index: the selector sorts on
  // the rendered name, so "Karpov 38" precedes "Scrap Metal" and an index
  // would silently select the wrong item. Not by accessible name either --
  // that comes from catalogItemName, which is not what this file is testing.
  async function pickCatalogItem(templateId = "ScrapMetal") {
    await waitFor(() => expect(document.querySelectorAll(".catalog-item-option").length).toBeGreaterThan(0));
    const option = [...document.querySelectorAll(".catalog-item-option")]
      .find((element) => element.textContent?.includes(templateId));
    expect(option).toBeTruthy();
    fireEvent.click(option as Element);
  }

  async function openAddPanel() {
    fireEvent.click(addButton());
    await waitFor(() => expect(addPanel()).toBeTruthy());
  }

  function mockAddSuccess() {
    vi.mocked(basesApi.addContainerItem).mockResolvedValue({
      supported: true,
      result: {
        ok: true, inventoryId: "9001", typeName: "Storage Container", group: "storage",
        added: { itemId: "999", templateId: "ScrapMetal", quantity: 25, qualityLevel: 0, positionIndex: 3 },
        capacity: { usedSlots: 4, maxSlots: 45 },
        message: "ScrapMetal x25 was added to Storage Container in slot #3.",
        addSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" }
      }
    } as never);
  }

  it("opens the add panel from the list-view footer button", async () => {
    mockInventory();
    renderTab();
    await loaded();
    // List view enumerates occupied slots only, so it has no empty cell to
    // click -- the footer button is the only add affordance here, which is
    // precisely why it exists (and why it is absent from grid view).
    await openVaultContents();
    expect(emptyCells().length).toBe(0);
    await openAddPanel();
    expect(addPanel()).toBeTruthy();
  });

  it("does not offer Add Item in grid view", async () => {
    mockInventory();
    renderTab();
    await loaded();
    // Grid's own empty cells already open the panel; a second, redundant
    // control in the footer would just be noise there.
    await openVaultContents({ stayOnGrid: true });
    expect(screen.queryByRole("button", { name: /Add Item/ })).toBeNull();
    await switchToList();
    expect(screen.getByRole("button", { name: /Add Item/ })).toBeTruthy();
  });

  it("has no Back to slots button, and hides the footer's Add Item and Close while the add panel is open", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    // Both live in the footer already, via Cancel and the header's X --
    // repeating either at the top of the panel would be redundant.
    await openAddPanel();
    expect(screen.queryByRole("button", { name: /Back to slots/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add Item/ })).toBeNull();
    // The overlay itself must still be closable from this state.
    expect(screen.getByRole("button", { name: "Close contents" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeTruthy());
    expect(screen.getByRole("button", { name: /^Add Item/ })).toBeTruthy();
  });

  it("opens the add panel from an empty grid cell without claiming a slot number", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents({ stayOnGrid: true });

    const cell = emptyCells()[0];
    expect(cell).toBeTruthy();
    // Placement is not chooseable: the server always appends to the next free
    // index, so nothing on this control may promise a specific slot.
    const label = cell.getAttribute("aria-label") || "";
    expect(label).toBe("Add an item to this container");
    expect(label).not.toMatch(/slot\s*#?\d/i);
    expect(cell.getAttribute("title") || "").not.toMatch(/slot\s*#?\d/i);
    // Kept out of the tab order -- 42 empty cells would otherwise sit between
    // the grid and the controls below it.
    expect(cell.tabIndex).toBe(-1);

    fireEvent.click(cell);
    await waitFor(() => expect(addPanel()).toBeTruthy());
  });

  it("states the placement rule in the add panel", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    // Regression guard on both contracts the backend keeps.
    expect(addPanel()!.textContent).toMatch(/next free slot/i);
    expect(addPanel()!.textContent).toMatch(/never topped up/i);
  });

  it("disables adding when the map is running or its state cannot be verified", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      addSafety: {
        safe: false, known: false, map: "", partitionId: 0,
        reason: "The console cannot verify that this base's map is safely stopped, so adding items is disabled."
      }
    });
    renderTab();
    await loaded();
    await openVaultContents({ stayOnGrid: true });

    expect(emptyCells().every((cell) => cell.disabled)).toBe(true);
    expect(screen.getByText(/cannot verify that this base's map is safely stopped, so adding items is disabled/i)).toBeTruthy();
    await switchToList();
    expect(addButton().disabled).toBe(true);
    expect(basesApi.addContainerItem).not.toHaveBeenCalled();
  });

  it("keeps crafting and refining contents read-only for adding too", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      group: "refining",
      typeName: "Ore Refinery",
      // The server refuses on the group before it ever looks at the map.
      addSafety: {
        safe: false, known: true, map: "", partitionId: 0,
        reason: "Adding items is available only for Storage containers. Crafting and Refining contents are read-only to protect active jobs."
      }
    });
    renderTab();
    await loaded();
    await openVaultContents({ stayOnGrid: true });

    expect(screen.getByText(/only for Storage containers/i)).toBeTruthy();
    await switchToList();
    expect(addButton().disabled).toBe(true);
  });

  it("refuses to add to a container with no free slots", async () => {
    // Capacity comes from the container, not from the safety gate: a stopped
    // map and a plain storage box can still be full.
    mockInventory({
      ...PAYLOAD,
      containers: PAYLOAD.containers.map((container) =>
        container.placeableId === "40001" ? { ...container, usedSlots: 45, maxSlots: 45 } : container)
    });
    renderTab();
    await loaded();
    await openVaultContents({ stayOnGrid: true });

    expect(emptyCells().every((cell) => cell.disabled)).toBe(true);
    await switchToList();
    expect(addButton().disabled).toBe(true);
    expect(addButton().title).toMatch(/full \(45 \/ 45 slots\)/i);
    expect(basesApi.addContainerItem).not.toHaveBeenCalled();
  });

  it("adds an item and refetches both the slots and the tab", async () => {
    mockInventory();
    mockAddSuccess();
    renderTab();
    await loaded();
    await openVaultContents();
    const slotLoads = vi.mocked(basesApi.containerSlots).mock.calls.length;
    const tabLoads = vi.mocked(basesApi.inventory).mock.calls.length;

    await openAddPanel();
    await pickCatalogItem();
    fireEvent.change(screen.getByLabelText(/Quantity to add/i), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to container/i }));

    await waitFor(() => expect(basesApi.addContainerItem).toHaveBeenCalled());
    const call = vi.mocked(basesApi.addContainerItem).mock.calls[0];
    expect(call[0]).toBe("1006");
    expect(call[1]).toBe("40001");
    expect(call[2]).toMatchObject({ itemId: "ScrapMetal", quantity: 25, quality: 0 });
    // The phrase is deliberately distinct from GIVE ITEM TO STORAGE.
    expect(call[3]).toBe("ADD ITEM TO CONTAINER");

    // Both are invalidated by an add: this container's slots, and the tab's
    // totals, group counts and rollup.
    await waitFor(() => expect(vi.mocked(basesApi.containerSlots).mock.calls.length).toBeGreaterThan(slotLoads));
    await waitFor(() => expect(vi.mocked(basesApi.inventory).mock.calls.length).toBeGreaterThan(tabLoads));
  });

  it("tells the operator the slot was not chosen when confirming", async () => {
    mockInventory();
    mockAddSuccess();
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    await pickCatalogItem();
    fireEvent.click(screen.getByRole("button", { name: /Add to container/i }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    const details = confirmAction.mock.calls.at(-1)?.[1]?.details || [];
    const slot = details.find((detail) => detail.label === "Slot");
    // The last place the placement promise is made, and it has to stay honest.
    expect(slot?.value).toBe("Next free slot");
    expect(slot?.value).not.toMatch(/#\d/);
  });

  it("does not call the add API when the confirmation is declined", async () => {
    mockInventory();
    confirmAction.mockResolvedValue(false);
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    await pickCatalogItem();
    fireEvent.click(screen.getByRole("button", { name: /Add to container/i }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(basesApi.addContainerItem).not.toHaveBeenCalled();
  });

  it("surfaces an add failure without blanking the slot list", async () => {
    mockInventory();
    vi.mocked(basesApi.addContainerItem).mockRejectedValue(new Error("This container is full: 45 of 45 slots are used."));
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    await pickCatalogItem();
    fireEvent.click(screen.getByRole("button", { name: /Add to container/i }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/45 of 45/)));
    // The panel closes back to the slots, which are still intact -- a failed
    // add must not hide them behind a Retry the way a failed load does.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByText(/45 of 45/)).toBeTruthy();
  });

  it("rejects a quantity outside the server's own bounds before calling the API", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    await pickCatalogItem();
    const input = screen.getByLabelText(/Quantity to add/i);

    for (const value of ["0", "1000001", "1.5"]) {
      fireEvent.change(input, { target: { value } });
      await waitFor(() => expect(document.querySelector(".bases-inventory-amount-error")).toBeTruthy());
      expect((screen.getByRole("button", { name: /Add to container/i }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(input, { target: { value: "25" } });
    await waitFor(() => expect((screen.getByRole("button", { name: /Add to container/i }) as HTMLButtonElement).disabled).toBe(false));
    expect(basesApi.addContainerItem).not.toHaveBeenCalled();
  });

  it("offers augments only for an item that can take them", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();

    // A resource cannot be augmented, so the control is absent entirely rather
    // than present and empty.
    await pickCatalogItem("ScrapMetal");
    expect(addPanel()!.textContent).not.toMatch(/Aug\. Grade/);
  });

  it("keeps the add panel and the slot-detail strip mutually exclusive", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    // Selecting a slot arms the delete strip.
    fireEvent.click(screen.getAllByRole("button", { name: "Granite Stone" })[0]);
    await waitFor(() => expect(document.querySelector(".bases-inventory-slot-detail")).toBeTruthy());

    // Opening the add panel replaces the slot region and clears that strip --
    // two modes of one dialog, not two panels stacked in it. The strip is keyed
    // to an existing occupied slot and cannot represent an add.
    await openAddPanel();
    expect(document.querySelector(".bases-inventory-slot-detail")).toBeNull();
    expect(document.querySelector(".bases-inventory-contents-scroll")).toBeNull();

    // Cancel restores the slots with nothing selected. No separate "back"
    // control -- it would just duplicate what Cancel already does.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(addPanel()).toBeNull());
    expect(document.querySelector(".bases-inventory-contents-scroll")).toBeTruthy();
    expect(document.querySelector(".bases-inventory-slot-detail")).toBeNull();
  });

  it("clears the add panel when the overlay is reopened", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    await pickCatalogItem();

    // The footer's Close is hidden while the add panel is open (see the
    // "does not show Close or the footer Add Item while the add panel is
    // open" test); the header's X is what still closes the whole overlay
    // from this state.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close contents" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Reopened directly rather than via openVaultContents: contentsView is
    // sticky, so the overlay comes back in list mode and has no grid cells for
    // that helper to wait on.
    const vault = [...document.querySelectorAll(".bases-inventory-cards .bases-card")]
      .find((card) => card.textContent?.includes("Vault")) as HTMLElement;
    fireEvent.click(within(vault).getByRole("button", { name: /View Contents/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    // A half-filled form must not carry over: the capacity, the gate and the
    // confirm dialog's Container line all change with the container.
    expect(addPanel()).toBeNull();
  });
});
