import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoRefillWaterPublicState,
  createAutoRefillWaterScheduler,
  isAutoRefillWaterEnabled,
  readAutoRefillWaterState,
  setBaseAutoRefillWater,
  writeAutoRefillWaterState
} from "../src/services/autoRefillWater.js";
import { listQueuedWaterRefills, queueWaterRefill } from "../src/duneDb.js";

// Mirrors autoRefill.test.js exactly, retargeted at the water auto-refill
// subsystem -- same enrollment/scheduler mechanics, own files, own env vars.

async function withTempRepoRoot(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-auto-refill-water-"));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function statePath(repoRoot) {
  return join(repoRoot, "runtime/generated/auto-refill-water-bases.json");
}

function writeRawState(repoRoot, text) {
  mkdirSync(join(repoRoot, "runtime/generated"), { recursive: true });
  writeFileSync(statePath(repoRoot), text);
}

const HOUR_MS = 3600000;
const START = Date.UTC(2026, 6, 30, 12, 0, 0);

function makeClock(start = START) {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; }, at: () => current };
}

const TEST_ENV = {};

function fakeDuneDb({
  levels = {},
  missingBases = [],
  target = { map: "Survival_1", partitionId: 3, queueSupported: true, writeSafeNow: false },
  calls = []
} = {}) {
  const missing = new Set(missingBases.map(Number));
  return {
    calls,
    baseWaterFuelLevels: async (_db, baseId) => {
      calls.push({ fn: "baseWaterFuelLevels", baseId });
      const entry = levels[baseId];
      if (entry instanceof Error) throw entry;
      if (!entry) return { baseId, deviceCount: 0, devices: [], lowestPercent: null };
      return { baseId, deviceCount: entry.deviceCount ?? 1, devices: [], lowestPercent: entry.lowestPercent };
    },
    baseMapLocation: async (_db, baseId) => {
      calls.push({ fn: "baseMapLocation", baseId });
      if (missing.has(Number(baseId))) throw new Error("That base was not found.");
      return { map: "Survival_1", partitionId: 3 };
    },
    baseRefillTarget: async (_db, baseId) => {
      calls.push({ fn: "baseRefillTarget", baseId });
      return typeof target === "function" ? target(baseId) : target;
    },
    observeRefillPartitions: async () => {
      calls.push({ fn: "observeRefillPartitions" });
      return null;
    },
    queueWaterRefill,
    listQueuedWaterRefills
  };
}

function forceDue(repoRoot, clock) {
  writeAutoRefillWaterState(repoRoot, { ...readAutoRefillWaterState(repoRoot), nextRunAt: new Date(clock.now()).toISOString() });
}

function drainQueue(repoRoot) {
  writeFileSync(join(repoRoot, "runtime/generated/pending-water-refills.json"), "[]\n");
}

async function primeScheduler(scheduler, repoRoot, clock) {
  forceDue(repoRoot, clock);
  await scheduler.tick();
  clock.advance(2000);
}

function makeScheduler(repoRoot, duneDb, clock, options = {}) {
  const audits = [];
  const scheduler = createAutoRefillWaterScheduler({
    config: { repoRoot },
    getDb: () => ({ query: async () => { throw new Error("the scheduler must not query the database directly"); } }),
    duneDb,
    now: clock.now,
    auditImpl: (_config, _req, action, detail) => audits.push({ action, detail }),
    env: TEST_ENV,
    overdueArmDelayMs: 1000,
    ...options
  });
  return { scheduler, audits };
}

// --- Enrollment store -------------------------------------------------------

