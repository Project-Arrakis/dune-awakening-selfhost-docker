import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeSettings,
  previewPlayerAnnouncement,
  primePlayerAnnouncementOnlineState,
  readPlayerAnnouncements,
  restorePlayerAnnouncements,
  runPlayerAnnouncementScan,
  savePlayerAnnouncements
} from "../src/services/playerAnnouncements.js";

function config() {
  const root = mkdtempSync(join(tmpdir(), "dune-announcements-test-"));
  return {
    repoRoot: root,
    generatedDir: join(root, "runtime", "generated"),
    mockMode: true
  };
}

function player(name = "John", id = "ABCDEF1234567890", overrides = {}) {
  return {
    actor_id: 6,
    action_player_id: id,
    fls_id: id,
    character_name: name,
    online_status: "Online",
    map: "Survival_1",
    ...overrides
  };
}

test("player announcements default to disabled with official text", () => {
  const result = readPlayerAnnouncements(config());
  assert.equal(result.settings.joinEnabled, false);
  assert.equal(result.settings.leaveEnabled, false);
  assert.equal(result.settings.joinMessage, "{playerName} has entered {mapName}, their trail fresh upon the sands.");
});

test("player announcements validate booleans and templates", () => {
  assert.equal(normalizeSettings({ joinEnabled: true, joinMessage: "{playerName} joined", leaveEnabled: false, leaveMessage: "{playerName} left" }).joinEnabled, true);
  assert.equal(normalizeSettings({ joinEnabled: true, joinMessage: "{playerName} has entered the sands of Arrakis.", leaveEnabled: true, leaveMessage: "{playerName} has vanished beyond the dunes." }).joinMessage, "{playerName} has entered {mapName}, their trail fresh upon the sands.");
  assert.throws(() => normalizeSettings({ joinEnabled: "true", joinMessage: "joined", leaveEnabled: false, leaveMessage: "left" }), /joinEnabled must be true or false/);
  assert.throws(() => normalizeSettings({ joinEnabled: true, joinMessage: "", leaveEnabled: false, leaveMessage: "left" }), /Join message is required/);
});

test("player announcements save and restore persisted settings", () => {
  const cfg = config();
  const saved = savePlayerAnnouncements(cfg, { joinEnabled: true, joinMessage: "{playerName} arrived", leaveEnabled: true, leaveMessage: "{playerName} left" });
  assert.equal(saved.settings.joinEnabled, true);
  assert.equal(JSON.parse(readFileSync(join(cfg.generatedDir, "player-announcements.json"), "utf8")).leaveEnabled, true);

  const restored = restorePlayerAnnouncements(cfg);
  assert.equal(restored.settings.joinEnabled, false);
  assert.equal(restored.settings.leaveMessage, "{playerName} has vanished from {mapName}, their tracks swallowed by the dunes.");
});

test("player announcements publish join and leave events from online state changes", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, { joinEnabled: true, joinMessage: "{playerName} joined", leaveEnabled: true, leaveMessage: "{playerName} left" });

  const joined = await runPlayerAnnouncementScan(cfg, [player("John")], { mockMode: true });
  assert.equal(joined.joined, 1);
  assert.equal(joined.sent, 1);

  const unchanged = await runPlayerAnnouncementScan(cfg, [player("John")], { mockMode: true });
  assert.equal(unchanged.sent, 0);

  const secondJoined = await runPlayerAnnouncementScan(cfg, [player("John"), player("Jane", "1234567890ABCDEF")], { mockMode: true });
  assert.equal(secondJoined.joined, 1);
  assert.equal(secondJoined.sent, 2);

  const left = await runPlayerAnnouncementScan(cfg, [player("Jane", "1234567890ABCDEF")], { mockMode: true });
  assert.equal(left.left, 1);
  assert.equal(left.sent, 1);
});

