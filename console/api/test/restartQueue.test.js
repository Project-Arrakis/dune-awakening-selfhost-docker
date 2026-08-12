import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeSettings,
  readSettings,
  saveSettings,
  defaultSettings,
  readState,
  writeState,
  classifyRestart,
  canQueue,
  appendEntry,
  removeEntry,
  markEntryRestarting,
  recordCheckpointSent,
  expediteEntry,
  checkpointsDue,
  buildWarning,
  recover,
  isRestartOperation,
  publicState
} from "../src/services/restartQueue.js";

function config() {
  const root = mkdtempSync(join(tmpdir(), "dune-restart-queue-test-"));
  return { repoRoot: root, generatedDir: join(root, "runtime", "generated"), mockMode: true };
}

test("defaults are disabled with the documented countdown and checkpoints", () => {
  const settings = readSettings(config());
  assert.equal(settings.enabled, false);
  assert.equal(settings.defaultCountdownMinutes, 15);
  assert.deepEqual(settings.broadcastCheckpoints, [15, 10, 5, 1]);
  assert.equal(settings.broadcastDurationSec, 30);
  assert.equal(settings.recoveryGraceMinutes, 5);
});

test("normalizeSettings coerces enabled, clamps numbers, and parses checkpoint strings", () => {
  const a = normalizeSettings({ enabled: "yes", defaultCountdownMinutes: 0, broadcastDurationSec: 99999 });
  assert.equal(a.enabled, false); // only strict true enables
  assert.equal(a.defaultCountdownMinutes, 1); // clamped up from 0
  assert.equal(a.broadcastDurationSec, 3600); // clamped down

  const b = normalizeSettings({ enabled: true, broadcastCheckpoints: "20, 10, 10, 3, x, 2" });
  assert.equal(b.enabled, true);
  assert.deepEqual(b.broadcastCheckpoints, [20, 10, 3, 2]); // de-duped, sorted desc, garbage dropped

  const c = normalizeSettings({ broadcastCheckpoints: [] });
  assert.deepEqual(c.broadcastCheckpoints, [15, 10, 5, 1]); // empty falls back to default
});

test("settings persist to restart-queue.json and read back", () => {
  const cfg = config();
  const result = saveSettings(cfg, { enabled: true, defaultCountdownMinutes: 20, broadcastCheckpoints: [30, 5] });
  assert.equal(result.settings.enabled, true);
  assert.equal(result.settings.defaultCountdownMinutes, 20);
  const onDisk = JSON.parse(readFileSync(join(cfg.generatedDir, "restart-queue.json"), "utf8"));
  assert.equal(onDisk.enabled, true);
  assert.deepEqual(readSettings(cfg).broadcastCheckpoints, [30, 5]);
  assert.deepEqual(defaultSettings().broadcastCheckpoints, [15, 10, 5, 1]);
});

test("classifyRestart maps operations to battlegroup or map targets", () => {
  assert.deepEqual(classifyRestart("restartAll", {}), { target: "battlegroup", mapKey: "", mapLabel: "All servers", partitionId: 0, map: "" });
  // Settings-save-and-restart is gated by its payload's restartMode.
  assert.equal(classifyRestart("userSettingsSaveAndRestart", { restartMode: "stack", restartLabel: "all game services" }).target, "battlegroup");
  assert.equal(classifyRestart("userSettingsSaveAndRestart", { restartMode: "respawn", target: "3", restartLabel: "Deep Desert" }).target, "map");
  assert.equal(classifyRestart("userSettingsSaveAndRestart", { restartMode: "none" }), null); // a save with restart disabled is not gated
  assert.equal(classifyRestart("mapsList", {}), null); // not a restart op
  assert.equal(classifyRestart("restartService", { service: "director" }).target, "battlegroup"); // bare service restart

  const map = classifyRestart("mapsRespawn", { map: "Survival_1", partitionId: "1", restartLabel: "Hagga Basin" });
  assert.equal(map.target, "map");
  assert.equal(map.mapLabel, "Hagga Basin");
  assert.equal(map.mapKey, "survival_1:1");
  // partitionId/map are carried onto the classification (and, from there, the
  // queued entry) so the online check can be scoped to this specific map
  // instead of the whole battlegroup.
  assert.equal(map.partitionId, 1);
  assert.equal(map.map, "Survival_1");
  assert.equal(isRestartOperation("mapsRespawn"), true);
  assert.equal(isRestartOperation("userSettingsSaveAndRestart"), true);
  assert.equal(isRestartOperation("mapsList"), false);
});

