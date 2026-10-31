import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ownMapPlayerRows, mapPlayersForSession } from "../src/playerScope.js";

// Two seeded players: a `player` session must get its own marker and never the
// other player's name, FLS id, Funcom id, account id or position (#1276).
const rows = [
  { id: 1001, name: "Alice", fls_id: "FLS-A", funcom_id: "F-A", account_id: 11, x: 1, y: 2, z: 3 },
  { id: 0, name: "Ghost", fls_id: "FLS-0", x: 0, y: 0, z: 0 },
  { id: 2002, name: "Bob", fls_id: "FLS-B", funcom_id: "F-B", account_id: 22, x: 9, y: 8, z: 7 },
];

test("a linked player gets only their own marker", () => {
  const out = ownMapPlayerRows(rows, "1001");
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Alice");
  assert.ok(!JSON.stringify(out).includes("Bob"));
  assert.ok(!JSON.stringify(out).includes("FLS-B"));
});

test("fail closed: unlinked, zero, empty or unmatched pawn ids return nothing", () => {
  for (const own of ["", "0", null, undefined, "abc", "9999", NaN]) {
    assert.deepEqual(ownMapPlayerRows(rows, own), [], String(own));
  }
});

test("non-array input returns nothing instead of throwing", () => {
  for (const bad of [null, undefined, {}, "x"]) assert.deepEqual(ownMapPlayerRows(bad, "1001"), []);
});

test("the /api/map/players route filters through ownMapPlayerRows for the player tier", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => l.includes('path === "/api/map/players"'));
  assert.ok(line, "route not found");
  assert.match(line, /liveMapPlayersForSession\(/);
  assert.match(src, /async function liveMapPlayersForSession[\s\S]{0,600}mapPlayersForSession\(/);
});

const result = { capabilities: { players: true }, rows };

test("session helper: player tier is filtered to its linked pawn", async () => {
  const out = await mapPlayersForSession({ tier: "player", userId: "d1" }, result, async (id) => (id === "d1" ? { player_pawn_id: "1001" } : null));
  assert.deepEqual(out.rows.map((r) => r.name), ["Alice"]);
});

test("session helper: unlinked player gets nothing", async () => {
  const out = await mapPlayersForSession({ tier: "player", userId: "d2" }, result, async () => null);
  assert.deepEqual(out.rows, []);
});

test("session helper: other tiers see the whole map unchanged", async () => {
  for (const tier of ["moderator", "admin", "owner"]) {
    const out = await mapPlayersForSession({ tier, userId: "x" }, result, async () => { throw new Error("must not look up a link"); });
    assert.equal(out, result);
  }
});
