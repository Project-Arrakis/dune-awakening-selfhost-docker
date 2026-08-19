import { render, screen, within } from "@testing-library/react";
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
    expect(screen.getByRole("button", { name: "Save All" })).toBeInTheDocument();
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
});