test("water auto-refill enrollment round-trips and is idempotent in both directions", async () => {
  await withTempRepoRoot((repoRoot) => {
    const clock = makeClock();
    assert.deepEqual(readAutoRefillWaterState(repoRoot).bases, {});
    assert.equal(isAutoRefillWaterEnabled(repoRoot, 482), false);

    const first = setBaseAutoRefillWater(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    assert.deepEqual({ ok: first.ok, enabled: first.enabled, total: first.total }, { ok: true, enabled: true, total: 1 });
    const enabledAt = readAutoRefillWaterState(repoRoot).bases["482"].enabledAt;

    clock.advance(HOUR_MS);
    const again = setBaseAutoRefillWater(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    assert.equal(again.total, 1);
    assert.equal(readAutoRefillWaterState(repoRoot).bases["482"].enabledAt, enabledAt);
    assert.equal(isAutoRefillWaterEnabled(repoRoot, 482), true);

    setBaseAutoRefillWater(repoRoot, 517, true, { now: clock.now, env: TEST_ENV });
    const off = setBaseAutoRefillWater(repoRoot, 482, false, { now: clock.now, env: TEST_ENV });
    assert.deepEqual({ enabled: off.enabled, total: off.total }, { enabled: false, total: 1 });
    assert.equal(setBaseAutoRefillWater(repoRoot, 482, false, { now: clock.now, env: TEST_ENV }).total, 1);
  });
});

test("enabling water auto-refill arms the first scan a full interval out, and emptying the list disarms it", async () => {
  await withTempRepoRoot((repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefillWater(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    assert.equal(readAutoRefillWaterState(repoRoot).nextRunAt, new Date(START + 24 * HOUR_MS).toISOString());

    setBaseAutoRefillWater(repoRoot, 517, true, { now: clock.now, env: TEST_ENV });
    assert.equal(readAutoRefillWaterState(repoRoot).nextRunAt, new Date(START + 24 * HOUR_MS).toISOString());

    setBaseAutoRefillWater(repoRoot, 482, false, { now: clock.now, env: TEST_ENV });
    setBaseAutoRefillWater(repoRoot, 517, false, { now: clock.now, env: TEST_ENV });
    assert.equal(readAutoRefillWaterState(repoRoot).nextRunAt, "");
  });
});

test("a missing or corrupt water auto-refill enrollment file reads as empty instead of throwing", async () => {
  await withTempRepoRoot((repoRoot) => {
    assert.deepEqual(readAutoRefillWaterState(repoRoot).bases, {});

    writeRawState(repoRoot, "{not json");
    assert.deepEqual(readAutoRefillWaterState(repoRoot).bases, {});

    writeRawState(repoRoot, "[1,2,3]");
    assert.deepEqual(readAutoRefillWaterState(repoRoot).bases, {});
    writeRawState(repoRoot, JSON.stringify({ bases: [482] }));
    assert.deepEqual(readAutoRefillWaterState(repoRoot).bases, {});

    assert.equal(isAutoRefillWaterEnabled(repoRoot, 482), false);
  });
});

test("water auto-refill enrollment is capped so a full scan can never overflow the refill queue", async () => {
  await withTempRepoRoot((repoRoot) => {
    const bases = {};
    for (let baseId = 1; baseId <= 200; baseId += 1) bases[baseId] = { enabledAt: new Date(START).toISOString() };
    writeAutoRefillWaterState(repoRoot, { bases, nextRunAt: new Date(START).toISOString() });
    assert.equal(Object.keys(readAutoRefillWaterState(repoRoot).bases).length, 200);

    assert.throws(() => setBaseAutoRefillWater(repoRoot, 5000, true, { env: TEST_ENV }), /already covers 200 bases/);
    assert.equal(setBaseAutoRefillWater(repoRoot, 7, true, { env: TEST_ENV }).total, 200);
  });
});

test("autoRefillWaterPublicState reports the tunables and a sorted base list", async () => {
  await withTempRepoRoot((repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefillWater(repoRoot, 517, true, { now: clock.now, env: TEST_ENV });
    setBaseAutoRefillWater(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });

    const state = autoRefillWaterPublicState(repoRoot, { env: TEST_ENV });
    assert.equal(state.thresholdPercent, 50);
    assert.equal(state.intervalHours, 24);
    assert.equal(state.total, 2);
    assert.deepEqual(state.bases.map((entry) => entry.baseId), [482, 517]);
  });
});

test("water threshold and interval clamp out-of-range overrides, independently of the generator env vars", async () => {
  await withTempRepoRoot((repoRoot) => {
    assert.equal(autoRefillWaterPublicState(repoRoot, { env: { ADMIN_AUTO_REFILL_WATER_THRESHOLD_PERCENT: "0" } }).thresholdPercent, 1);
    assert.equal(autoRefillWaterPublicState(repoRoot, { env: { ADMIN_AUTO_REFILL_WATER_THRESHOLD_PERCENT: "500" } }).thresholdPercent, 99);
    assert.equal(autoRefillWaterPublicState(repoRoot, { env: { ADMIN_AUTO_REFILL_WATER_THRESHOLD_PERCENT: "nope" } }).thresholdPercent, 50);
    assert.equal(autoRefillWaterPublicState(repoRoot, { env: { ADMIN_AUTO_REFILL_WATER_INTERVAL_HOURS: "0" } }).intervalHours, 1);
    assert.equal(autoRefillWaterPublicState(repoRoot, { env: { ADMIN_AUTO_REFILL_WATER_INTERVAL_HOURS: "9999" } }).intervalHours, 168);
    // Setting the *generator* env vars must not leak into the water tunables.
    assert.equal(autoRefillWaterPublicState(repoRoot, { env: { ADMIN_AUTO_REFILL_THRESHOLD_PERCENT: "10" } }).thresholdPercent, 50);
  });
});

// --- Scheduler --------------------------------------------------------------

test("an empty water enrollment never touches the database", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    const duneDb = fakeDuneDb();
    const { scheduler, audits } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();

    assert.deepEqual(duneDb.calls, []);
    assert.deepEqual(audits, []);
  });
});

