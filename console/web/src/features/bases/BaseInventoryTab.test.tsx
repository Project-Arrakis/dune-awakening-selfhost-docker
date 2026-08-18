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
    deleteContainerItems: vi.fn(),
    deleteAllContainerItems: vi.fn(),
    giveContainerItem: vi.fn(),
    giveContainerItems: vi.fn(),
    fillContainerItem: vi.fn()
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
      // Vault deliberately carries real volume figures -- the one container
      // in this fixture with volume tracking on, so tests can assert the
      // Volume Used row renders with real numbers as well as being withheld
      // elsewhere (issue #356).
      placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage",
      usedSlots: 2, maxSlots: 45, currentVolume: 120, maxVolume: 500, itemCount: 1200,
      items: [
        { templateId: "Stone", name: "Granite Stone", quantity: 1000 },
        { templateId: "MagnetiteOre", name: "Iron Ore", quantity: 200 }
      ]
    },
    {
      // 0/0 -- a schema without volume tracking (issue #356), or a container
      // whose inventory just has no cap. Row must be withheld, not shown as
      // a misleading 0/0.
      placeableId: "40002", name: "", typeName: "Small Storage Container", group: "storage",
      usedSlots: 1, maxSlots: 10, currentVolume: 0, maxVolume: 0, itemCount: 40,
      items: [{ templateId: "SpiceSand", name: "Spice Sand", quantity: 40 }]
    },
    {
      placeableId: "40003", name: "", typeName: "Small Ore Refinery", group: "refining",
      usedSlots: 1, maxSlots: 5, currentVolume: 0, maxVolume: 0, itemCount: 420,
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
  totals: { items: 1660, distinct: 3, containers: 3, usedSlots: 4, maxSlots: 60, currentVolume: 120, maxVolume: 500 }
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
  currentVolume: 120,
  maxVolume: 500,
  inventories: [
    {
      inventoryId: "9001",
      maxSlots: 45,
      usedSlots: 3,
      currentVolume: 120,
      maxVolume: 500,
      slots: [
        { itemId: "501", templateId: "Stone", name: "Granite Stone", positionIndex: 0, quantity: 600, qualityLevel: 0, currentDurability: null, maxDurability: null },
        { itemId: "502", templateId: "MagnetiteOre", name: "Iron Ore", positionIndex: 1, quantity: 200, qualityLevel: 0, currentDurability: null, maxDurability: null },
        { itemId: "503", templateId: "Stone", name: "Granite Stone", positionIndex: 2, quantity: 400, qualityLevel: 0, currentDurability: null, maxDurability: null }
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
    // 120 of 500 volume (issue #356) -- only the Vault carries volume in this
    // fixture, and its 120/500 is also the tab-wide total since the other
    // two containers are 0/0.
    expect(total("Volume used")).toBe("24%");
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
        { placeableId: "10", name: "", typeName: "Chest", group: "storage", usedSlots: 0, maxSlots: 20, currentVolume: 0, maxVolume: 0, itemCount: 0, items: [] },
        { placeableId: "9", name: "", typeName: "Chest", group: "storage", usedSlots: 0, maxSlots: 20, currentVolume: 0, maxVolume: 0, itemCount: 0, items: [] },
        { placeableId: "77", name: "Zeta Vault", typeName: "Storage Container", group: "storage", usedSlots: 0, maxSlots: 45, currentVolume: 0, maxVolume: 0, itemCount: 0, items: [] },
        { placeableId: "88", name: "Alpha Vault", typeName: "Storage Container", group: "storage", usedSlots: 0, maxSlots: 45, currentVolume: 0, maxVolume: 0, itemCount: 0, items: [] }
      ],
      items: [],
      totals: { items: 0, distinct: 0, containers: 4, usedSlots: 0, maxSlots: 130, currentVolume: 0, maxVolume: 0 }
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
      totals: { items: 0, distinct: 0, containers: 0, usedSlots: 0, maxSlots: 0, currentVolume: 0, maxVolume: 0 }
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
      totals: { items: 0, distinct: 0, containers: 0, usedSlots: 0, maxSlots: 0, currentVolume: 0, maxVolume: 0 }
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
        usedSlots: 0, maxSlots: 5, currentVolume: 0, maxVolume: 0, itemCount: 0, items: []
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

  // Found during PR #349's own Layer 3 audit (Architect hat): the header row
  // and each data row must have the SAME number of children in the SAME
  // order, or styles.css's nth-child-based column alignment (e.g. right-
  // aligning "Qty") silently targets the wrong column the moment the
  // with-checkbox modifier adds an extra leading <span/> for bulk-select.
  // This test can't compute actual CSS (jsdom doesn't run a layout engine),
  // but it locks in the one thing that actually determines whether the
  // nth-child selectors line up: identical child counts, header vs. data.
  it("keeps the header row and data rows structurally aligned when bulk-select is offered", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    const header = document.querySelector(".bases-inventory-contents-row.head");
    const dataRow = document.querySelector(".bases-inventory-contents-row:not(.head)");
    expect(header).toBeTruthy();
    expect(dataRow).toBeTruthy();
    expect(header?.classList.contains("with-checkbox")).toBe(true);
    expect(dataRow?.classList.contains("with-checkbox")).toBe(true);
    // Same child count is what makes nth-child(N) mean the same column in
    // both rows -- a header with 5 children and a data row with 6 (or vice
    // versa) is exactly the class of bug this test exists to catch.
    expect(header?.children.length).toBe(dataRow?.children.length);
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
        inventoryId: "9001", maxSlots: 4, usedSlots: 3, currentVolume: 0, maxVolume: 0,
        slots: [
          { itemId: "601", templateId: "Stone", name: "Granite Stone", positionIndex: 1, quantity: 10, qualityLevel: 0, currentDurability: null, maxDurability: null },
          { itemId: "602", templateId: "MagnetiteOre", name: "Iron Ore", positionIndex: 1, quantity: 20, qualityLevel: 0, currentDurability: null, maxDurability: null },
          { itemId: "603", templateId: "SpiceSand", name: "Spice Sand", positionIndex: 99, quantity: 30, qualityLevel: 0, currentDurability: null, maxDurability: null }
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

  // Found during PR #349's own Layer 3 audit (UI hat): an operator reading
  // "Stop that map before deleting stored items" while Give/Fill sit fully
  // interactive a few lines below has no way to tell that's deliberate --
  // this test locks in the explanatory clause added to close that gap.
  it("explains that Give and Fill are unaffected when the map-running message is shown", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      deleteSafety: {
        safe: false, known: true, map: "HaggaBasin", partitionId: 68,
        reason: "HaggaBasin · Partition 68 is running. Stop that map before deleting stored items."
      }
    });
    renderTab();
    await loaded();
    await openVaultContents();
    expect(screen.getByText(/Giving and filling items are unaffected/i)).toBeTruthy();
    // Give/Fill must actually still be live in this exact state, or the
    // explanatory text itself would be false.
    expect(screen.getByLabelText("Item name or ID to give")).toBeTruthy();
    expect(screen.getByLabelText("Item name or ID to fill")).toBeTruthy();
  });

  // The explanatory clause is specific to the map-safety case -- it must
  // not appear for the OTHER reason deletion can be unavailable (a
  // Refining/Crafting container), where Give/Fill are ALSO unavailable, so
  // "unaffected" would be actively wrong there.
  it("does not claim Give/Fill are unaffected for crafting/refining containers, where they are also unavailable", async () => {
    mockInventory();
    mockSlots({ ...SLOTS, group: "refining", typeName: "Small Ore Refinery" });
    renderTab();
    await loaded();
    await openVaultContents();
    expect(screen.queryByText(/Giving and filling items are unaffected/i)).toBeNull();
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
        inventoryId: "9003", maxSlots: 5, usedSlots: 1, currentVolume: 0, maxVolume: 0,
        slots: [{ itemId: "701", templateId: "MagnetiteOre", name: "Iron Ore", positionIndex: 0, quantity: 420, qualityLevel: 0, currentDurability: null, maxDurability: null }]
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

  // Issue #356: pre-existing items given before the volume-checking fix
  // landed have a permanent NULL volume_override, which every capacity check
  // already treats as 0 -- so a backfill was judged too risky to run against
  // every operator's live data for a LOW-MEDIUM accuracy gap. Surfacing the
  // real, current volume total directly (rather than leaving it implicit)
  // was the chosen fix instead.
  it("shows a container's volume usage on its card when the schema tracks it", async () => {
    mockInventory();
    renderTab();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Containers" }));

    const vault = cards().find((card) => card.textContent?.includes("Vault"));
    expect(within(vault as HTMLElement).getByText("Volume Used")).toBeTruthy();
    expect(within(vault as HTMLElement).getByText("120.0 / 500.0")).toBeTruthy();
  });

  it("withholds the volume row on a card whose container has no volume cap", async () => {
    mockInventory();
    renderTab();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Containers" }));

    // The 40002 Small Storage Container fixture is 0/0 -- no volume tracked.
    const smallContainer = cards().find((card) => card.textContent?.includes("Small Storage Container"));
    expect(within(smallContainer as HTMLElement).queryByText("Volume Used")).toBeNull();
  });

  it("shows a container's volume usage in the contents overlay summary", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Volume Used")).toBeTruthy();
    expect(within(dialog).getByText("120.0 / 500.0")).toBeTruthy();
  });

  // Give/Give-multiple/Fill/bulk-delete: added alongside the raw-resource
  // catalog work (issue #347). Storage-group only, same as the existing
  // single-item delete above -- SLOTS' fixture container is already a
  // "storage" group with deleteSafety.safe true, so these reuse the same
  // Vault fixture rather than a new one.

  it("gives a single item and refetches both the slots and the tab", async () => {
    mockInventory();
    vi.mocked(basesApi.giveContainerItem).mockResolvedValue({
      supported: true,
      result: { ok: true, inserted: { id: "601", templateId: "AzuriteOre", stackSize: 20 } }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.change(screen.getByLabelText("Item name or ID to give"), { target: { value: "AzuriteOre" } });
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Give Item" }));

    await waitFor(() => expect(basesApi.giveContainerItem).toHaveBeenCalled());
    expect(vi.mocked(basesApi.giveContainerItem).mock.calls[0]).toEqual([
      "1006", "40001", { itemName: "AzuriteOre", quantity: 20, confirmation: "GIVE ITEM TO STORAGE" }
    ]);
    await waitFor(() => expect(vi.mocked(basesApi.inventory).mock.calls.length).toBeGreaterThan(1));
    // The input clears after a successful give, ready for the next item.
    await waitFor(() => expect((screen.getByLabelText("Item name or ID to give") as HTMLInputElement).value).toBe(""));
  });

  it("does not give an item when the confirmation is declined", async () => {
    mockInventory();
    confirmAction.mockResolvedValue(false);
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.change(screen.getByLabelText("Item name or ID to give"), { target: { value: "AzuriteOre" } });
    fireEvent.click(screen.getByRole("button", { name: "Give Item" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(basesApi.giveContainerItem).not.toHaveBeenCalled();
  });

  it("batches several distinct items into one give-items call", async () => {
    mockInventory();
    vi.mocked(basesApi.giveContainerItems).mockResolvedValue({
      supported: true,
      result: { ok: true, results: [] }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();

    // Queue the first item into the batch...
    fireEvent.change(screen.getByLabelText("Item name or ID to give"), { target: { value: "AzuriteOre" } });
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Batch" }));
    await waitFor(() => expect(screen.getByText(/AzuriteOre ×20/)).toBeTruthy());

    // ...then type a second item and give both in one click, folding the
    // not-yet-queued second item in at confirm time.
    fireEvent.change(screen.getByLabelText("Item name or ID to give"), { target: { value: "PlantFiber" } });
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Give 2 Items/ }));

    await waitFor(() => expect(basesApi.giveContainerItems).toHaveBeenCalled());
    expect(vi.mocked(basesApi.giveContainerItems).mock.calls[0]).toEqual([
      "1006", "40001",
      [{ itemName: "AzuriteOre", quantity: 20 }, { itemName: "PlantFiber", quantity: 5 }],
      "GIVE ITEMS TO STORAGE"
    ]);
    // A single-item give must never be routed through the batch endpoint.
    expect(basesApi.giveContainerItem).not.toHaveBeenCalled();
  });

  // Issue #355 (found during PR #349's own Layer 3 audit, QA hat): the test
  // above only ever mocks giveContainerItems to resolve successfully, so
  // there was no coverage for what the UI does when the batch call fails
  // partway through -- the exact scenario giveMultipleItemsToStorage is
  // designed to produce (an error like "...stopped before giving item N;
  // N-1 of M items were already given"). Errors already propagate through
  // the same onError/deleteError wiring this file's bulk-delete failure
  // test above already proves works for a different mutation -- this test
  // proves it also holds for Give Multiple specifically, and that the
  // backend's partial-success count reaches the operator verbatim rather
  // than being replaced with a generic failure message.
  it("surfaces a partial-batch give-items failure through onError with the real partial-success count", async () => {
    mockInventory();
    vi.mocked(basesApi.giveContainerItems).mockRejectedValue(
      new Error("Batch stopped before giving PlantFiber; 1 of 2 items were already given")
    );
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.change(screen.getByLabelText("Item name or ID to give"), { target: { value: "AzuriteOre" } });
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Batch" }));
    await waitFor(() => expect(screen.getByText(/AzuriteOre ×20/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Item name or ID to give"), { target: { value: "PlantFiber" } });
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Give 2 Items/ }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      "Batch stopped before giving PlantFiber; 1 of 2 items were already given"
    ));
    // The same message must also render inline in the modal, not just fire
    // the onError side channel -- an operator reading the modal itself
    // (rather than wherever onError surfaces toasts/logs) must see exactly
    // how far the batch got.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Batch stopped before giving PlantFiber; 1 of 2 items were already given"
    );
    // The batch is deliberately NOT cleared on failure -- silently dropping
    // a failed batch would force the operator to re-enter every item to
    // retry, and the backend's own message already tells them what
    // succeeded vs. what to retry.
    expect(screen.getByText(/AzuriteOre ×20/)).toBeTruthy();
  });

  it("removes a queued item from the batch before giving", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.change(screen.getByLabelText("Item name or ID to give"), { target: { value: "AzuriteOre" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Batch" }));
    await waitFor(() => expect(screen.getByText(/AzuriteOre/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Remove AzuriteOre from batch/ }));
    expect(screen.queryByText(/AzuriteOre ×/)).toBeNull();
  });

  it("fills a container with a raw resource, refined resource, or component", async () => {
    mockInventory();
    vi.mocked(basesApi.fillContainerItem).mockResolvedValue({
      supported: true,
      result: { ok: true, inserted: { id: "602", templateId: "SteelBar", stackSize: 50, volumeOverride: 50 } }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.change(screen.getByLabelText("Item name or ID to fill"), { target: { value: "SteelBar" } });
    fireEvent.change(screen.getByLabelText("Quantity to fill"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill" }));

    await waitFor(() => expect(basesApi.fillContainerItem).toHaveBeenCalled());
    expect(vi.mocked(basesApi.fillContainerItem).mock.calls[0]).toEqual([
      "1006", "40001", { itemName: "SteelBar", quantity: 50, confirmation: "FILL ITEM TO STORAGE" }
    ]);
    await waitFor(() => expect(vi.mocked(basesApi.inventory).mock.calls.length).toBeGreaterThan(1));
  });

  it("does not offer Give/Fill for crafting or refining containers", async () => {
    mockInventory();
    mockSlots({ ...SLOTS, group: "refining", typeName: "Small Ore Refinery" });
    renderTab();
    await loaded();
    await openVaultContents();

    expect(screen.queryByLabelText("Item name or ID to give")).toBeNull();
    expect(screen.queryByLabelText("Item name or ID to fill")).toBeNull();
  });

  // Per INC-2026-07-31-001: the engine only claims dune.items rows at
  // server startup, so given/filled items stay invisible in-game until a
  // restart -- this fork has already relearned that the hard way once
  // (the standalone Storage tab's own "Apply Fills" note), so the warning
  // must not go missing from this second surface either.
  it("warns that given/filled items require a Survival server restart to appear in-game", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    expect(screen.getByText(/not visible in-game until the Survival server restarts/)).toBeTruthy();
  });

  it("does not show the restart warning when Give/Fill is unavailable for this container", async () => {
    mockInventory();
    mockSlots({ ...SLOTS, group: "refining", typeName: "Small Ore Refinery" });
    renderTab();
    await loaded();
    await openVaultContents();

    expect(screen.queryByText(/not visible in-game until the Survival server restarts/)).toBeNull();
  });

  it("selects several items and deletes only the checked ones", async () => {
    mockInventory();
    vi.mocked(basesApi.deleteContainerItems).mockResolvedValue({
      supported: true,
      result: {
        ok: true, baseId: 1006, placeableId: "40001", inventoryId: "9001",
        typeName: "Storage Container", group: "storage",
        removed: [
          { itemId: "501", templateId: "Stone", count: 600 },
          { itemId: "503", templateId: "Stone", count: 400 }
        ],
        message: "2 of 2 requested item(s) were deleted from the database.",
        deleteSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" }
      }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();

    const checkboxes = screen.getAllByRole("checkbox", { name: /Select Granite Stone for bulk delete/ });
    expect(checkboxes.length).toBe(2);
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    fireEvent.click(screen.getByRole("button", { name: /Delete Selected \(2\)/ }));
    await waitFor(() => expect(basesApi.deleteContainerItems).toHaveBeenCalled());
    expect(vi.mocked(basesApi.deleteContainerItems).mock.calls[0]).toEqual([
      "1006", "40001", ["501", "503"], "DELETE ITEMS"
    ]);
    await waitFor(() => expect(vi.mocked(basesApi.inventory).mock.calls.length).toBeGreaterThan(1));
  });

  it("disables Delete Selected until at least one item is checked", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    const deleteSelected = screen.getByRole("button", { name: /Delete Selected \(0\)/ }) as HTMLButtonElement;
    expect(deleteSelected.disabled).toBe(true);
  });

  it("does not call the bulk-delete API when the confirmation is declined", async () => {
    mockInventory();
    confirmAction.mockResolvedValue(false);
    renderTab();
    await loaded();
    await openVaultContents();

    const checkboxes = screen.getAllByRole("checkbox", { name: /Select Granite Stone for bulk delete/ });
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole("button", { name: /Delete Selected \(1\)/ }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(basesApi.deleteContainerItems).not.toHaveBeenCalled();
  });

  it("clears every item in the container via Delete All", async () => {
    mockInventory();
    vi.mocked(basesApi.deleteAllContainerItems).mockResolvedValue({
      supported: true,
      result: {
        ok: true, baseId: 1006, placeableId: "40001", inventoryId: "9001",
        typeName: "Storage Container", group: "storage",
        removed: [
          { itemId: "501", templateId: "Stone", count: 600 },
          { itemId: "502", templateId: "MagnetiteOre", count: 200 },
          { itemId: "503", templateId: "Stone", count: 400 }
        ],
        message: "3 item(s) were deleted from the database.",
        deleteSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" }
      }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getByRole("button", { name: "Delete All" }));
    await waitFor(() => expect(basesApi.deleteAllContainerItems).toHaveBeenCalled());
    expect(vi.mocked(basesApi.deleteAllContainerItems).mock.calls[0]).toEqual(["1006", "40001", "DELETE ALL ITEMS"]);
    await waitFor(() => expect(vi.mocked(basesApi.inventory).mock.calls.length).toBeGreaterThan(1));
  });

  it("does not offer bulk-delete controls when the map cannot be verified safe", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      deleteSafety: {
        safe: false, known: true, map: "HaggaBasin", partitionId: 68,
        reason: "HaggaBasin · Partition 68 is running. Stop that map before deleting stored items."
      }
    });
    renderTab();
    await loaded();
    await openVaultContents();

    expect(screen.queryByRole("button", { name: /Delete Selected/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete All" })).toBeNull();
    // Give/Fill are pure inserts and stay available regardless of map safety.
    expect(screen.getByLabelText("Item name or ID to give")).toBeTruthy();
  });

  it("reports a failed bulk delete through onError without clearing the selection state silently", async () => {
    mockInventory();
    vi.mocked(basesApi.deleteContainerItems).mockRejectedValue(new Error("database is unreachable"));
    renderTab();
    await loaded();
    await openVaultContents();

    const checkboxes = screen.getAllByRole("checkbox", { name: /Select Granite Stone for bulk delete/ });
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole("button", { name: /Delete Selected \(1\)/ }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("database is unreachable"));
  });
});
