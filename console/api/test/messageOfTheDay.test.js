import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  messageOfTheDayDeliveryPlan,
  normalizeSettings,
  primeMessageOfTheDayOnlineState,
  readMessageOfTheDay,
  recordMessageOfTheDayScanFailure,
  renderMessageOfTheDay,
  restoreMessageOfTheDay,
  runMessageOfTheDayScan,
  saveMessageOfTheDay
} from "../src/services/messageOfTheDay.js";

function config() {
  const root = mkdtempSync(join(tmpdir(), "dune-motd-test-"));
  return {
    repoRoot: root,
    generatedDir: join(root, "runtime", "generated"),
    mockMode: true
  };
}

function onlinePlayer(overrides = {}) {
  return {
    actor_id: 6,
    action_player_id: "ABCDEF1234567890",
    fls_id: "ABCDEF1234567890",
    funcom_id: "RedBlink#75570",
    character_name: "JaneDoe",
    online_status: "Online",
    ...overrides
  };
}

test("message of the day defaults are disabled with an empty draft", () => {
  const result = readMessageOfTheDay(config());
  assert.equal(result.settings.enabled, false);
  assert.equal(result.settings.title, "");
  assert.equal(result.settings.message, "");
});

test("message of the day validates booleans and message text", () => {
  assert.deepEqual(normalizeSettings({ enabled: true, title: "Daily", message: "Hello" }), { enabled: true, title: "", message: "Hello" });
  assert.equal(normalizeSettings({ enabled: true, message: "First\n\nSecond" }).message, "First Second");
  assert.throws(() => normalizeSettings({ enabled: "true", title: "Daily", message: "Hello" }), /enabled must be true or false/);
  assert.throws(() => normalizeSettings({ enabled: true, title: "Daily", message: "x".repeat(501) }), /Message must be 1-500/);
});

test("message of the day renders the recipient name without changing unknown text", () => {
  assert.equal(renderMessageOfTheDay("Welcome, {playerName}!", "JaneDoe"), "Welcome, JaneDoe!");
  assert.equal(renderMessageOfTheDay("Welcome to {serverName}", "JaneDoe"), "Welcome to {serverName}");
});

test("message of the day saves and restores persisted settings", () => {
  const cfg = config();
  const saved = saveMessageOfTheDay(cfg, { enabled: true, title: "News", message: "Welcome" });
  assert.equal(saved.settings.enabled, true);
  assert.equal(JSON.parse(readFileSync(join(cfg.generatedDir, "message-of-the-day.json"), "utf8")).message, "Welcome");

  const restored = restoreMessageOfTheDay(cfg);
  assert.equal(restored.settings.enabled, false);
  assert.equal(restored.settings.message, "");
});

