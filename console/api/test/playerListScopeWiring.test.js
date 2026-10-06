import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Issue #1116: every route that reaches duneDb.listPlayers from a player-tier
// session must pass a controllerIds scope, or an empty/unlinked player sees
// the whole server. This is a source-wiring guard, not a behavioral test; the
// behavior of listPlayers itself is covered in db.test.js.
const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

for (const route of ["/api/players", "/api/players/online", "/api/players/search"]) {
  test(`${route} passes a player scope to listPlayers (issue #1116)`, () => {
    const start = source.indexOf(`path === "${route}"`);
    assert.ok(start >= 0, `route ${route} found`);
    const block = source.slice(start, start + 900);
    assert.match(block, /controllerIds/, `${route} must scope listPlayers by controllerIds`);
  });
}

test("player scope drops placeholder controller ids (issue #1116)", () => {
  assert.match(source, /String\(id\) !== "0"/);
});
