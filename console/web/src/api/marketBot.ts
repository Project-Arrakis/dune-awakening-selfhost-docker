import { api, post } from "./client";

// First-class Market Bot (console-managed NPC market seeding and buyback).
// Exchange ids are PostgreSQL BIGINTs that can exceed Number.MAX_SAFE_INTEGER,
// so they travel as decimal strings end-to-end.

export type MarketPriceBasis = "seeded" | "average" | "lowest";

// How the seed run prices standalone augment items (always listed as
// bottom-of-range rolls): "discounted" undercuts their schematics at half
// price, "original" keeps the seed plan's own augment item prices.
export type MarketAugmentPricing = "discounted" | "original";

export type MarketBuybackSchedule = {
  enabled: boolean;
  intervalMinutes: number;
  exchangeId: string;
  priceMultiplier: number;
  buybackPercent: number;
  buybackPriceBasis: MarketPriceBasis;
  maxBuys: number;
  source: "addon" | "console";
  lastRunAt: string;
  lastRunStatus: string;
  lastRunDetail: string;
  nextRunAt: string;
};

export type MarketSeedSchedule = {
  enabled: boolean;
  intervalMinutes: number;
  exchangeId: string;
  priceMultiplier: number;
  augmentPricing: MarketAugmentPricing;
  source: "addon" | "console";
  lastRunAt: string;
  lastRunStatus: string;
  lastRunDetail: string;
  nextRunAt: string;
};

export type MarketBotStatus = {
  capabilities: { exchangeMarket?: boolean } & Record<string, unknown>;
  plan: { available: boolean; source: "addon" | "bundled" | null; rows: number; panelVersion: string; generatedAt: string };
  buyback: MarketBuybackSchedule;
  seed: MarketSeedSchedule;
  reason?: string;
};

export type MarketExchange = {
  exchangeId: string;
  isGlobal: boolean;
  accessPoints: number;
  orderCount: number;
  botOrders: number;
  playerOrders: number;
};

export type MarketProbeResult = {
  eligible: number;
  exchangeId: string;
  priceMultiplier: number;
  buybackPercent: number;
  maxBuys: number;
};

export type MarketRunResult = {
  status: string;
  detail?: string;
  exchangeId?: string;
  // buyback run
  eligible?: number;
  purchased?: number;
  totalUnits?: string;
  totalSolari?: string;
  // seed run
  listingCount?: string;
  schedule?: MarketBuybackSchedule | MarketSeedSchedule;
};

export const marketBotApi = {
  status: () => api<MarketBotStatus>("/api/exchange/market"),
  exchanges: () => api<{ rows: MarketExchange[]; capabilities: { exchangeMarket?: boolean } }>("/api/exchange/market/exchanges"),
  probeBuyback: (overrides: Partial<{ exchangeId: string; priceMultiplier: number; buybackPercent: number; maxBuys: number }> = {}) =>
    post<MarketProbeResult>("/api/exchange/market/buyback/probe", overrides),
  saveBuybackSchedule: (schedule: Partial<MarketBuybackSchedule>) => post<MarketBuybackSchedule>("/api/exchange/market/buyback/schedule", schedule),
  saveSeedSchedule: (schedule: Partial<MarketSeedSchedule>) => post<MarketSeedSchedule>("/api/exchange/market/seed/schedule", schedule),
  runBuyback: () => post<MarketRunResult>("/api/exchange/market/buyback/run", {}),
  runSeed: () => post<MarketRunResult>("/api/exchange/market/seed/run", {})
};