test("player announcements treat changed login session as a fresh join", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, { joinEnabled: true, joinMessage: "{playerName} joined", leaveEnabled: false, leaveMessage: "{playerName} left" });

  const first = await runPlayerAnnouncementScan(cfg, [player("John", "ABCDEF1234567890", { login_session: "2026-06-28 10:00:00+00" })], { mockMode: true });
  assert.equal(first.joined, 1);
  assert.equal(first.sent, 1);

  const sameSession = await runPlayerAnnouncementScan(cfg, [player("John", "ABCDEF1234567890", { login_session: "2026-06-28 10:00:00+00" })], { mockMode: true });
  assert.equal(sameSession.joined, 0);
  assert.equal(sameSession.sent, 0);

  const quickRelog = await runPlayerAnnouncementScan(cfg, [player("John", "ABCDEF1234567890", { login_session: "2026-06-28 10:05:00+00" })], { mockMode: true });
  assert.equal(quickRelog.joined, 1);
  assert.equal(quickRelog.sent, 1);
});

test("player announcements wait for a fresh login session before sending", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, { joinEnabled: true, joinMessage: "{playerName} joined", leaveEnabled: false, leaveMessage: "{playerName} left" });
  const freshLogin = player("John", "ABCDEF1234567890", { login_session: "2026-06-30T00:00:00.000Z" });

  const tooEarly = await runPlayerAnnouncementScan(cfg, [freshLogin], { mockMode: true, now: new Date("2026-06-30T00:00:10.000Z") });
  assert.equal(tooEarly.joined, 0);
  assert.equal(tooEarly.sent, 0);

  const mature = await runPlayerAnnouncementScan(cfg, [freshLogin], { mockMode: true, now: new Date("2026-06-30T00:00:31.000Z") });
  assert.equal(mature.joined, 1);
  assert.equal(mature.sent, 1);
});

test("player announcements wait when Postgres session timestamp uses short UTC offset", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, { joinEnabled: true, joinMessage: "{playerName} joined", leaveEnabled: false, leaveMessage: "{playerName} left" });
  const freshLogin = player("John", "ABCDEF1234567890", { login_session: "2026-06-30 00:00:00.000000+00" });

  const tooEarly = await runPlayerAnnouncementScan(cfg, [freshLogin], { mockMode: true, now: new Date("2026-06-30T00:00:10.000Z") });
  assert.equal(tooEarly.joined, 0);
  assert.equal(tooEarly.sent, 0);

  const mature = await runPlayerAnnouncementScan(cfg, [freshLogin], { mockMode: true, now: new Date("2026-06-30T00:00:31.000Z") });
  assert.equal(mature.joined, 1);
  assert.equal(mature.sent, 1);
});

test("player announcements defer a changed login session without suppressing the later join", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, { joinEnabled: true, joinMessage: "{playerName} joined", leaveEnabled: false, leaveMessage: "{playerName} left" });

  const first = await runPlayerAnnouncementScan(cfg, [player("John", "ABCDEF1234567890", { login_session: "2026-06-30T00:00:00.000Z" })], { mockMode: true, now: new Date("2026-06-30T00:02:00.000Z") });
  assert.equal(first.sent, 1);

  const relog = player("John", "ABCDEF1234567890", { login_session: "2026-06-30T00:05:00.000Z" });
  const tooEarly = await runPlayerAnnouncementScan(cfg, [relog], { mockMode: true, now: new Date("2026-06-30T00:05:10.000Z") });
  assert.equal(tooEarly.joined, 0);
  assert.equal(tooEarly.sent, 0);

  const mature = await runPlayerAnnouncementScan(cfg, [relog], { mockMode: true, now: new Date("2026-06-30T00:05:31.000Z") });
  assert.equal(mature.joined, 1);
  assert.equal(mature.sent, 1);
});

