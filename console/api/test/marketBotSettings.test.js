import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSeedRun, executeUnseedRun } from "../src/addonSeedJob.js";
import { readSeedSchedule } from "../src/addonJobs.js";
import { actionForRoute } from "../src/actions.js";
import { marketBotStatus, saveMarketSeedSchedule } from "../src/services/exchangeMarket.js";
import {
  MARKET_BOT_DISABLE_BACKUPS_PHRASE,
  marketBotSafetyBackupsEnabled,
  marketBotSettingsPath,
  readMarketBotSettings,
  saveMarketBotSettings
} from "../src/services/marketBotSettings.js";

const SAMPLE_PLAN = {
  panel_version: "0.14.0-test",
  generated_at: "2026-08-01T00:00:00+00:00",
  price_multiplier: 5,
  rows: [
    { template_id: "WaterBottle", display_name: "Water Bottle", kind: "resource", stack_size: 10, price: 1000, category_mask: 1, category_depth: 1, quality_level: 0, listings: 4 }
  ]
};

function makeRepoRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-market-bot-settings-"));
  mkdirSync(join(repoRoot, "runtime/data"), { recursive: true });
  writeFileSync(join(repoRoot, "runtime/data/market-seed-plan.json"), JSON.stringify(SAMPLE_PLAN));
  return repoRoot;
}

function withRepo(fn) {
  return async () => {
    const repoRoot = makeRepoRoot();
    try {
      await fn({ repoRoot, mockMode: false });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  };
}

function writeRawSettings(config, text) {
  mkdirSync(join(config.repoRoot, "runtime/generated/market-bot"), { recursive: true });
  writeFileSync(marketBotSettingsPath(config), text);
}

function disableBackups(config) {
  saveMarketBotSettings(config, { safetyBackups: false, confirmation: MARKET_BOT_DISABLE_BACKUPS_PHRASE });
}

// Stubs for the run helpers: record backup origins, answer every SQL call.
function runDeps(backups, sqlRow) {
  return {
    runDuneImpl: async (_config, _args, options) => { backups.push(options?.env?.DB_BACKUP_ORIGIN); return { code: 0 }; },
    buildDuneArgs: (name) => [name],
    runSql: async (_db, sql) => (/bot_listings/.test(sql) ? { rows: [{ bot_listings: "3" }] } : { rows: [sqlRow] })
  };
}

const fakeDb = { query: async () => ({ rows: [] }), transaction: async (fn) => fn({ query: async () => ({ rows: [] }) }) };

test("safety backups default on when the settings file is missing, corrupt, or not an explicit false", withRepo((config) => {
  assert.deepEqual(readMarketBotSettings(config), { safetyBackups: true });
  writeRawSettings(config, "{not json");
  assert.equal(marketBotSafetyBackupsEnabled(config), true);
  writeRawSettings(config, JSON.stringify({ safetyBackups: "false" }));
  assert.equal(marketBotSafetyBackupsEnabled(config), true);
  writeRawSettings(config, JSON.stringify({ safetyBackups: false }));
  assert.equal(marketBotSafetyBackupsEnabled(config), false);
}));

test("disabling safety backups requires the confirmation phrase; re-enabling does not", withRepo((config) => {
  assert.throws(() => saveMarketBotSettings(config, { safetyBackups: false }), /Confirmation phrase required: DISABLE MARKET BOT BACKUPS/);
  assert.throws(() => saveMarketBotSettings(config, { safetyBackups: false, confirmation: "disable" }), /Confirmation phrase required/);
  assert.equal(marketBotSafetyBackupsEnabled(config), true, "a rejected save leaves backups on");

  disableBackups(config);
  assert.equal(marketBotSafetyBackupsEnabled(config), false);
  assert.deepEqual(JSON.parse(readFileSync(marketBotSettingsPath(config), "utf8")), { safetyBackups: false });

  assert.deepEqual(saveMarketBotSettings(config, { safetyBackups: true }), { safetyBackups: true });
  assert.equal(marketBotSafetyBackupsEnabled(config), true);
}));

test("settings saves reject non-boolean values and non-object payloads", withRepo((config) => {
  assert.throws(() => saveMarketBotSettings(config, { safetyBackups: "no" }), /true or false/);
  assert.throws(() => saveMarketBotSettings(config, []), /JSON object/);
  assert.equal(marketBotSafetyBackupsEnabled(config), true);
}));

test("the settings route requires market write permission", () => {
  assert.equal(actionForRoute("/api/exchange/market/settings", "POST"), "exchange:market-write");
});

test("market bot status reports the safety backup setting", withRepo(async (config) => {
  const db = { query: async () => ({ rows: [{ exists: true }] }) };
  assert.deepEqual((await marketBotStatus(config, db)).settings, { safetyBackups: true });
  disableBackups(config);
  assert.deepEqual((await marketBotStatus(config, db)).settings, { safetyBackups: false });
}));

test("reseed backs up by default and skips the backup when disabled", withRepo(async (config) => {
  saveMarketSeedSchedule(config, { exchangeId: "42" });
  const schedule = readSeedSchedule(config);
  const backups = [];
  const row = { listing_count: "4" };

  const first = await executeSeedRun(config, fakeDb, schedule, runDeps(backups, row));
  assert.deepEqual(backups, ["market-bot-seed"]);
  assert.equal(first.backupSkipped, false);
  assert.doesNotMatch(first.detail, /Safety backup skipped/);

  disableBackups(config);
  const second = await executeSeedRun(config, fakeDb, schedule, runDeps(backups, row));
  assert.deepEqual(backups, ["market-bot-seed"], "no second backup while disabled");
  assert.equal(second.status, "seeded", "the write still runs");
  assert.equal(second.backupSkipped, true);
  assert.match(second.detail, /Safety backup skipped: disabled in Market Bot settings\./);
}));

test("manual unseed backs up by default and skips the backup when disabled", withRepo(async (config) => {
  const backups = [];
  const row = { removed_listings: "3", removed_items: "3" };

  const first = await executeUnseedRun(config, fakeDb, "42", runDeps(backups, row));
  assert.deepEqual(backups, ["market-bot-unseed"]);
  assert.equal(first.backupSkipped, false);

  disableBackups(config);
  const second = await executeUnseedRun(config, fakeDb, "42", runDeps(backups, row));
  assert.deepEqual(backups, ["market-bot-unseed"], "no second backup while disabled");
  assert.equal(second.status, "unseeded");
  assert.equal(second.backupSkipped, true);
  assert.match(second.detail, /Safety backup skipped/);
}));
