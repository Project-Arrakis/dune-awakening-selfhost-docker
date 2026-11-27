import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApi } from "../../api/admin";
import { clearCatalogCache, ItemCatalogCombobox } from "./ItemCatalog";

vi.mock("../../api/admin", () => ({
  adminApi: {
    itemCatalog: vi.fn()
  }
}));

const row = (id: string, name: string, category = "weapons") => ({ id, itemId: id, name, category, source: "Test" });

// Listed worst match first, so the order on screen comes from the ranking.
const CATALOG = [
  row("Blade_Sword", "Ancient Blade"),
  row("Long_1", "Greatsword"),
  row("Sword", "Practice Foil"),
  row("Dawn_1", "Sword of Dawn"),
  row("T6_Blade", "Sword"),
  row("AzuriteOre", "Copper Ore", "resources")
];

const onChange = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  clearCatalogCache();
  vi.mocked(adminApi.itemCatalog).mockResolvedValue({ rows: CATALOG });
});

afterEach(() => {
  vi.useRealTimers();
});

function renderPicker() {
  render(<>
    <ItemCatalogCombobox value={null} onChange={onChange} ariaLabel="Item" />
    <button type="button">Outside</button>
  </>);
  return screen.getByRole("combobox", { name: "Item" }) as HTMLInputElement;
}

async function openPicker() {
  const input = renderPicker();
  act(() => input.focus());
  await screen.findByRole("option", { name: /Copper Ore/ });
  return input;
}

const type = (input: HTMLInputElement, text: string) => fireEvent.change(input, { target: { value: text } });
const names = () => screen.queryAllByRole("option").map((option) => option.querySelector("strong")?.textContent);

async function search(input: HTMLInputElement, text: string, expected: string[]) {
  type(input, text);
  await waitFor(() => expect(names()).toEqual(expected));
}

describe("ItemCatalogCombobox search", () => {
  it("ranks the exact name, name prefixes, the exact id, name matches, then id-only matches", async () => {
    const input = await openPicker();
    await search(input, "sword", ["Sword", "Sword of Dawn", "Practice Foil", "Greatsword", "Ancient Blade"]);
  });

  it("finds an item by its template id and shows the id only where it was needed", async () => {
    const input = await openPicker();
    await search(input, "azuriteore", ["Copper Ore"]);
    expect(screen.getByRole("option").textContent).toContain("AzuriteOre");

    await search(input, "sword", ["Sword", "Sword of Dawn", "Practice Foil", "Greatsword", "Ancient Blade"]);
    const shownIds = screen.getAllByRole("option").map((option) => option.querySelector("small[data-no-translate]")?.textContent || "");
    expect(shownIds).toEqual(["", "", "Sword", "", "Blade_Sword"]);
  });

  it("waits for a pause in typing before it searches", async () => {
    const input = await openPicker();
    vi.useFakeTimers();
    type(input, "cop");
    act(() => { vi.advanceTimersByTime(100); });
    type(input, "copper");
    act(() => { vi.advanceTimersByTime(149); });
    expect(names()).toHaveLength(CATALOG.length);

    act(() => { vi.advanceTimersByTime(1); });
    expect(names()).toEqual(["Copper Ore"]);
  });

  it("chooses from the typed text when Enter comes before the pause", async () => {
    const input = await openPicker();
    vi.useFakeTimers();
    type(input, "copper");
    expect(names()[0]).toBe("Ancient Blade");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "AzuriteOre" }));
  });

  it("moves through the results for the typed text when an arrow comes before the pause", async () => {
    const input = await openPicker();
    vi.useFakeTimers();
    type(input, "sword");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("Sword of Dawn");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "Dawn_1" }));
  });

  it("loads the result pictures only as they come into view", async () => {
    await openPicker();
    const pictures = screen.getByRole("listbox").querySelectorAll("img");
    expect(pictures).toHaveLength(CATALOG.length);
    pictures.forEach((picture) => {
      expect(picture.getAttribute("loading")).toBe("lazy");
      expect(picture.getAttribute("decoding")).toBe("async");
    });
  });
});

describe("ItemCatalogCombobox status and focus", () => {
  it("says it is loading until the item list arrives", async () => {
    let arrive: (value: { rows: typeof CATALOG }) => void = () => {};
    vi.mocked(adminApi.itemCatalog).mockReturnValue(new Promise((resolve) => { arrive = resolve; }));
    const input = renderPicker();
    act(() => input.focus());
    type(input, "copper");

    expect(screen.getByRole("status").textContent).toBe("Loading items…");
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");

    await act(async () => { arrive({ rows: CATALOG }); });
    await waitFor(() => expect(names()).toEqual(["Copper Ore"]));
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("false");
  });

  it("points a screen reader at the highlighted option while the list is shown", async () => {
    const input = renderPicker();
    // Closed: nothing to point at, and the status line is already in the page.
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.hasAttribute("aria-controls")).toBe(false);
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");

    act(() => input.focus());
    await screen.findByRole("option", { name: /Copper Ore/ });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    const options = screen.getAllByRole("option");
    expect(new Set(options.map((option) => option.id)).size).toBe(options.length);
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1].id);

    await search(input, "nothing at all", []);
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("No matching items.");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.hasAttribute("aria-controls")).toBe(false);
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("reports a cut-off result list in the status line, outside the list", async () => {
    vi.mocked(adminApi.itemCatalog).mockResolvedValue({ rows: Array.from({ length: 45 }, (_, index) => row(`Item_${index}`, `Thing ${index}`)) });
    const input = renderPicker();
    act(() => input.focus());
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(40));

    expect(screen.getByRole("status").textContent).toBe("Showing 40 of 45 matches. Type more to narrow the list.");
    expect(screen.getByRole("listbox").children).toHaveLength(40);
  });

  it("closes the list when focus leaves the picker, not when it moves within it", async () => {
    await openPicker();
    act(() => screen.getByRole("listbox").focus());
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // A press on the status line must not take focus from the search box.
    expect(fireEvent.mouseDown(screen.getByRole("status"))).toBe(false);

    act(() => screen.getByRole("button", { name: "Outside" }).focus());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("retries a failed load when the search box is focused", async () => {
    vi.mocked(adminApi.itemCatalog).mockRejectedValueOnce(new Error("offline"));
    const input = renderPicker();
    await act(async () => {});
    expect(adminApi.itemCatalog).toHaveBeenCalledTimes(1);

    act(() => input.focus());

    await screen.findByRole("option", { name: /Copper Ore/ });
    expect(adminApi.itemCatalog).toHaveBeenCalledTimes(2);
  });

  it("retries from the Try again button and keeps focus in the search box", async () => {
    vi.mocked(adminApi.itemCatalog).mockRejectedValue(new Error("offline"));
    const input = renderPicker();
    act(() => input.focus());
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("The item list could not be loaded."));
    expect(screen.queryByRole("listbox")).toBeNull();

    vi.mocked(adminApi.itemCatalog).mockResolvedValue({ rows: CATALOG });
    const retry = screen.getByRole("button", { name: "Try again" });
    act(() => retry.focus());
    fireEvent.click(retry);

    await screen.findByRole("option", { name: /Copper Ore/ });
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("retries when the already focused search box is clicked", async () => {
    vi.mocked(adminApi.itemCatalog).mockRejectedValue(new Error("offline"));
    const input = renderPicker();
    act(() => input.focus());
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("The item list could not be loaded."));

    vi.mocked(adminApi.itemCatalog).mockResolvedValue({ rows: CATALOG });
    fireEvent.click(input);

    await screen.findByRole("option", { name: /Copper Ore/ });
  });
});