test("classifyRestart resolves partitionId from either partitionId or target, defaulting to 0 when absent", () => {
  assert.equal(classifyRestart("mapsRespawn", { target: "3", restartLabel: "Deep Desert" }).partitionId, 3);
  assert.equal(classifyRestart("mapsRespawn", { restartLabel: "this map" }).partitionId, 0);
  assert.equal(classifyRestart("mapsRespawn", { partitionId: "not-a-number" }).partitionId, 0);
});

test("canQueue enforces the concurrency rules", () => {
  assert.equal(canQueue([], "battlegroup", "").ok, true);
  const mapEntries = [{ target: "map", mapKey: "survival_1:1" }];
  assert.equal(canQueue(mapEntries, "battlegroup", "").ok, false); // maps active blocks battlegroup
  assert.match(canQueue(mapEntries, "battlegroup", "").reason, /Maps are already restarting/);
  assert.equal(canQueue(mapEntries, "map", "deepdesert_1:2").ok, true); // a different map is fine
  assert.equal(canQueue(mapEntries, "map", "survival_1:1").ok, false); // same map twice is rejected
  const bgEntries = [{ target: "battlegroup", mapKey: "" }];
  assert.equal(canQueue(bgEntries, "map", "survival_1:1").ok, false); // battlegroup active blocks maps
  assert.equal(canQueue(bgEntries, "battlegroup", "").ok, false); // and blocks another battlegroup
});

test("appendEntry, readState, markEntryRestarting, recordCheckpointSent, removeEntry round-trip", () => {
  const cfg = config();
  const now = 1_000_000;
  const entry = appendEntry(cfg, {
    target: "battlegroup", type: "server", operation: "restartAll", payload: {},
    mapKey: "", mapLabel: "All servers", requestedBy: "web-admin", countdownMinutes: 15, now
  });
  assert.equal(entry.status, "counting");
  assert.equal(entry.restartAt, now + 15 * 60_000);
  assert.equal(readState(cfg).entries.length, 1);

  recordCheckpointSent(cfg, entry.id, 15);
  recordCheckpointSent(cfg, entry.id, 15); // idempotent
  assert.deepEqual(readState(cfg).entries[0].sentCheckpoints, [15]);

  markEntryRestarting(cfg, entry.id);
  assert.equal(readState(cfg).entries[0].status, "restarting");

  expediteEntry(cfg, entry.id, now + 999);
  assert.equal(readState(cfg).entries[0].restartAt, now + 999);

  removeEntry(cfg, entry.id);
  assert.equal(readState(cfg).entries.length, 0);
});

test("appendEntry carries partitionId/map for a map entry and zeroes them for a battlegroup entry", () => {
  const cfg = config();
  const mapEntry = appendEntry(cfg, {
    target: "map", type: "maps", operation: "mapsRespawn", payload: { map: "Survival_1", partitionId: "1" },
    mapKey: "survival_1:1", mapLabel: "Hagga Basin", partitionId: 1, map: "Survival_1",
    requestedBy: "web-admin", countdownMinutes: 15, now: 1_000_000
  });
  assert.equal(mapEntry.partitionId, 1);
  assert.equal(mapEntry.map, "Survival_1");

  const bgEntry = appendEntry(cfg, {
    target: "battlegroup", type: "server", operation: "restartAll", payload: {},
    mapKey: "", mapLabel: "All servers", partitionId: 3, map: "ignored-for-battlegroup",
    requestedBy: "web-admin", countdownMinutes: 15, now: 1_000_000
  });
  assert.equal(bgEntry.partitionId, 0);
  assert.equal(bgEntry.map, "");
});

