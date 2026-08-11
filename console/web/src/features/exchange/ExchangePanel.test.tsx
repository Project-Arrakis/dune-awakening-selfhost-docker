import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeApi, type ExchangeItemsResponse } from "../../api/exchange";
import { ExchangePanel } from "./ExchangePanel";

vi.mock("../../api/exchange", () => ({
  exchangeApi: {
    items: vi.fn(),
    listings: vi.fn(),
    stats: vi.fn(),
    getConfig: vi.fn(),
    saveConfig: vi.fn()
  }
}));

function renderPanel(overrides: Partial<Parameters<typeof ExchangePanel>[0]> = {}) {
  const props = {
    onError: vi.fn(),
    confirmAction: vi.fn().mockResolvedValue(true),
    formatMutationResult: vi.fn().mockReturnValue("Action completed."),
    ...overrides
  };
  render(<ExchangePanel {...props} />);
  return props;
}

function itemsResponse(overrides: Partial<ExchangeItemsResponse> = {}): ExchangeItemsResponse {
  return {
    capabilities: { exchange: true },
    totalCount: 1,
    totalItems: 1,
    rows: [
      {
        template_id: "PartialStabilizationBelt",
        quality_level: 0,
        display_name: "Partial Stabilization Belt",
        category: "utility",
        tier: null,
        lowest_price: 45084,
        total_stock: 4,
        npc_stock: 0,
        listing_count: 4,
        icon: null
      }
    ],
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(exchangeApi.getConfig).mockResolvedValue({ botOwnerIds: [], blacklistedOwnerIds: [] });
  vi.mocked(exchangeApi.listings).mockResolvedValue({ capabilities: { exchange: true }, rows: [] });
});

describe("ExchangePanel", () => {
  it("renders an aggregated item row with name and lowest price", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    expect(await screen.findByText("Partial Stabilization Belt")).toBeInTheDocument();
    expect(screen.getByText("45,084")).toBeInTheDocument();
  });

  it("defaults the owner filter to player listings", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ owner: "player" }));
  });

  it("refetches when the owner filter changes", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    fireEvent.change(screen.getByRole("combobox", { name: /Show/ }), { target: { value: "bot" } });

    await waitFor(() => expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ owner: "bot" })));
  });

  it("submits the search term", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    fireEvent.change(screen.getByPlaceholderText("Search item name, category, or template"), { target: { value: "belt" } });
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ q: "belt" })));
  });

  it("advances to the next page", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse({ totalCount: 120, totalItems: 120 }));
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    await waitFor(() => expect(screen.getByText("Next")).not.toBeDisabled());
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ page: 1 })));
  });

  it("sorts by a column when its header is clicked", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    fireEvent.click(screen.getByRole("columnheader", { name: /Lowest Price/ }));

    await waitFor(() => expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ sortColumn: "lowest_price", sortDirection: "asc" })));
  });

  it("opens the config overlay from the gear button", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    fireEvent.click(screen.getByLabelText("Configure bots and blacklist"));

    expect(await screen.findByText("Exchange filter settings")).toBeInTheDocument();
    expect(vi.mocked(exchangeApi.getConfig)).toHaveBeenCalled();
  });

  it("loads listings on demand when a row is expanded", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    vi.mocked(exchangeApi.listings).mockResolvedValue({
      capabilities: { exchange: true },
      rows: [{ order_id: "1", template_id: "PartialStabilizationBelt", owner_type: "player", owner_name: "Halfmoondee", price: 45084, stock: 1, quality: 0 }]
    });
    renderPanel();

    fireEvent.click(await screen.findByLabelText("Show listings for Partial Stabilization Belt"));

    expect(await screen.findByText("Halfmoondee")).toBeInTheDocument();
    expect(vi.mocked(exchangeApi.listings)).toHaveBeenCalledWith("PartialStabilizationBelt", 0, "all");
  });

  it("shows the unsupported reason when the schema lacks exchange tables", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue({
      capabilities: { exchange: false },
      totalCount: 0,
      totalItems: 0,
      rows: [],
      reason: "Unsupported by detected schema. Missing required table(s): dune.dune_exchange_orders"
    });
    renderPanel();

    expect(await screen.findByText(/Missing required table/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search item name, category, or template")).not.toBeInTheDocument();
  });
});