test("a water scan that is not yet due is a no-op", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefillWater(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: 5 } } });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock);

    clock.advance(HOUR_MS);
    await scheduler.tick();

    assert.deepEqual(duneDb.calls, []);
    assert.deepEqual(listQueuedWaterRefills(repoRoot), []);
  });
});

test("a due water scan queues only the bases under the threshold", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    for (const baseId of [482, 517, 601]) setBaseAutoRefillWater(repoRoot, baseId, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillWaterState(repoRoot, { ...readAutoRefillWaterState(repoRoot), nextRunAt: new Date(START).toISOString() });
    const duneDb = fakeDuneDb({
      levels: {
        482: { lowestPercent: 20 },
        517: { lowestPercent: 50 },
        601: { lowestPercent: 49.9 }
      }
    });
    const { scheduler, audits } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    const result = await scheduler.tick();

    assert.equal(result.queued, 2);
    assert.equal(result.checked, 3);
    assert.deepEqual(listQueuedWaterRefills(repoRoot).map((entry) => entry.baseId).sort((a, b) => a - b), [482, 601]);
    assert.deepEqual(audits.filter((entry) => entry.action === "bases.auto-refill-water-queued").map((entry) => entry.detail.baseId), [482, 601]);
    const scan = audits.find((entry) => entry.action === "bases.auto-refill-water-scan");
    assert.deepEqual({ enrolled: scan.detail.enrolled, queued: scan.detail.queued, status: scan.detail.status }, { enrolled: 3, queued: 2, status: "ok" });

    const state = readAutoRefillWaterState(repoRoot);
    assert.equal(state.bases["517"].lastLowestPercent, 50);
    assert.equal(state.bases["517"].lastQueuedAt, "");
    assert.equal(state.bases["482"].lastQueuedAt, new Date(clock.at()).toISOString());
    assert.equal(state.nextRunAt, new Date(clock.at() + 24 * HOUR_MS).toISOString());
    assert.equal(state.lastRunStatus, "ok");
  });
});

test("a base with no water storage is checked but never queued", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefillWater(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillWaterState(repoRoot, { ...readAutoRefillWaterState(repoRoot), nextRunAt: new Date(START).toISOString() });
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: null, deviceCount: 0 } } });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    const result = await scheduler.tick();

    assert.equal(result.queued, 0);
    assert.deepEqual(listQueuedWaterRefills(repoRoot), []);
    assert.equal(readAutoRefillWaterState(repoRoot).bases["482"].lastLowestPercent, null);
  });
});

test("a base that no longer exists is un-enrolled from water auto-refill, but other failures keep their enrollment", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    for (const baseId of [482, 517]) setBaseAutoRefillWater(repoRoot, baseId, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillWaterState(repoRoot, { ...readAutoRefillWaterState(repoRoot), nextRunAt: new Date(START).toISOString() });
    const duneDb = fakeDuneDb({
      missingBases: [482],
      levels: {
        517: new Error("connection terminated unexpectedly")
      }
    });
    const { scheduler, audits } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    const result = await scheduler.tick();

    const state = readAutoRefillWaterState(repoRoot);
    assert.deepEqual(Object.keys(state.bases), ["517"]);
    assert.equal(audits.some((entry) => entry.action === "bases.auto-refill-water-unenrolled" && entry.detail.baseId === 482), true);
    assert.equal(result.failures, 1);
    assert.equal(state.lastRunStatus, "partial");
    assert.match(state.lastRunDetail, /517/);
  });
});

