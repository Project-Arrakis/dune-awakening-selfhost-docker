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
  assert.equal(result.settings.deliveryMode, "login");
});

test("message of the day validates booleans and message text", () => {
  assert.deepEqual(normalizeSettings({ enabled: true, title: "Daily", message: "Hello" }), { enabled: true, title: "", message: "Hello", deliveryMode: "login" });
  assert.equal(normalizeSettings({ enabled: true, message: "Hello", deliveryMode: "daily" }).deliveryMode, "daily");
  assert.equal(normalizeSettings({ enabled: true, message: "Hello", deliveryMode: "map" }).deliveryMode, "map");
  assert.equal(normalizeSettings({ enabled: true, message: "First\n\nSecond" }).message, "First Second");
  assert.throws(() => normalizeSettings({ enabled: "true", title: "Daily", message: "Hello" }), /enabled must be true or false/);
  assert.throws(() => normalizeSettings({ enabled: true, message: "Hello", deliveryMode: "hourly" }), /deliveryMode/);
  assert.throws(() => normalizeSettings({ enabled: true, title: "Daily", message: "x".repeat(501) }), /Message must be 1-500/);
});

test("message of the day renders the recipient name without changing unknown text", () => {
  assert.equal(renderMessageOfTheDay("Welcome, {playerName}!", "JaneDoe"), "Welcome, JaneDoe!");
  assert.equal(renderMessageOfTheDay("Welcome to {serverName}", "JaneDoe"), "Welcome to {serverName}");
  assert.equal(renderMessageOfTheDay("", "JaneDoe"), "");
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

test("message of the day sends again after a confirmed logout", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const firstSession = onlinePlayer({ login_session: "2026-06-28T10:00:00.000Z" });
  const secondSession = onlinePlayer({ login_session: "2026-06-28T11:00:00.000Z" });

  const first = await runMessageOfTheDayScan(cfg, [firstSession], { mockMode: true, now: new Date("2026-06-28T10:01:00.000Z"), persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(first.sent, 1);
  assert.equal(readMessageOfTheDay(cfg).status.lastSent, 1);
  assert.equal(readMessageOfTheDay(cfg).status.lastFailed, 0);

  const second = await runMessageOfTheDayScan(cfg, [firstSession], { mockMode: true, now: new Date("2026-06-28T10:02:00.000Z"), persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(second.sent, 0);

  const logout = await runMessageOfTheDayScan(cfg, [], { mockMode: true, now: new Date("2026-06-28T10:03:00.000Z"), persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(logout.sent, 0);

  const loginAgain = await runMessageOfTheDayScan(cfg, [secondSession], { mockMode: true, now: new Date("2026-06-28T11:01:00.000Z"), persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
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

test("message of the day treats a changed login timestamp during map travel as the same session", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });

  const first = await runMessageOfTheDayScan(cfg, [onlinePlayer({ login_session: "2026-06-28 10:00:00+00" })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(first.sent, 1);

  const sameSession = await runMessageOfTheDayScan(cfg, [onlinePlayer({ login_session: "2026-06-28 10:00:00+00" })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(sameSession.sent, 0);

  const mapTravel = await runMessageOfTheDayScan(cfg, [onlinePlayer({ login_session: "2026-06-28 10:05:00+00" })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(mapTravel.sent, 0);
});

test("message of the day waits for a fresh login session before sending", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const freshLogin = onlinePlayer({ login_session: "2026-06-30T00:00:00.000Z" });

  const tooEarly = await runMessageOfTheDayScan(cfg, [freshLogin], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:00:29.999Z") });
  assert.equal(tooEarly.sent, 0);

  const mature = await runMessageOfTheDayScan(cfg, [freshLogin], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:00:30.000Z") });
  assert.equal(mature.sent, 1);
});

test("message of the day waits when Postgres session timestamp uses short UTC offset", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const freshLogin = onlinePlayer({ login_session: "2026-06-30 00:00:00.000000+00" });

  const tooEarly = await runMessageOfTheDayScan(cfg, [freshLogin], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:00:29.999Z") });
  assert.equal(tooEarly.sent, 0);

  const mature = await runMessageOfTheDayScan(cfg, [freshLogin], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:00:30.000Z") });
  assert.equal(mature.sent, 1);
});

test("message of the day does not mark fresh sessions delivered before the delay", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const freshLogin = onlinePlayer({ login_session: "2026-06-30T00:00:00.000Z" });

  await runMessageOfTheDayScan(cfg, [freshLogin], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:00:29.999Z") });
  const delivered = JSON.parse(readFileSync(join(cfg.generatedDir, "message-of-the-day-state.json"), "utf8")).delivered;
  assert.deepEqual(delivered, {});

  const mature = await runMessageOfTheDayScan(cfg, [freshLogin], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-30T00:00:30.000Z") });
  assert.equal(mature.sent, 1);
});

test("message of the day keeps delivery pending until the player queue has a consumer", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const player = onlinePlayer({ login_session: "2026-06-30T00:00:00.000Z" });
  const now = new Date("2026-06-30T00:01:00.000Z");

  const waiting = await runMessageOfTheDayScan(cfg, [player], {
    mockMode: true,
    now,
    readyRecipientQueues: new Set()
  });
  assert.equal(waiting.sent, 0);
  assert.equal(waiting.failed, 0);
  assert.equal(waiting.deferred, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(cfg.generatedDir, "message-of-the-day-state.json"), "utf8")).delivered, {});

  const delivered = await runMessageOfTheDayScan(cfg, [player], {
    mockMode: true,
    now,
    readyRecipientQueues: new Set(["ABCDEF1234567890_queue"])
  });
  assert.equal(delivered.sent, 1);
  assert.equal(delivered.deferred, 0);
});

test("message of the day does not resend on map or actor changes within the same login", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });

  const first = await runMessageOfTheDayScan(cfg, [onlinePlayer({ actor_id: 6, map: "Survival_1", login_session: "2026-06-28 10:00:00+00" })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(first.sent, 1);

  const mapTravel = await runMessageOfTheDayScan(cfg, [onlinePlayer({ action_player_id: "NEW-ACTION-ID", actor_id: 99, map: "Overmap", login_session: "2026-06-28 10:00:00+00" })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(mapTravel.sent, 0);
});

test("map delivery sends on login and once for each map or partition transfer", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, message: "Welcome back", deliveryMode: "map" });
  const scan = (player, now) => runMessageOfTheDayScan(cfg, [player], { mockMode: true, now: new Date(now) });

  const hagga = onlinePlayer({ map: "Survival_1", partition_id: 1, login_session: "2026-06-28T10:00:00.000Z" });
  assert.equal((await scan(hagga, "2026-06-28T10:01:00.000Z")).sent, 1);
  assert.equal((await scan(hagga, "2026-06-28T10:02:00.000Z")).sent, 0);

  const overland = onlinePlayer({ actor_id: 99, map: "Overmap", partition_id: 2, login_session: "2026-06-28T10:03:00.000Z" });
  assert.equal((await scan(overland, "2026-06-28T10:03:29.999Z")).sent, 0);
  assert.equal((await scan(overland, "2026-06-28T10:03:30.000Z")).sent, 1);
  assert.equal((await scan(overland, "2026-06-28T10:04:00.000Z")).sent, 0);

  const anotherSietch = onlinePlayer({ actor_id: 101, map: "Survival_1", partition_id: 3, login_session: "2026-06-28T10:05:00.000Z" });
  assert.equal((await scan(anotherSietch, "2026-06-28T10:05:30.000Z")).sent, 1);
});

test("map delivery still sends after a confirmed relog to the same map", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, message: "Welcome back", deliveryMode: "map" });
  const first = onlinePlayer({ map: "Survival_1", partition_id: 1, login_session: "2026-06-28T10:00:00.000Z" });
  const second = onlinePlayer({ map: "Survival_1", partition_id: 1, login_session: "2026-06-28T11:00:00.000Z" });

  assert.equal((await runMessageOfTheDayScan(cfg, [first], { mockMode: true, now: new Date("2026-06-28T10:01:00.000Z") })).sent, 1);
  await runMessageOfTheDayScan(cfg, [], { mockMode: true, now: new Date("2026-06-28T10:02:00.000Z") });
  assert.equal((await runMessageOfTheDayScan(cfg, [second], { mockMode: true, now: new Date("2026-06-28T11:01:00.000Z") })).sent, 1);
});

test("message of the day survives transient offline scans during map travel", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const session = "2026-06-28 10:00:00+00";

  const first = await runMessageOfTheDayScan(cfg, [onlinePlayer({ actor_id: 6, map: "Survival_1", login_session: session })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-28T10:01:00.000Z") });
  assert.equal(first.sent, 1);

  const travelGap = await runMessageOfTheDayScan(cfg, [], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-28T10:02:00.000Z") });
  assert.equal(travelGap.sent, 0);

  const overmap = await runMessageOfTheDayScan(cfg, [onlinePlayer({ action_player_id: "NEW-ACTION-ID", actor_id: 99, map: "Overmap", login_session: "2026-06-28 10:02:30+00" })], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" }, now: new Date("2026-06-28T10:03:00.000Z") });
  assert.equal(overmap.sent, 0);
});

test("message of the day survives map travel when no login timestamp is available", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, message: "Welcome back" });

  const first = await runMessageOfTheDayScan(cfg, [onlinePlayer()], { mockMode: true, now: new Date("2026-06-28T10:01:00.000Z") });
  assert.equal(first.sent, 1);
  await runMessageOfTheDayScan(cfg, [], { mockMode: true, now: new Date("2026-06-28T10:02:00.000Z") });
  const afterTravel = await runMessageOfTheDayScan(cfg, [onlinePlayer({ actor_id: 99, map: "Overmap" })], { mockMode: true, now: new Date("2026-06-28T10:03:00.000Z") });
  assert.equal(afterTravel.sent, 0);
});

test("message of the day does not expire during a long continuous login", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, message: "Welcome back" });
  const session = "2026-06-28T10:00:00.000Z";

  const first = await runMessageOfTheDayScan(cfg, [onlinePlayer({ login_session: session })], { mockMode: true, now: new Date("2026-06-28T10:01:00.000Z") });
  assert.equal(first.sent, 1);
  const stillOnline = await runMessageOfTheDayScan(cfg, [onlinePlayer({ login_session: session })], { mockMode: true, now: new Date("2026-06-30T11:00:00.000Z") });
  assert.equal(stillOnline.sent, 0);
  await runMessageOfTheDayScan(cfg, [], { mockMode: true, now: new Date("2026-06-30T11:01:00.000Z") });
  const afterTravel = await runMessageOfTheDayScan(cfg, [onlinePlayer({ login_session: "2026-06-30T11:01:30.000Z" })], { mockMode: true, now: new Date("2026-06-30T11:02:00.000Z") });
  assert.equal(afterTravel.sent, 0);
});

test("daily message of the day sends at most once every 24 hours", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, message: "Welcome back", deliveryMode: "daily" });
  const player = onlinePlayer({ login_session: "2026-06-28T10:00:00.000Z" });

  const first = await runMessageOfTheDayScan(cfg, [player], { mockMode: true, now: new Date("2026-06-28T12:00:00.000Z") });
  assert.equal(first.sent, 1);
  const sameDayAfterTravel = await runMessageOfTheDayScan(cfg, [onlinePlayer({ login_session: "2026-06-28T15:00:00.000Z" })], { mockMode: true, now: new Date("2026-06-28T16:00:00.000Z") });
  assert.equal(sameDayAfterTravel.sent, 0);
  const nextDay = await runMessageOfTheDayScan(cfg, [onlinePlayer({ login_session: "2026-06-29T10:00:00.000Z" })], { mockMode: true, now: new Date("2026-06-29T12:00:00.000Z") });
  assert.equal(nextDay.sent, 1);
});

test("message of the day can prime currently online players after save", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const firstSession = onlinePlayer({ login_session: "2026-06-28T10:00:00.000Z" });
  const primed = primeMessageOfTheDayOnlineState(cfg, [firstSession], new Date("2026-06-28T10:01:00.000Z"));
  assert.equal(primed.delivered, 1);

  const currentSession = await runMessageOfTheDayScan(cfg, [firstSession], { mockMode: true, now: new Date("2026-06-28T10:02:00.000Z"), persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(currentSession.sent, 0);

  await runMessageOfTheDayScan(cfg, [], { mockMode: true, now: new Date("2026-06-28T10:03:00.000Z"), persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  const nextSession = await runMessageOfTheDayScan(cfg, [onlinePlayer({ login_session: "2026-06-28T11:00:00.000Z" })], { mockMode: true, now: new Date("2026-06-28T11:01:00.000Z"), persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
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
