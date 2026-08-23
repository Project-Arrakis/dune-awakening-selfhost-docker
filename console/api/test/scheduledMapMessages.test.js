import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createScheduledMapMessageScheduler, nextScheduledRun } from "../src/services/scheduledMapMessages.js";

function fixture() {
  const generatedDir = mkdtempSync(join(tmpdir(), "dune-scheduled-map-messages-"));
  return {
    config: { generatedDir, repoRoot: generatedDir },
    file: join(generatedDir, "scheduled-map-messages.json"),
    cleanup: () => rmSync(generatedDir, { recursive: true, force: true })
  };
}

function draft(overrides = {}) {
  return {
    name: "Morning Report",
    enabled: true,
    mapName: "HaggaBasin",
    dimension: 0,
    message: "Dawn over Hagga Basin — the sands lie calm today.",
    frequency: "daily",
    daysOfWeek: [],
    time: "09:00",
    timezone: "UTC",
    ...overrides
  };
}

test("nextScheduledRun respects the selected timezone", () => {
  const next = nextScheduledRun(draft({ time: "09:00", timezone: "America/New_York" }), new Date("2026-08-23T12:30:00Z"));
  assert.equal(next, "2026-08-23T13:00:00.000Z");
});

test("weekly schedules only select configured weekdays", () => {
  const next = nextScheduledRun(draft({ frequency: "weekly", daysOfWeek: [1], time: "10:15" }), new Date("2026-08-23T12:30:00Z"));
  assert.equal(next, "2026-08-24T10:15:00.000Z");
});

test("schedules persist and manual delivery records the result", async (t) => {
  const { config, cleanup } = fixture();
  t.after(cleanup);
  const delivered = [];
  const scheduler = createScheduledMapMessageScheduler(config, {
    deliver: async (schedule) => { delivered.push(schedule.id); return { recipients: 3 }; }
  });
  const saved = scheduler.save(draft(), new Date("2026-08-23T08:00:00Z"));
  assert.equal(scheduler.list().schedules.length, 1);
  await scheduler.runNow(saved.id);
  const current = scheduler.list().schedules[0];
  assert.deepEqual(delivered, [saved.id]);
  assert.equal(current.lastStatus, "sent");
  assert.equal(current.lastRecipients, 3);
  assert.ok(current.lastDeliveredAt);
});

test("missed scheduled messages advance without being replayed", async (t) => {
  const { config, file, cleanup } = fixture();
  t.after(cleanup);
  let deliveries = 0;
  const scheduler = createScheduledMapMessageScheduler(config, {
    deliver: async () => { deliveries += 1; return { recipients: 1 }; }
  });
  scheduler.save(draft(), new Date("2026-08-23T08:00:00Z"));
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.schedules[0].nextRunAt = "2026-08-23T09:00:00.000Z";
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);

  await scheduler.tick(new Date("2026-08-23T09:10:00Z"));
  const current = scheduler.list().schedules[0];
  assert.equal(deliveries, 0);
  assert.equal(current.lastStatus, "missed");
  assert.equal(current.nextRunAt, "2026-08-24T09:00:00.000Z");
});

test("weekly schedules require at least one weekday", (t) => {
  const { config, cleanup } = fixture();
  t.after(cleanup);
  const scheduler = createScheduledMapMessageScheduler(config, { deliver: async () => ({ recipients: 0 }) });
  assert.throws(() => scheduler.save(draft({ frequency: "weekly", daysOfWeek: [] })), /Choose at least one weekday/);
});
