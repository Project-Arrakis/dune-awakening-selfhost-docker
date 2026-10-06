import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Issue #1116: every route that reaches duneDb.listPlayers must pass a
// controllerIds scope. Wiring guard only; behaviour is in playerScope.test.js
// and db.test.js.
const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

for (const route of ["/api/players", "/api/players/online", "/api/players/search"]) {
  test(`${route} passes a player scope to listPlayers (issue #1116)`, () => {
    const start = source.indexOf(`path === "${route}"`);
    assert.ok(start >= 0, `route ${route} found`);
    assert.match(source.slice(start, start + 900), /controllerIds/);
  });
}

test("/api/players uses the session handleApi already authenticated, not a cookie-only re-read", () => {
  const start = source.indexOf('path === "/api/players") return dbJson');
  assert.ok(start >= 0);
  assert.doesNotMatch(source.slice(start, start + 300), /auth\.readSession/);
});