test("checkpointsDue returns unsent marks at or past the remaining minutes, highest first", () => {
  const base = { status: "counting", sentCheckpoints: [15] };
  const now = 2_000_000;
  const entry = { ...base, restartAt: now + Math.round(4.5 * 60_000) }; // 4.5 min remaining
  assert.deepEqual(checkpointsDue(entry, [15, 10, 5, 1], now), [10, 5]); // 15 already sent, 1 not yet due
  assert.deepEqual(checkpointsDue({ ...entry, status: "restarting" }, [15, 10, 5, 1], now), []);
  assert.deepEqual(checkpointsDue({ ...base, restartAt: now }, [15, 10, 5, 1], now), []); // elapsed → none
});

test("buildWarning produces the two title/body variants with correct pluralization", () => {
  assert.deepEqual(buildWarning("battlegroup", "", 15), {
    title: "Battlegroup Restart",
    body: "All servers will restart in 15 minutes. Please get to a safe place."
  });
  assert.deepEqual(buildWarning("map", "Hagga Basin", 1), {
    title: "Map Restart",
    body: "Hagga Basin will restart in 1 minute. Please move to another map or get to a safe place."
  });
  assert.match(buildWarning("map", "Deep Desert", 5).body, /^Deep Desert will restart in 5 minutes\./);
});

test("defaults include the two message templates and defaultSettings clones them", () => {
  const settings = readSettings(config());
  assert.deepEqual(settings.messages, {
    battlegroup: { title: "Battlegroup Restart", body: "All servers will restart in {minutes}. Please get to a safe place." },
    map: { title: "Map Restart", body: "{mapLabel} will restart in {minutes}. Please move to another map or get to a safe place." }
  });
  // Mutating one call's result must not leak into the next.
  const a = defaultSettings();
  a.messages.battlegroup.title = "mutated";
  assert.equal(defaultSettings().messages.battlegroup.title, "Battlegroup Restart");
});

test("normalizeSettings validates message templates per-field, falling back to defaults independently", () => {
  const withCustom = normalizeSettings({ messages: { battlegroup: { title: "Heads up", body: "Down in {minutes}." }, map: { title: "", body: "x".repeat(600) } } });
  assert.deepEqual(withCustom.messages.battlegroup, { title: "Heads up", body: "Down in {minutes}." });
  // An empty title and an over-length body both fall back to the default for
  // just that field -- the valid field on the other template is unaffected.
  assert.equal(withCustom.messages.map.title, "Map Restart");
  assert.equal(withCustom.messages.map.body, "{mapLabel} will restart in {minutes}. Please move to another map or get to a safe place.");

  const untouched = normalizeSettings({ enabled: true });
  assert.deepEqual(untouched.messages, defaultSettings().messages);
});

test("buildWarning renders a custom template's placeholders, including battlegroup-with-mapLabel", () => {
  const custom = {
    battlegroup: { title: "Heads up", body: "Down in {minutes}. GLHF." },
    map: { title: "Bye {mapLabel}", body: "{mapLabel} closes in {minutes}." }
  };
  assert.deepEqual(buildWarning("battlegroup", "", 15, custom), { title: "Heads up", body: "Down in 15 minutes. GLHF." });
  assert.deepEqual(buildWarning("map", "Deep Desert", 1, custom), { title: "Bye Deep Desert", body: "Deep Desert closes in 1 minute." });
  // An unrecognized {token} is left as-is rather than silently erased.
  assert.equal(buildWarning("battlegroup", "", 5, { battlegroup: { title: "T", body: "Unknown {frobnicate} token" }, map: custom.map }).body, "Unknown {frobnicate} token");
});