test("message of the day sends once per online session", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });

  const first = await runMessageOfTheDayScan(cfg, [onlinePlayer()], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(first.sent, 1);
  assert.equal(readMessageOfTheDay(cfg).status.lastSent, 1);
  assert.equal(readMessageOfTheDay(cfg).status.lastFailed, 0);

  const second = await runMessageOfTheDayScan(cfg, [onlinePlayer()], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(second.sent, 0);

  const logout = await runMessageOfTheDayScan(cfg, [], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(logout.sent, 0);

  const loginAgain = await runMessageOfTheDayScan(cfg, [onlinePlayer()], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(loginAgain.sent, 1);
});

test("message of the day records a redacted scan interruption without inventing a failed delivery", () => {
  const cfg = config();
  const status = recordMessageOfTheDayScanFailure(cfg, new Error("Postgres password=super-secret unavailable"), new Date("2026-07-25T12:00:00.000Z"));
  assert.equal(status.lastAttemptAt, "");
  assert.equal(status.lastFailed, 0);
  assert.equal(status.lastScanAt, "2026-07-25T12:00:00.000Z");
  assert.doesNotMatch(status.lastScanError, /super-secret/);
  assert.deepEqual(readMessageOfTheDay(cfg).status, status);
});

test("message of the day clears a stale scan interruption after a healthy scan", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  recordMessageOfTheDayScanFailure(cfg, new Error("read ECONNRESET"), new Date("2026-07-25T12:00:00.000Z"));

  await runMessageOfTheDayScan(cfg, [], { mockMode: true, now: new Date("2026-07-25T12:01:00.000Z") });
  const status = readMessageOfTheDay(cfg).status;
  assert.equal(status.lastFailed, 0);
  assert.equal(status.lastScanAt, "2026-07-25T12:01:00.000Z");
  assert.equal(status.lastScanError, "");
});

test("message of the day migrates legacy infrastructure failures to scan status", () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const statePath = join(cfg.generatedDir, "message-of-the-day-state.json");
  const legacy = {
    delivered: {},
    status: { lastAttemptAt: "2026-07-25T12:00:00.000Z", lastSent: 0, lastFailed: 1, lastError: "read ECONNRESET" }
  };
  mkdirSync(cfg.generatedDir, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(legacy)}\n`);

  const status = readMessageOfTheDay(cfg).status;
  assert.equal(status.lastAttemptAt, "");
  assert.equal(status.lastFailed, 0);
  assert.equal(status.lastScanAt, "2026-07-25T12:00:00.000Z");
  assert.equal(status.lastScanError, "read ECONNRESET");
});

test("message of the day sends once for duplicate online rows with the same player key", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const duplicateA = onlinePlayer({ actor_id: 6, character_name: "OldName", login_session: "2026-06-30T00:00:00.000Z" });
  const duplicateB = onlinePlayer({ actor_id: 78, character_name: "JaneDoe", login_session: "2026-06-30T00:02:00.000Z" });

  const result = await runMessageOfTheDayScan(cfg, [duplicateA, duplicateB], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:04:00.000Z") });
  assert.equal(result.sent, 1);

  const delivered = JSON.parse(readFileSync(join(cfg.generatedDir, "message-of-the-day-state.json"), "utf8")).delivered;
  assert.equal(Object.keys(delivered).length, 1);
  assert.equal(delivered.ABCDEF1234567890.characterName, "JaneDoe");
});

test("message of the day ignores offline rows even if they are passed to the scanner", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });

  const result = await runMessageOfTheDayScan(cfg, [onlinePlayer({ online_status: "Offline" })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(result.sent, 0);
});

test("message of the day skips incomplete recipient identities without recording a failed delivery", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });

  const result = await runMessageOfTheDayScan(cfg, [onlinePlayer({
    fls_id: "not a queue identity",
    funcom_id: "invalid\u0000recipient identity"
  })], { mockMode: true });

  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
  assert.equal(readMessageOfTheDay(cfg).status.lastFailed, 0);
});

test("message of the day can fall back to a valid Funcom route when the FLS identity is unavailable", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });

  const result = await runMessageOfTheDayScan(cfg, [onlinePlayer({ fls_id: "unavailable" })], { mockMode: true });

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
});

test("message of the day accepts native 15-character FLS IDs and Unicode Funcom names", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, message: "Welcome, {playerName}!" });

  const result = await runMessageOfTheDayScan(cfg, [onlinePlayer({
    fls_id: "DCFAB28D07E0F79",
    funcom_id: "❤️  SugarFluff  ❤#42013",
    character_name: "SugarFluff"
  })], { mockMode: true });

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
});

test("message of the day treats changed login session as a new online session", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });

  const first = await runMessageOfTheDayScan(cfg, [onlinePlayer({ login_session: "2026-06-28 10:00:00+00" })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(first.sent, 1);

  const sameSession = await runMessageOfTheDayScan(cfg, [onlinePlayer({ login_session: "2026-06-28 10:00:00+00" })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(sameSession.sent, 0);

  const quickRelog = await runMessageOfTheDayScan(cfg, [onlinePlayer({ login_session: "2026-06-28 10:05:00+00" })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(quickRelog.sent, 1);
});

test("message of the day waits for a fresh login session before sending", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const freshLogin = onlinePlayer({ login_session: "2026-06-30T00:00:00.000Z" });

  const tooEarly = await runMessageOfTheDayScan(cfg, [freshLogin], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:00:04.000Z") });
  assert.equal(tooEarly.sent, 0);

  const mature = await runMessageOfTheDayScan(cfg, [freshLogin], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:00:06.000Z") });
  assert.equal(mature.sent, 1);
});

test("message of the day waits when Postgres session timestamp uses short UTC offset", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const freshLogin = onlinePlayer({ login_session: "2026-06-30 00:00:00.000000+00" });

  const tooEarly = await runMessageOfTheDayScan(cfg, [freshLogin], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:00:04.000Z") });
  assert.equal(tooEarly.sent, 0);

  const mature = await runMessageOfTheDayScan(cfg, [freshLogin], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:00:06.000Z") });
  assert.equal(mature.sent, 1);
});

test("message of the day does not mark fresh sessions delivered before the delay", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const freshLogin = onlinePlayer({ login_session: "2026-06-30T00:00:00.000Z" });

  await runMessageOfTheDayScan(cfg, [freshLogin], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:00:04.000Z") });
  const delivered = JSON.parse(readFileSync(join(cfg.generatedDir, "message-of-the-day-state.json"), "utf8")).delivered;
  assert.deepEqual(delivered, {});

  const mature = await runMessageOfTheDayScan(cfg, [freshLogin], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:00:06.000Z") });
  assert.equal(mature.sent, 1);
});

test("message of the day does not resend on map or actor changes within the same login", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });

  const first = await runMessageOfTheDayScan(cfg, [onlinePlayer({ actor_id: 6, map: "Survival_1", login_session: "2026-06-28 10:00:00+00" })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(first.sent, 1);

  const mapTravel = await runMessageOfTheDayScan(cfg, [onlinePlayer({ action_player_id: "NEW-ACTION-ID", actor_id: 99, map: "Overmap", login_session: "2026-06-28 10:00:00+00" })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(mapTravel.sent, 0);
});

test("message of the day survives transient offline scans during map travel", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const session = "2026-06-28 10:00:00+00";

  const first = await runMessageOfTheDayScan(cfg, [onlinePlayer({ actor_id: 6, map: "Survival_1", login_session: session })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-28T10:01:00.000Z") });
  assert.equal(first.sent, 1);

  const travelGap = await runMessageOfTheDayScan(cfg, [], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-28T10:02:00.000Z") });
  assert.equal(travelGap.sent, 0);

  const overmap = await runMessageOfTheDayScan(cfg, [onlinePlayer({ action_player_id: "NEW-ACTION-ID", actor_id: 99, map: "Overmap", login_session: session })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-28T10:03:00.000Z") });
  assert.equal(overmap.sent, 0);
});

test("message of the day can prime currently online players after save", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const primed = primeMessageOfTheDayOnlineState(cfg, [onlinePlayer()]);
  assert.equal(primed.delivered, 1);

  const currentSession = await runMessageOfTheDayScan(cfg, [onlinePlayer()], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(currentSession.sent, 0);

  await runMessageOfTheDayScan(cfg, [], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  const nextSession = await runMessageOfTheDayScan(cfg, [onlinePlayer()], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(nextSession.sent, 1);
});

test("message of the day delivery plan preserves only current online players", () => {
  const plan = messageOfTheDayDeliveryPlan(
    { enabled: true, title: "Daily", message: "Welcome" },
    [onlinePlayer()],
    { delivered: { ABCDEF1234567890: { deliveredAt: "now" }, stale: { deliveredAt: "old" } } }
  );
  assert.equal(plan.pending.length, 0);
  assert.deepEqual(Object.keys(plan.delivered), ["ABCDEF1234567890"]);
});