test("player announcements publish leave and join events for map changes within the same login", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, { joinEnabled: true, joinMessage: "{playerName} joined", leaveEnabled: true, leaveMessage: "{playerName} left" });

  const stableSession = "2026-06-28 10:00:00+00";
  const first = await runPlayerAnnouncementScan(cfg, [
    player("John", "ABCDEF1234567890", { actor_id: 6, map: "Survival_1", login_session: stableSession }),
    player("Jane", "1234567890ABCDEF", { actor_id: 100, map: "Survival_1", login_session: stableSession }),
    player("Paul", "A1234567890BCDEF", { actor_id: 101, map: "Overmap", login_session: stableSession })
  ], { mockMode: true });
  assert.equal(first.joined, 3);
  assert.equal(first.left, 0);

  const mapTravel = await runPlayerAnnouncementScan(cfg, [
    player("John", "ABCDEF1234567890", { actor_id: 99, map: "Overmap", login_session: stableSession }),
    player("Jane", "1234567890ABCDEF", { actor_id: 100, map: "Survival_1", login_session: stableSession }),
    player("Paul", "A1234567890BCDEF", { actor_id: 101, map: "Overmap", login_session: stableSession })
  ], { mockMode: true });
  assert.equal(mapTravel.joined, 1);
  assert.equal(mapTravel.left, 1);
  assert.equal(mapTravel.sent, 3);
  assert.deepEqual(mapTravel.results.map((result) => result.type), ["leave", "join"]);
});

test("player announcements report leave events even when nobody remains online", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, { joinEnabled: false, joinMessage: "{playerName} joined", leaveEnabled: true, leaveMessage: "{playerName} left" });
  primePlayerAnnouncementOnlineState(cfg, [player("John")]);

  const left = await runPlayerAnnouncementScan(cfg, [], { mockMode: true });
  assert.equal(left.left, 1);
  assert.equal(left.sent, 0);
  assert.equal(left.skippedNoRecipients, 1);
  assert.equal(left.results[0].reason, "no_online_recipients");
});

test("player announcements render map names and target the matching map only", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, {
    joinEnabled: true,
    joinMessage: "{playerName} entered {mapName}",
    leaveEnabled: true,
    leaveMessage: "{playerName} left {mapName}"
  });
  primePlayerAnnouncementOnlineState(cfg, [player("John")]);

  const jane = player("Jane", "1234567890ABCDEF");
  jane.map = "Overmap";
  const overlandJoin = await runPlayerAnnouncementScan(cfg, [player("John"), jane], { mockMode: true });
  assert.equal(overlandJoin.joined, 1);
  assert.equal(overlandJoin.sent, 1);
  assert.equal(overlandJoin.results[0].recipients, 1);

  const janeLeft = await runPlayerAnnouncementScan(cfg, [player("John")], { mockMode: true });
  assert.equal(janeLeft.left, 1);
  assert.equal(janeLeft.sent, 0);
  assert.equal(janeLeft.skippedNoRecipients, 1);
});

test("player announcements ignore offline rows", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, { joinEnabled: true, joinMessage: "{playerName} joined", leaveEnabled: true, leaveMessage: "{playerName} left" });

  const offline = player("John");
  offline.online_status = "Offline";
  const result = await runPlayerAnnouncementScan(cfg, [offline], { mockMode: true });
  assert.equal(result.joined, 0);
  assert.equal(result.left, 0);
  assert.equal(result.sent, 0);
});

test("player announcements can prime current online players after save", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, { joinEnabled: true, joinMessage: "{playerName} joined", leaveEnabled: false, leaveMessage: "{playerName} left" });
  const primed = primePlayerAnnouncementOnlineState(cfg, [player("John")]);
  assert.equal(primed.online, 1);

  const currentSession = await runPlayerAnnouncementScan(cfg, [player("John")], { mockMode: true });
  assert.equal(currentSession.sent, 0);

  await runPlayerAnnouncementScan(cfg, [], { mockMode: true });
  const nextSession = await runPlayerAnnouncementScan(cfg, [player("John")], { mockMode: true });
  assert.equal(nextSession.sent, 1);
});

test("player announcement preview renders the join template", () => {
  assert.equal(previewPlayerAnnouncement({ joinEnabled: true, joinMessage: "{playerName} arrived in {mapName}", leaveEnabled: false, leaveMessage: "{playerName} left" }, "John", "Overland"), "John arrived in Overland");
});
