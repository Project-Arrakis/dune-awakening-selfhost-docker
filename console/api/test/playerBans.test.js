import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  banPlayer,
  bannedFlsIds,
  createPlayerBanEnforcer,
  normalizeBanFlsId,
  playerBanFor,
  readPlayerBanState,
  unbanPlayer
} from "../src/services/playerBans.js";

const FLS_ID = "254A06043E9F0B16";

function root() {
  return mkdtempSync(join(tmpdir(), "dune-player-bans-test-"));
}

function player(overrides = {}) {
  return {
    actor_id: "82",
    account_id: "276",
    character_name: "Vixen",
    funcom_id: "Vixen#1234",
    fls_id: FLS_ID,
    online_status: "Online",
    map: "Survival_1",
    ...overrides
  };
}

test("player bans persist by stable FLS identity across character and account changes", () => {
  const repoRoot = root();
  const result = banPlayer(repoRoot, player(), { reason: "Repeated griefing", now: () => Date.parse("2026-08-07T00:00:00Z") });
  assert.equal(result.alreadyBanned, false);
  assert.equal(result.ban.reason, "Repeated griefing");
  assert.deepEqual(bannedFlsIds(repoRoot), [FLS_ID]);
  assert.equal(playerBanFor(repoRoot, player({ actor_id: "900", account_id: "999", character_name: "New Character" }))?.flsId, FLS_ID);

  const saved = JSON.parse(readFileSync(join(repoRoot, "runtime/generated/player-bans.json"), "utf8"));
  assert.equal(saved.bans[FLS_ID].accountId, "276");
  assert.equal(saved.bans[FLS_ID].characterName, "Vixen");
});

test("player ban writes are idempotent and unban is safe to repeat", () => {
  const repoRoot = root();
  banPlayer(repoRoot, player(), { now: () => Date.parse("2026-08-07T00:00:00Z") });
  const second = banPlayer(repoRoot, player({ character_name: "Renamed" }), { now: () => Date.parse("2026-08-07T01:00:00Z") });
  assert.equal(second.alreadyBanned, true);
  assert.equal(second.ban.characterName, "Renamed");
  assert.equal(second.ban.createdAt, "2026-08-07T00:00:00.000Z");
  assert.equal(second.ban.updatedAt, "2026-08-07T01:00:00.000Z");
  assert.equal(unbanPlayer(repoRoot, FLS_ID).wasBanned, true);
  assert.equal(unbanPlayer(repoRoot, FLS_ID).wasBanned, false);
  assert.equal(playerBanFor(repoRoot, player()), null);
});

test("player ban registry ignores corrupt state and rejects unstable identifiers", () => {
  const repoRoot = root();
  const file = join(repoRoot, "runtime/generated/player-bans.json");
  mkdirSync(join(repoRoot, "runtime/generated"), { recursive: true });
  writeFileSync(file, "not-json");
  assert.deepEqual(readPlayerBanState(repoRoot).bans, {});
  assert.throws(() => normalizeBanFlsId("276"), /valid stable FLS account ID/);
  assert.throws(() => banPlayer(repoRoot, player({ fls_id: "Vixen#1234" })), /valid stable FLS account ID/);
});

test("ban enforcer publishes account kicks, observes cooldown, and survives process recreation", async () => {
  const repoRoot = root();
  const cfg = { repoRoot };
  banPlayer(repoRoot, player());
  const kicks = [];
  const audits = [];
  let currentTime = 100_000;
  const options = {
    config: cfg,
    getDb: () => ({}),
    duneDb: { listAllPlayers: async (_db, params) => {
      assert.equal(params.status, "online");
      return { rows: [player()] };
    } },
    now: () => currentTime,
    cooldownMs: 15_000,
    publishKick: async (flsId, target) => kicks.push({ flsId, map: target.map }),
    auditImpl: (_config, _req, action, detail) => audits.push({ action, detail })
  };
  const firstProcess = createPlayerBanEnforcer(options);
  assert.equal((await firstProcess.tick()).enforced, 1);
  assert.equal((await firstProcess.tick()).enforced, 0);
  assert.deepEqual(kicks, [{ flsId: FLS_ID, map: "Survival_1" }]);

  currentTime += 16_000;
  assert.equal((await firstProcess.tick()).enforced, 1);
  assert.equal(readPlayerBanState(repoRoot).bans[FLS_ID].enforcementCount, 2);
  assert.equal(audits.every((entry) => entry.action === "players.ban-enforced"), true);

  currentTime += 1;
  const restartedProcess = createPlayerBanEnforcer(options);
  assert.equal((await restartedProcess.tick()).enforced, 1);
  assert.equal(kicks.length, 3);

  unbanPlayer(repoRoot, FLS_ID);
  assert.equal((await restartedProcess.tick()).reason, "empty");
});

test("ban enforcer isolates a failed kick and continues with other banned accounts", async () => {
  const repoRoot = root();
  const secondFlsId = "ABCDEF1234567890";
  banPlayer(repoRoot, player());
  banPlayer(repoRoot, player({ fls_id: secondFlsId, character_name: "Second" }));
  const kicked = [];
  const enforcer = createPlayerBanEnforcer({
    config: { repoRoot },
    getDb: () => ({}),
    duneDb: { listAllPlayers: async () => ({ rows: [player(), player({ fls_id: secondFlsId, character_name: "Second" })] }) },
    publishKick: async (flsId) => {
      if (flsId === FLS_ID) throw new Error("temporary RMQ failure");
      kicked.push(flsId);
    },
    auditImpl: () => {},
    log: { error: () => {} }
  });
  const result = await enforcer.tick();
  assert.equal(result.enforced, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(kicked, [secondFlsId]);
});

test("an unban racing an active scan wins before a kick is published", async () => {
  const repoRoot = root();
  banPlayer(repoRoot, player());
  let releasePlayers;
  const playersReady = new Promise((resolve) => { releasePlayers = resolve; });
  const kicks = [];
  const enforcer = createPlayerBanEnforcer({
    config: { repoRoot },
    getDb: () => ({}),
    duneDb: { listAllPlayers: async () => playersReady },
    publishKick: async (flsId) => kicks.push(flsId),
    auditImpl: () => {}
  });

  const scan = enforcer.tick();
  unbanPlayer(repoRoot, FLS_ID);
  releasePlayers({ rows: [player()] });
  const result = await scan;

  assert.equal(result.enforced, 0);
  assert.deepEqual(kicks, []);
});
