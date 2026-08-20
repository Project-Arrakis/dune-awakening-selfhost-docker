import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { marketBotItemsApi } from "../../api/marketBotItems";
import { BotItemsTab } from "./BotItemsTab";

vi.mock("../../api/marketBotItems", () => ({
  marketBotItemsApi: {
    list: vi.fn(),
    catalog: vi.fn(),
    save: vi.fn()
  }
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(marketBotItemsApi.list).mockResolvedValue({
    capabilities: { exchangeMarket: true },
    rows: [{
      templateId: "TestWeapon",
      displayName: "Test Weapon",
      category: "ranked_weapons",
      qualityLevel: 3,
      price: 123456789,
      listings: 2,
      enabled: true,
      overridden: false,
      isNew: false,
      unsafe: false
    }]
  });
});

describe("BotItemsTab", () => {
  it("presents title-cased categories and aligned purpose-specific columns", async () => {
    render(<BotItemsTab onError={vi.fn()} />);

    expect(await screen.findByText("Test Weapon")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Ranked Weapons" })).toBeInTheDocument();

    const categorySelect = screen.getByRole("combobox", { name: "Category" });
    const categoryOption = within(categorySelect).getByRole("option", { name: "Ranked Weapons" });
    expect(categoryOption).toHaveValue("ranked_weapons");

    expect(screen.getByRole("columnheader", { name: "Price" })).toHaveClass("bot-items-col-price");
    expect(screen.getByRole("columnheader", { name: "On" })).toHaveClass("bot-items-col-enabled");
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Test Weapon Price").closest("td")).toHaveClass("bot-items-col-price");
    expect(screen.getByLabelText("Test Weapon On").closest("td")).toHaveClass("bot-items-col-enabled");
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Item" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable Matches" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable Matches" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "What Enabling and Disabling Does" })).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("It does not immediately remove existing bot listings");
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
  });

  it("keeps the remove action with the removable custom item", async () => {
    vi.mocked(marketBotItemsApi.list).mockResolvedValue({
      capabilities: { exchangeMarket: true },
      rows: [{
        templateId: "CustomWeapon",
        displayName: "Custom Weapon",
        category: "ranked_weapons",
        qualityLevel: 0,
        price: 5000,
        listings: 1,
        enabled: true,
        overridden: false,
        isNew: true,
        unsafe: false
      }]
    });

    render(<BotItemsTab onError={vi.fn()} />);

    const itemCell = (await screen.findByText("Custom Weapon")).closest("td");
    expect(itemCell).not.toBeNull();
    expect(within(itemCell!).getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("uses the On header checkbox for the current page and reveals sticky save actions", async () => {
    render(<BotItemsTab onError={vi.fn()} />);

    expect(await screen.findByLabelText("Test Weapon On")).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable All Items on This Page" }));

    expect(screen.getByLabelText("Test Weapon On")).not.toBeChecked();
    expect(screen.getByText("1 Unsaved Change")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard Changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(screen.getByLabelText("Test Weapon On")).toBeChecked();
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
  });

  it("sorts every Bot Items page by the selected column and direction", async () => {
    vi.mocked(marketBotItemsApi.list).mockResolvedValue({
      capabilities: { exchangeMarket: true },
      rows: [
        { templateId: "Zebra", displayName: "Zebra", category: "weapons", qualityLevel: 2, price: 200, listings: 2, enabled: true, overridden: false, isNew: false, unsafe: false },
        { templateId: "Alpha", displayName: "Alpha", category: "resources", qualityLevel: 3, price: 300, listings: 3, enabled: false, overridden: false, isNew: false, unsafe: false },
        { templateId: "Middle", displayName: "Middle", category: "armor", qualityLevel: 1, price: 100, listings: 1, enabled: true, overridden: false, isNew: false, unsafe: false }
      ]
    });
    render(<BotItemsTab onError={vi.fn()} />);

    await screen.findByLabelText("Alpha Price");
    expect(screen.getAllByRole("spinbutton", { name: / Price$/ }).map((input) => input.getAttribute("aria-label"))).toEqual(["Alpha Price", "Middle Price", "Zebra Price"]);

    fireEvent.click(screen.getByRole("button", { name: "Sort by Price" }));
    expect(screen.getAllByRole("spinbutton", { name: / Price$/ }).map((input) => input.getAttribute("aria-label"))).toEqual(["Middle Price", "Zebra Price", "Alpha Price"]);
    expect(screen.getByRole("columnheader", { name: "Price" })).toHaveAttribute("aria-sort", "ascending");

    fireEvent.click(screen.getByRole("button", { name: "Sort by Price, currently ascending" }));
    expect(screen.getAllByRole("spinbutton", { name: / Price$/ }).map((input) => input.getAttribute("aria-label"))).toEqual(["Alpha Price", "Zebra Price", "Middle Price"]);
    expect(screen.getByRole("columnheader", { name: "Price" })).toHaveAttribute("aria-sort", "descending");
  });
});
