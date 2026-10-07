import test from "node:test";
import assert from "node:assert/strict";
import { resolvePlayerScope } from "../src/playerScope.js";

const linked = async () => [{ player_controller_id: "5" }, { player_controller_id: 0 }, { player_controller_id: null }, { player_controller_id: "" }, { player_controller_id: 9 }];

test("non-player principals are unscoped, including sessions with no userId (password/API-key/write-bridge owner)", async () => {
  for (const session of [{ tier: "owner", userId: "" }, { tier: "owner" }, { tier: "admin", userId: "1" }, { tier: "moderator", userId: "1" }]) {
    const scope = await resolvePlayerScope(session, linked);
    assert.equal(scope.scoped, false, JSON.stringify(session));
  }
});

test("a player session is scoped to its linked controllers, dropping placeholder ids", async () => {
  const scope = await resolvePlayerScope({ tier: "player", userId: "u1" }, linked);
  assert.equal(scope.scoped, true);
  assert.deepEqual([...scope.ids].sort(), ["5", "9"]);
});

test("a player with no userId, no links, or a failing lookup sees nothing and a failure is logged", async () => {
  assert.deepEqual([...(await resolvePlayerScope({ tier: "player", userId: "" }, linked)).ids], []);
  assert.deepEqual([...(await resolvePlayerScope({ tier: "player", userId: "u" }, async () => [])).ids], []);
  const logs = [];
  const failed = await resolvePlayerScope({ tier: "player", userId: "u" }, async () => { throw new Error("db down"); }, (m) => logs.push(m));
  assert.equal(failed.scoped, true);
  assert.equal(failed.ids.size, 0);
  assert.match(logs[0], /db down/);
});

test("a missing session fails closed", async () => {
  const scope = await resolvePlayerScope(null, linked);
  assert.equal(scope.scoped, true);
  assert.equal(scope.ids.size, 0);
});

test("a legacy observer-tier session is scoped exactly like a player", async () => {
  const scope = await resolvePlayerScope({ tier: "observer", userId: "u1" }, linked);
  assert.equal(scope.scoped, true);
  assert.deepEqual([...scope.ids].sort(), ["5", "9"]);
});
