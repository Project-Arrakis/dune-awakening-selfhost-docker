import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeApi } from "../../api/exchange";
import { ExchangeTransactionsTab } from "./ExchangeTransactionsTab";

vi.mock("../../api/exchange", () => ({
  exchangeApi: { transactions: vi.fn() }
}));

const response = {
  capabilities: { exchangeHistory: true },
  rows: [{
    id: "9007199254740999",
    capturedAt: "2026-08-21T01:12:00.000Z",
    eventKind: "update" as const,
    orderId: "9223372036854775000",
    sourceOrderId: "10",
    originalOrderId: "10",
    completionType: 4,
    units: "5",
    cumulativeUnits: "8",
    templateId: "SpiceResidue",
    displayName: "spice residue",
    category: "resources",
    icon: null,
    unitPrice: "100",
    qualityLevel: 2,
    durabilityCurrent: 0.75,
    durabilityMaximum: 1,
    ownerId: "100",
    ownerName: "Seller One",
    partyType: "player" as const,
    exchangeId: "77"
  }],
  totalCount: 1,
  summary: { events: 1, units: "5", solari: "500", firstCapturedAt: "2026-08-21T01:12:00.000Z" },
  retentionDays: 0
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(exchangeApi.transactions).mockResolvedValue(response);
});

describe("ExchangeTransactionsTab", () => {
  it("renders a readable summary and transaction without rounding bigint ids", async () => {
    render(<ExchangeTransactionsTab onError={vi.fn()} />);

    expect(await screen.findByText("Spice Residue")).toBeInTheDocument();
    expect(screen.getByText("Seller One")).toBeInTheDocument();
    expect(screen.getAllByText("500").length).toBeGreaterThan(0);
    expect(screen.getByText("77")).toBeInTheDocument();
    expect(screen.getByTitle(/Order 9223372036854775000/)).toBeInTheDocument();
  });

  it("applies period, party, item, and exchange filters", async () => {
    render(<ExchangeTransactionsTab onError={vi.fn()} />);
    await screen.findByText("Spice Residue");

    fireEvent.change(screen.getByLabelText("Search Transactions"), { target: { value: "spice" } });
    fireEvent.change(screen.getByLabelText("Transaction Period"), { target: { value: "720" } });
    fireEvent.change(screen.getByLabelText("Transaction Party"), { target: { value: "player" } });
    fireEvent.change(screen.getByLabelText("Exchange ID"), { target: { value: "77" } });
    fireEvent.click(screen.getByText("Apply"));

    await waitFor(() => expect(exchangeApi.transactions).toHaveBeenLastCalledWith(expect.objectContaining({
      q: "spice",
      hours: 720,
      party: "player",
      exchangeId: "77"
    })));
  });
});
