import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { marketBotApi, type MarketBotStatus } from "../../api/marketBot";
import { MarketBotOverlay } from "./MarketBotOverlay";

vi.mock("../../api/marketBot", () => ({
  marketBotApi: {
    status: vi.fn(),
    exchanges: vi.fn(),
    probeBuyback: vi.fn(),
    saveBuybackSchedule: vi.fn(),
    saveSeedSchedule: vi.fn(),
    runBuyback: vi.fn(),
    runSeed: vi.fn()
  }
}));

function statusFixture(overrides: Partial<MarketBotStatus> = {}): MarketBotStatus {
  return {
    capabilities: { exchangeMarket: true },
    plan: { available: true, source: "bundled", rows: 2910, panelVersion: "0.14.0", generatedAt: "2026-08-01T00:00:00+00:00" },
    buyback: {
      enabled: false, intervalMinutes: 30, exchangeId: "42", priceMultiplier: 5,
      augmentMultiplier: 1, rankedArmorMultiplier: 1, rankedWeaponMultiplier: 1,
      buybackPercent: 60, buybackPriceBasis: "seeded", maxBuys: 500, source: "console",
      lastRunAt: "", lastRunStatus: "", lastRunDetail: "", nextRunAt: ""
    },
    seed: {
      enabled: false, intervalMinutes: 15, exchangeId: "", priceMultiplier: 5,
      augmentMultiplier: 1, rankedArmorMultiplier: 1, rankedWeaponMultiplier: 1,
      augmentPricing: "discounted", source: "console",
      lastRunAt: "", lastRunStatus: "", lastRunDetail: "", nextRunAt: ""
    },
    ...overrides
  };
}

const EXCHANGES = {
  capabilities: { exchangeMarket: true },
  rows: [
    { exchangeId: "42", isGlobal: false, accessPoints: 2, orderCount: 40, botOrders: 30, playerOrders: 10 },
    { exchangeId: "9007199254740993", isGlobal: true, accessPoints: 1, orderCount: 5, botOrders: 0, playerOrders: 5 }
  ]
};

