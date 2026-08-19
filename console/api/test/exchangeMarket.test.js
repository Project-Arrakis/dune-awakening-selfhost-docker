import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EDA_EXCHANGE_BOT_ADDON_ID,
  createAddonJobScheduler,
  loadBuybackSeedPlan,
  readBuybackSchedule,
  resolveMarketSeedPlanPath,
  saveBuybackSchedule,
  readSeedSchedule
} from "../src/addonJobs.js";
import {
  listMarketExchanges,
  marketBotStatus,
  marketSeedPlanSummary,
  saveMarketBuybackSchedule,
  saveMarketSeedSchedule
} from "../src/services/exchangeMarket.js";

const SAMPLE_PLAN = {
  panel_version: "0.14.0-test",
  generated_at: "2026-08-01T00:00:00+00:00",
  price_multiplier: 5,
  rows: [
    { template_id: "WaterBottle", display_name: "Water Bottle", kind: "resource", stack_size: 10, price: 1000, category_mask: 1, category_depth: 1, quality_level: 0, listings: 4 },
    { template_id: "Sword", display_name: "Sword", kind: "equippable", stack_size: 1, price: 2000, category_mask: 2, category_depth: 2, quality_level: 0, listings: 2 }
  ]
};

function makeRepoRoot({ bundledPlan = SAMPLE_PLAN, addonPlan = null } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-exchange-market-"));
  if (bundledPlan) {
    mkdirSync(join(repoRoot, "runtime/data"), { recursive: true });
    writeFileSync(join(repoRoot, "runtime/data/market-seed-plan.json"), JSON.stringify(bundledPlan));
  }
  if (addonPlan) {
    const webDir = join(repoRoot, "runtime/addons/installed", EDA_EXCHANGE_BOT_ADDON_ID, "web");
    mkdirSync(webDir, { recursive: true });
    writeFileSync(join(webDir, "market-seed-plan.json"), JSON.stringify(addonPlan));
  }
  return repoRoot;
}