test("saveSettings merges a partial body onto the currently persisted settings instead of resetting untouched fields", () => {
  const cfg = config();
  saveSettings(cfg, { enabled: true, defaultCountdownMinutes: 20, broadcastCheckpoints: [30, 5], broadcastDurationSec: 45, recoveryGraceMinutes: 10 });

  // Toggling the switch sends only `enabled` -- every other field, including
  // a not-yet-set messages object, must survive untouched.
  const toggled = saveSettings(cfg, { enabled: false });
  assert.equal(toggled.settings.enabled, false);
  assert.equal(toggled.settings.defaultCountdownMinutes, 20);
  assert.deepEqual(toggled.settings.broadcastCheckpoints, [30, 5]);
  assert.equal(toggled.settings.broadcastDurationSec, 45);
  assert.equal(toggled.settings.recoveryGraceMinutes, 10);

  // The messages editor sends only `messages` -- the countdown/checkpoint
  // fields set above must survive that save too.
  const customMessages = { battlegroup: { title: "Custom", body: "Restart in {minutes}." }, map: { title: "Custom Map", body: "{mapLabel} in {minutes}." } };
  const withMessages = saveSettings(cfg, { messages: customMessages });
  assert.deepEqual(withMessages.settings.messages, customMessages);
  assert.equal(withMessages.settings.defaultCountdownMinutes, 20);
  assert.deepEqual(withMessages.settings.broadcastCheckpoints, [30, 5]);

  // And a countdown-only save afterward must not revert the saved messages.
  const afterCountdownSave = saveSettings(cfg, { defaultCountdownMinutes: 25, broadcastCheckpoints: [30, 5] });
  assert.deepEqual(afterCountdownSave.settings.messages, customMessages);
  assert.equal(afterCountdownSave.settings.defaultCountdownMinutes, 25);
});

test("recover clears dispatched entries, resumes in-window, executes just-elapsed, discards stale", () => {
  const now = 10_000_000;
  const grace = 5;
  const state = {
    entries: [
      { id: "a", status: "restarting", target: "battlegroup", operation: "restartAll", restartAt: now - 1000 },
      { id: "b", status: "counting", target: "map", operation: "mapsRespawn", restartAt: now + 60_000 },
      { id: "c", status: "counting", target: "battlegroup", operation: "restartAll", restartAt: now - 2 * 60_000 },
      { id: "d", status: "counting", target: "battlegroup", operation: "restartAll", restartAt: now - 60 * 60_000 }
    ]
  };
  const result = recover(state, now, grace);
  assert.deepEqual(result.cleared.map((e) => e.id), ["a"]);
  assert.deepEqual(result.resume.map((e) => e.id), ["b"]);
  assert.deepEqual(result.executeNow.map((e) => e.id), ["c"]);
  assert.deepEqual(result.discarded.map((e) => e.id), ["d"]);
  assert.deepEqual(result.keep.entries.map((e) => e.id).sort(), ["b", "c"]); // resume + executeNow survive
});

test("publicState exposes remainingSeconds and a UI-safe entry shape", () => {
  const cfg = config();
  const now = 5_000_000;
  appendEntry(cfg, {
    target: "map", type: "maps", operation: "mapsRespawn", payload: { map: "Survival_1" },
    mapKey: "survival_1:1", mapLabel: "Hagga Basin", requestedBy: "web-admin", countdownMinutes: 10, now
  });
  const view = publicState(cfg, now);
  assert.equal(view.entries.length, 1);
  assert.equal(view.entries[0].remainingSeconds, 600);
  assert.equal(view.entries[0].mapLabel, "Hagga Basin");
  assert.equal(view.entries[0].target, "map");
  assert.equal(Object.prototype.hasOwnProperty.call(view.entries[0], "payload"), false); // internal fields not leaked
});

test("writeState normalizes and drops malformed entries", () => {
  const cfg = config();
  writeState(cfg, { entries: [{ id: "x", operation: "" }, { id: "y", target: "map", operation: "mapsRespawn", mapKey: "m:1" }] });
  const entries = readState(cfg).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "y");
});