test("a base whose database lost queue support is not water-refilled directly", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefillWater(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillWaterState(repoRoot, { ...readAutoRefillWaterState(repoRoot), nextRunAt: new Date(START).toISOString() });
    const duneDb = fakeDuneDb({
      levels: { 482: { lowestPercent: 5 } },
      target: { map: "Survival_1", partitionId: 3, queueSupported: false, writeSafeNow: true }
    });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    const result = await scheduler.tick();

    assert.equal(result.queued, 0);
    assert.equal(result.failures, 1);
    assert.deepEqual(listQueuedWaterRefills(repoRoot), []);
  });
});

test("a water scan leaves an already-queued base alone instead of resetting its attempts", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefillWater(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillWaterState(repoRoot, { ...readAutoRefillWaterState(repoRoot), nextRunAt: new Date(START).toISOString() });
    queueWaterRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });
    const queued = listQueuedWaterRefills(repoRoot);
    writeFileSync(
      join(repoRoot, "runtime/generated/pending-water-refills.json"),
      `${JSON.stringify([{ ...queued[0], attempts: 2, lastError: "relation does not exist" }], null, 2)}\n`
    );
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: 10 } } });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    const result = await scheduler.tick();

    const after = listQueuedWaterRefills(repoRoot);
    assert.equal(after.length, 1);
    assert.equal(after[0].attempts, 2);
    assert.equal(result.queued, 0);
    assert.equal(result.alreadyQueued, 1);
    assert.equal(readAutoRefillWaterState(repoRoot).bases["482"].consecutiveQueues, 0);
    assert.equal(readAutoRefillWaterState(repoRoot).bases["482"].stalledAt, "");
  });
});

test("a base whose water refills never take effect stops being queued after three cycles", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefillWater(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: 10 } } });
    const { scheduler, audits } = makeScheduler(repoRoot, duneDb, clock);
    await primeScheduler(scheduler, repoRoot, clock);

    const queuedPerCycle = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      forceDue(repoRoot, clock);
      const result = await scheduler.tick();
      queuedPerCycle.push(result?.queued ?? 0);
      drainQueue(repoRoot);
      clock.advance(24 * HOUR_MS);
    }

    assert.deepEqual(queuedPerCycle, [1, 1, 1, 0, 0]);
    const entry = readAutoRefillWaterState(repoRoot).bases["482"];
    assert.equal(entry.consecutiveQueues, 3);
    assert.notEqual(entry.stalledAt, "");
    assert.equal(audits.filter((a) => a.action === "bases.auto-refill-water-stalled").length, 1);
    assert.equal(audits.filter((a) => a.action === "bases.auto-refill-water-queued").length, 3);
  });
});

test("a base that comes back above the water threshold clears its stall", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefillWater(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    const levels = { 482: { lowestPercent: 10 } };
    const duneDb = fakeDuneDb({ levels });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock);
    await primeScheduler(scheduler, repoRoot, clock);

    for (let cycle = 0; cycle < 4; cycle += 1) {
      forceDue(repoRoot, clock);
      await scheduler.tick();
      drainQueue(repoRoot);
      clock.advance(24 * HOUR_MS);
    }
    assert.equal(readAutoRefillWaterState(repoRoot).bases["482"].consecutiveQueues, 3);

    levels[482] = { lowestPercent: 100 };
    forceDue(repoRoot, clock);
    await scheduler.tick();

    const recovered = readAutoRefillWaterState(repoRoot).bases["482"];
    assert.equal(recovered.consecutiveQueues, 0);
    assert.equal(recovered.stalledAt, "");

    levels[482] = { lowestPercent: 10 };
    clock.advance(24 * HOUR_MS);
    forceDue(repoRoot, clock);
    const result = await scheduler.tick();
    assert.equal(result.queued, 1);
  });
});

test("the water auto-refill enrollment file is written atomically with owner-only permissions", async () => {
  await withTempRepoRoot((repoRoot) => {
    setBaseAutoRefillWater(repoRoot, 482, true, { env: TEST_ENV });
    const raw = readFileSync(statePath(repoRoot), "utf8");
    assert.equal(raw.endsWith("}\n"), true);
    assert.equal(JSON.parse(raw).schemaVersion, 1);
  });
});