test("seed plan resolves to the bundled console copy when no addon is installed", () => {
  const repoRoot = makeRepoRoot();
  try {
    const config = { repoRoot };
    assert.match(resolveMarketSeedPlanPath(config), /runtime\/data\/market-seed-plan\.json$/);
    const plan = loadBuybackSeedPlan(config);
    assert.equal(plan.rows.length, 2);
    const summary = marketSeedPlanSummary(config);
    assert.deepEqual(
      [summary.available, summary.source, summary.rows, summary.panelVersion],
      [true, "bundled", 2, "0.14.0-test"]
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the bundled core plan wins over a stale installed addon copy", () => {
  const addonPlan = { ...SAMPLE_PLAN, panel_version: "0.15.0-addon", rows: [...SAMPLE_PLAN.rows, { template_id: "Extra", price: 100, quality_level: 0 }] };
  const repoRoot = makeRepoRoot({ addonPlan });
  try {
    const config = { repoRoot };
    assert.match(resolveMarketSeedPlanPath(config), /runtime\/data\/market-seed-plan\.json$/);
    assert.equal(marketSeedPlanSummary(config).source, "bundled");
    assert.equal(marketSeedPlanSummary(config).panelVersion, "0.14.0-test");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a missing plan reports unavailable and plan loading fails with a clear error", () => {
  const repoRoot = makeRepoRoot({ bundledPlan: null });
  try {
    const config = { repoRoot };
    assert.equal(resolveMarketSeedPlanPath(config), null);
    assert.equal(marketSeedPlanSummary(config).available, false);
    assert.throws(() => loadBuybackSeedPlan(config), /No market seed plan found/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("console saves mark schedules console-sourced; bridge saves flip them back; payloads cannot set source", () => {
  const repoRoot = makeRepoRoot();
  try {
    const config = { repoRoot };
    const saved = saveMarketBuybackSchedule(config, { enabled: true, exchangeId: "42" });
    assert.equal(saved.source, "console");
    assert.equal(readBuybackSchedule(config).source, "console");

    // A bridge payload trying to smuggle source stays addon-owned.
    const bridgeSaved = saveBuybackSchedule(config, { source: "console", buybackPercent: 55 }, { source: "addon" });
    assert.equal(bridgeSaved.source, "addon");
    assert.equal(bridgeSaved.buybackPercent, 55);

    // A payload-only save keeps the stored source rather than trusting input.
    const payloadOnly = saveBuybackSchedule(config, { source: "console", buybackPercent: 50 });
    assert.equal(payloadOnly.source, "addon");

    const seedSaved = saveMarketSeedSchedule(config, { enabled: true, exchangeId: "42" });
    assert.equal(seedSaved.source, "console");
    assert.equal(readSeedSchedule(config).source, "console");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

function fakeSweepDb({ eligible = "3" } = {}) {
  const db = {
    probes: [],
    sweeps: [],
    transactions: 0,
    query: async (sql) => {
      const text = String(sql).trim();
      if (/^WITH market_buy_plan/.test(text)) {
        db.probes.push(sql);
        return { rows: [{ eligible_orders: String(eligible) }], rowCount: 1, command: "SELECT" };
      }
      if (/^CREATE TEMP TABLE market_buy_plan/.test(text)) {
        db.sweeps.push(sql);
        return { rows: [{ purchased: "1", total_units: "10", total_solari: "500", threshold_percent: "60", max_buys: "500" }], rowCount: 1, command: "SELECT" };
      }
      return { rows: [], rowCount: 0, command: "SELECT" };
    },
    transaction: async (fn) => {
      db.transactions += 1;
      return fn({ query: db.query });
    }
  };
  return db;
}

test("scheduled runs skip addon permission checks for console-sourced schedules only", async () => {
  const repoRoot = makeRepoRoot();
  try {
    const config = { repoRoot, mockMode: true };
    const db = fakeSweepDb();
    const permissionChecks = [];
    const state = { clock: Date.parse("2026-08-12T00:00:00.000Z") };
    const scheduler = createAddonJobScheduler(config, {
      getDb: () => db,
      now: () => state.clock,
      runDuneImpl: async () => ({ code: 0 }),
      // Deny everything: an addon-sourced schedule must fail here, a
      // console-sourced one must never even ask.
      assertPermission: (_cfg, addonId, permission) => {
        permissionChecks.push(permission);
        throw new Error(`${addonId} is not approved for ${permission} permission.`);
      },
      auditImpl: () => {},
      log: { error: () => {} }
    });

    saveMarketBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 10 }, { now: () => state.clock });
    await scheduler.tick(); // arms
    state.clock += 10 * 60000;
    await scheduler.tick();
    assert.equal(db.sweeps.length, 1, "console-sourced schedule sweeps despite missing addon permissions");
    assert.deepEqual(permissionChecks, [], "console-sourced runs never consult addon permissions");
    assert.equal(readBuybackSchedule(config).lastRunStatus, "swept");

    // Same schedule re-marked addon-owned: the denied permission now blocks it.
    saveBuybackSchedule(config, {}, { source: "addon", now: () => state.clock });
    state.clock += 10 * 60000;
    await scheduler.tick();
    state.clock += 10 * 60000;
    await scheduler.tick();
    assert.equal(db.sweeps.length, 1, "addon-sourced schedule must not sweep without approved permissions");
    assert.ok(permissionChecks.length > 0, "addon-sourced runs re-verify addon permissions");
    assert.equal(readBuybackSchedule(config).lastRunStatus, "error");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

function fakeUnseedDb({ botListings = "12" } = {}) {
  const db = {
    counts: [],
    clears: [],
    transactions: 0,
    query: async (sql) => {
      const text = String(sql).trim();
      if (/AS bot_listings/.test(text)) {
        db.counts.push(text);
        return { rows: [{ bot_listings: String(botListings) }], rowCount: 1, command: "SELECT" };
      }
      if (/^CREATE TEMP TABLE market_unseed_result/.test(text)) {
        db.clears.push(text);
        return { rows: [{ removed_listings: String(botListings), removed_items: String(botListings), exchange_id: "42" }], rowCount: 1, command: "SELECT" };
      }
      return { rows: [], rowCount: 0, command: "SELECT" };
    },
    transaction: async (fn) => {
      db.transactions += 1;
      return fn({ query: db.query });
    }
  };
  return db;
}

function makeUnseedScheduler(config, db, { backups = [], audits = [] } = {}) {
  return createAddonJobScheduler(config, {
    getDb: () => db,
    runDuneImpl: async (_cfg, _args, options) => {
      backups.push(options?.env?.DB_BACKUP_ORIGIN);
      return { code: 0 };
    },
    auditImpl: (_cfg, _req, category, detail) => audits.push({ category, ...detail }),
    log: { error: () => {} }
  });
}

test("manual unseed backs up, clears the bot's listings in a transaction, and audits the run", async () => {
  const repoRoot = makeRepoRoot();
  try {
    const config = { repoRoot, mockMode: false };
    const db = fakeUnseedDb();
    const backups = [];
    const audits = [];
    const scheduler = makeUnseedScheduler(config, db, { backups, audits });

    const result = await scheduler.runNow({ trigger: "console", job: "unseed", exchangeId: "42" });
    assert.equal(result.status, "unseeded");
    assert.equal(result.removedListings, "12");
    assert.equal(result.exchangeId, "42");
    assert.deepEqual(backups, ["market-bot-unseed"]);
    assert.equal(db.counts.length, 1, "probes read-only before writing");
    assert.equal(db.transactions, 1, "the clear runs inside a transaction");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].job, "unseed");
    assert.equal(audits[0].status, "unseeded");
    assert.equal(audits[0].ok, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("manual unseed skips the backup and clear when the bot has no listings", async () => {
  const repoRoot = makeRepoRoot();
  try {
    const config = { repoRoot, mockMode: false };
    const db = fakeUnseedDb({ botListings: "0" });
    const backups = [];
    const scheduler = makeUnseedScheduler(config, db, { backups });

    const result = await scheduler.runNow({ trigger: "console", job: "unseed", exchangeId: "42" });
    assert.equal(result.status, "empty");
    assert.equal(result.removedListings, "0");
    assert.deepEqual(backups, [], "no backup without something to remove");
    assert.equal(db.transactions, 0, "no write transaction on an empty market");
    assert.equal(db.clears.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("manual unseed falls back to the saved seed exchange and rejects malformed ids", async () => {
  const repoRoot = makeRepoRoot();
  try {
    const config = { repoRoot, mockMode: false };
    const db = fakeUnseedDb();
    const scheduler = makeUnseedScheduler(config, db);

    // No requested exchange and no saved schedule: refuse to guess.
    await assert.rejects(scheduler.runNow({ job: "unseed" }), /Select an exchange/);
    // A malformed requested id is an error, never a silent fallback.
    saveMarketSeedSchedule(config, { exchangeId: "7" });
    await assert.rejects(scheduler.runNow({ job: "unseed", exchangeId: "abc" }), /positive whole number/);
    // An omitted id falls back to the saved seed schedule's exchange.
    const result = await scheduler.runNow({ job: "unseed" });
    assert.equal(result.exchangeId, "7");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

const EXCHANGE_ROWS = [
  { exchange_id: "9007199254740993", is_global: false, access_point_count: "0", order_count: "12", bot_order_count: "12", player_order_count: "0" },
  { exchange_id: "7", is_global: false, access_point_count: "2", order_count: "40", bot_order_count: "30", player_order_count: "10" },
  { exchange_id: "1", is_global: true, access_point_count: "1", order_count: "5", bot_order_count: "0", player_order_count: "5" }
];

function fakeExchangeDb(rows, { supported = true } = {}) {
  return {
    query: async (sql) => {
      if (/to_regclass/.test(sql)) return { rows: [{ exists: supported }] };
      return { rows };
    }
  };
}

test("market exchanges keep BIGINT ids as strings and sort access-pointed exchanges first", async () => {
  const result = await listMarketExchanges(fakeExchangeDb(EXCHANGE_ROWS));
  assert.equal(result.capabilities.exchangeMarket, true);
  assert.deepEqual(result.rows.map((row) => row.exchangeId), ["7", "1", "9007199254740993"]);
  const big = result.rows.find((row) => row.exchangeId === "9007199254740993");
  assert.equal(typeof big.exchangeId, "string", "ids above Number.MAX_SAFE_INTEGER stay strings");
  assert.equal(result.rows[1].isGlobal, true);
  assert.equal(result.rows[0].accessPoints, 2);
});

test("market status and exchange discovery report unsupported schemas without throwing", async () => {
  const repoRoot = makeRepoRoot();
  try {
    const config = { repoRoot };
    const db = fakeExchangeDb([], { supported: false });
    const status = await marketBotStatus(config, db);
    assert.equal(status.capabilities.exchangeMarket, false);
    assert.match(status.reason, /Missing required table/);
    assert.equal(status.plan.available, true, "plan info still reported so the UI can explain itself");
    const exchanges = await listMarketExchanges(db);
    assert.deepEqual(exchanges, { capabilities: { exchangeMarket: false }, rows: [] });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("market status carries both schedules with their sources", async () => {
  const repoRoot = makeRepoRoot();
  try {
    const config = { repoRoot };
    saveMarketBuybackSchedule(config, { enabled: true, exchangeId: "42", buybackPercent: 65 });
    saveMarketSeedSchedule(config, { exchangeId: "42", priceMultiplier: 7 });
    const status = await marketBotStatus(config, fakeExchangeDb(EXCHANGE_ROWS));
    assert.equal(status.capabilities.exchangeMarket, true);
    assert.equal(status.buyback.enabled, true);
    assert.equal(status.buyback.buybackPercent, 65);
    assert.equal(status.buyback.source, "console");
    assert.equal(status.seed.priceMultiplier, 7);
    assert.equal(status.seed.source, "console");
    assert.deepEqual(status.seed.commodityStacks, {});
    assert.ok(Array.isArray(status.commodityStackCatalog));
    assert.ok(status.commodityStackCatalog.some((item) => item.templateId === "Oil"));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