function renderOverlay() {
  const props = { onClose: vi.fn(), onError: vi.fn(), confirmAction: vi.fn().mockResolvedValue(true) };
  render(<MarketBotOverlay {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(marketBotApi.status).mockResolvedValue(statusFixture());
  vi.mocked(marketBotApi.exchanges).mockResolvedValue(EXCHANGES);
});

describe("MarketBotOverlay", () => {
  it("loads status and exchanges, showing plan info and both sections", async () => {
    renderOverlay();

    expect(await screen.findByText(/Seed plan: 2,910 rows \(v0\.14\.0\) from the bundled console copy/)).toBeInTheDocument();
    expect(screen.getByText("Buyback sweeps")).toBeInTheDocument();
    expect(screen.getByText("Market reseed")).toBeInTheDocument();
    // BIGINT-sized ids stay intact as strings in the selector.
    expect(screen.getByText(/Global \(ID 9007199254740993\)/)).toBeInTheDocument();
  });

  it("populates the form from the saved buyback schedule and saves edits with the selected exchange", async () => {
    vi.mocked(marketBotApi.status).mockResolvedValue(statusFixture({
      buyback: { ...statusFixture().buyback, buybackPercent: 65, maxBuys: 250 }
    }));
    vi.mocked(marketBotApi.saveBuybackSchedule).mockImplementation(async (schedule) => ({
      ...statusFixture().buyback, ...schedule, exchangeId: String(schedule.exchangeId || "42"), enabled: Boolean(schedule.enabled)
    }));
    renderOverlay();

    const percent = await screen.findByLabelText("Buyback percent");
    expect(percent).toHaveValue(65);
    fireEvent.change(percent, { target: { value: "70" } });
    fireEvent.change(screen.getByLabelText("Buyback price basis"), { target: { value: "lowest" } });
    fireEvent.click(screen.getByLabelText("Run buyback on a schedule"));
    fireEvent.click(screen.getByRole("button", { name: "Save buyback schedule" }));

    await waitFor(() => expect(marketBotApi.saveBuybackSchedule).toHaveBeenCalledWith({
      enabled: true,
      intervalMinutes: 30,
      priceMultiplier: 5,
      augmentMultiplier: 1,
      rankedArmorMultiplier: 1,
      rankedWeaponMultiplier: 1,
      buybackPercent: 70,
      buybackPriceBasis: "lowest",
      maxBuys: 250,
      exchangeId: "42"
    }));
    expect(await screen.findByText(/Buyback schedule saved: every 30 min on exchange 42/)).toBeInTheDocument();
  });

  it("probes eligibility read-only and reports the count", async () => {
    vi.mocked(marketBotApi.probeBuyback).mockResolvedValue({
      eligible: 7, exchangeId: "42", priceMultiplier: 5,
      augmentMultiplier: 1, rankedArmorMultiplier: 2, rankedWeaponMultiplier: 1,
      buybackPercent: 60, maxBuys: 500
    });
    renderOverlay();

    const armorMultiplier = await screen.findByLabelText("Buyback ranked armor multiplier");
    expect(armorMultiplier).toHaveValue(1);
    fireEvent.change(armorMultiplier, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Probe eligibility" }));

    await waitFor(() => expect(marketBotApi.probeBuyback).toHaveBeenCalledWith({
      exchangeId: "42", priceMultiplier: 5,
      augmentMultiplier: 1, rankedArmorMultiplier: 2, rankedWeaponMultiplier: 1,
      buybackPercent: 60, maxBuys: 500
    }));
    expect(await screen.findByText(/7 eligible player listing\(s\) on exchange 42 at 60%/)).toBeInTheDocument();
  });

  it("confirms before running a sweep and reports the result", async () => {
    vi.mocked(marketBotApi.runBuyback).mockResolvedValue({ status: "swept", purchased: 3, totalUnits: "120", totalSolari: "9000" });
    const props = renderOverlay();

    fireEvent.click(await screen.findByRole("button", { name: "Run sweep now" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalled());
    await waitFor(() => expect(marketBotApi.runBuyback).toHaveBeenCalled());
    expect(await screen.findByText(/bought 3 listing\(s\), 120 units for 9000 Solari/)).toBeInTheDocument();
  });

  it("does not run a sweep when the confirmation is declined", async () => {
    const props = renderOverlay();
    props.confirmAction.mockResolvedValue(false);

    fireEvent.click(await screen.findByRole("button", { name: "Run sweep now" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalled());
    expect(marketBotApi.runBuyback).not.toHaveBeenCalled();
  });

  it("saves the seed schedule with the chosen augment pricing", async () => {
    vi.mocked(marketBotApi.saveSeedSchedule).mockImplementation(async (schedule) => ({
      ...statusFixture().seed, ...schedule, exchangeId: String(schedule.exchangeId || "42"), enabled: Boolean(schedule.enabled)
    }));
    renderOverlay();

    const pricing = await screen.findByLabelText("Augment pricing");
    expect(pricing).toHaveValue("discounted");
    fireEvent.change(pricing, { target: { value: "original" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reseed schedule" }));

    await waitFor(() => expect(marketBotApi.saveSeedSchedule).toHaveBeenCalledWith({
      enabled: false,
      intervalMinutes: 15,
      priceMultiplier: 5,
      augmentMultiplier: 1,
      rankedArmorMultiplier: 1,
      rankedWeaponMultiplier: 1,
      augmentPricing: "original",
      exchangeId: "42"
    }));
    expect(await screen.findByText(/Reseed schedule saved \(disabled\)\./)).toBeInTheDocument();
  });

  it("populates saved category multipliers and saves edited ones with the reseed schedule", async () => {
    vi.mocked(marketBotApi.status).mockResolvedValue(statusFixture({
      seed: { ...statusFixture().seed, augmentMultiplier: 2 }
    }));
    vi.mocked(marketBotApi.saveSeedSchedule).mockImplementation(async (schedule) => ({
      ...statusFixture().seed, ...schedule, exchangeId: String(schedule.exchangeId || "42"), enabled: Boolean(schedule.enabled)
    }));
    renderOverlay();

    const augment = await screen.findByLabelText("Seed augment multiplier");
    expect(augment).toHaveValue(2);
    fireEvent.change(augment, { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Seed ranked armor multiplier"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Seed ranked weapon multiplier"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reseed schedule" }));

    await waitFor(() => expect(marketBotApi.saveSeedSchedule).toHaveBeenCalledWith({
      enabled: false,
      intervalMinutes: 15,
      priceMultiplier: 5,
      augmentMultiplier: 2.5,
      rankedArmorMultiplier: 3,
      rankedWeaponMultiplier: 1.5,
      augmentPricing: "discounted",
      exchangeId: "42"
    }));
  });

  it("disables Run reseed now until a seed schedule has a saved exchange", async () => {
    renderOverlay();

    const runSeed = await screen.findByRole("button", { name: "Run reseed now" });
    expect(runSeed).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Run sweep now" })).toBeEnabled();
  });

  it("explains an unsupported schema instead of rendering controls", async () => {
    vi.mocked(marketBotApi.status).mockResolvedValue(statusFixture({
      capabilities: { exchangeMarket: false },
      reason: "Unsupported by detected schema. Missing required table(s): dune.dune_exchange_orders"
    }));
    renderOverlay();

    expect(await screen.findByText(/Missing required table/)).toBeInTheDocument();
    expect(screen.queryByText("Buyback sweeps")).not.toBeInTheDocument();
  });

  it("explains a missing seed plan", async () => {
    vi.mocked(marketBotApi.status).mockResolvedValue(statusFixture({
      plan: { available: false, source: null, rows: 0, panelVersion: "", generatedAt: "" }
    }));
    renderOverlay();

    expect(await screen.findByText(/No market seed plan is available/)).toBeInTheDocument();
    expect(screen.queryByText("Buyback sweeps")).not.toBeInTheDocument();
  });
});
