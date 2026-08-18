import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  addonOpsHealthPlayers,
  addonOpsHealthFarms,
  addonOpsHealthSummary,
  addonOpsHealthSummaryV2,
  addonOpsActivitySummary,
  addonOpsResourcesSummary,
  addonOpsCombatDeaths,
  addonOpsEconomySummary,
  addonOpsInventorySummary,
  addonOpsSocSummary,
  addonOpsPrometheusHealth,
  addonOpsContainerHealth,
  addonOpsPostgresHealth,
  addonOpsRabbitmqHealth
} from "../src/duneDb.js";

// dune-awakening-selfhost-docker#308: no test in this repo (or
// dune-ops-observability-addon) ever asserted that distinct ops.*
// addon-bridge actions return distinct, non-overlapping payload shapes.
//
// This is a real, separate gap from the 2026-08-10 containerHealth
// incident (a missing `if (` causing every unmatched bridge action to
// silently fall through to a DIFFERENT commit's handler) -- that
// specific historical bug was actually a hard SyntaxError crashing the
// whole module at import time (confirmed via `node --check` against the
// exact broken commit, 5f8310bb), not two actions returning each
// other's data at runtime. A shape-contract test like this one would
// NOT have caught that specific incident (nothing would run at all, the
// module fails to import) -- see the HTTP-level dispatch smoke test in
// bridgeActionDispatch.test.js for the test that catches THAT class of
// bug. This test catches a different, equally real risk: a future
// `if`-chain reordering or copy-paste bug that IS syntactically valid
// but silently routes one action's real handler call to a different
// action's discriminator-bearing response shape.
//
// Uses this file's own sibling bridgeIntegration.test.js's exact
// getDb()/skip-if-unavailable pattern -- every one of these functions
// (except the 4 non-SQL ones) calls db.query() directly with no
// try/catch around the connection itself, so this test genuinely cannot
// run meaningfully without a real Postgres reachable (confirmed by
// reading tableExists()'s implementation directly: it has no
// connection-level error handling of its own). This repo's own CI
// (.github/workflows/ci.yml) runs a real postgres:17-alpine service
// alongside `npm test`, so this test executes for real there even
// though it may skip in a sandbox with no local Postgres.
let db = null;

async function getDb() {
  if (db) return db;
  try {
    const { createDb } = await import("../src/db.js");
    db = createDb({});
    return db;
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND") {
      console.log("Skipping bridge-action contract tests — pg module not installed (npm ci)");
      return null;
    }
    throw e;
  }
}

// addonOpsPrometheusHealth() calls the real global fetch() directly (no
// fetchImpl injection point, unlike addonOpsPostgresHealth()/
// addonOpsRabbitmqHealth()) -- to genuinely exercise its "healthy" shape
// (not just its shared metricsStackNotRunning() fallback, which is
// deliberately, correctly identical across all 3 Prometheus-backed
// actions when the stack isn't running -- not a defect to catch), this
// test stands up a tiny real local HTTP server answering Prometheus's
// own real endpoint shapes (/-/healthy, /api/v1/targets, /api/v1/query)
// and points all 3 Prometheus-backed actions at it -- both via
// fetchImpl injection (postgres/rabbitmq) and via the real global fetch
// (prometheus itself, since promBaseUrl is a real reachable localhost
// URL here, not a fake one that would 404/ECONNREFUSED).
function startFakePrometheus() {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/-/healthy") {
        res.writeHead(200);
        res.end("OK");
        return;
      }
      if (req.url === "/api/v1/targets") {
        res.writeHead(200);
        res.end(JSON.stringify({ data: { activeTargets: [{ labels: { job: "dune-prometheus" }, health: "up" }] } }));
        return;
      }
      if (req.url.startsWith("/api/v1/query")) {
        // A single generic scalar answer is sufficient for every
        // PromQL query this test's 3 target functions issue -- this
        // test verifies response SHAPE (which fields exist), not real
        // metric values (covered by each function's own dedicated
        // unit tests already).
        res.writeHead(200);
        res.end(JSON.stringify({ data: { result: [{ metric: { service: "rabbitmq-admin" }, value: [0, "1"] }] } }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => resolvePromise(server));
  });
}

async function fetchViaFakePrometheus(fakeBaseUrl) {
  return async (url, options) => {
    const relative = String(url).replace(/^https?:\/\/[^/]+/, "");
    return fetch(`${fakeBaseUrl}${relative}`, options);
  };
}

// A field name unique to that action's own response shape, confirmed by
// direct reading of each function's real return statement / empty*()
// fallback in duneDb.js -- not guessed. Absence of a discriminator in
// this map for a given action is itself a signal that action's shape
// needs a distinguishing field added before this contract can cover it.
const DISCRIMINATORS = {
  "ops.health.players": "combinations",
  "ops.health.farms": "connectedPlayers",
  "ops.activity.summary": "activeLast1h",
  "ops.resources.summary": "deepDesert",
  "ops.combat.deaths": "kdRatio",
  "ops.economy.summary": "activeOrders",
  "ops.inventory.summary": "totalCrafted",
  "ops.soc.summary": "platformHealth",
  "ops.health.prometheus": "targets",
  "ops.health.containers": "containers",
  "ops.health.postgres": "cacheHitRatioPercent",
  "ops.health.rabbitmq": "queueDepth"
};

test("distinct ops.* addon-bridge actions return non-overlapping payload shapes", async (t) => {
  const database = await getDb();
  if (!database) return;

  const fakeProm = await startFakePrometheus();
  const fakeBaseUrl = `http://127.0.0.1:${fakeProm.address().port}`;
  const fakeFetch = await fetchViaFakePrometheus(fakeBaseUrl);

  let results;
  try {
    results = {
      "ops.health.players": await addonOpsHealthPlayers(database),
      "ops.health.farms": await addonOpsHealthFarms(database),
      "ops.activity.summary": await addonOpsActivitySummary(database),
      "ops.resources.summary": await addonOpsResourcesSummary(database, {}),
      "ops.combat.deaths": await addonOpsCombatDeaths(database),
      "ops.economy.summary": await addonOpsEconomySummary(database),
      "ops.inventory.summary": await addonOpsInventorySummary(database),
      "ops.soc.summary": addonOpsSocSummary(),
      // addonOpsPrometheusHealth() has no fetchImpl injection point --
      // it calls the real global fetch() directly -- so pointing it at
      // a genuinely-reachable local fake server (not a fake fetchImpl)
      // is the only way to exercise its real "healthy" shape rather
      // than its shared, deliberately-identical "not running" fallback.
      "ops.health.prometheus": await addonOpsPrometheusHealth(fakeBaseUrl),
      "ops.health.containers": await addonOpsContainerHealth({ projectName: "", run: async () => "" }),
      "ops.health.postgres": await addonOpsPostgresHealth(fakeBaseUrl, fakeFetch),
      "ops.health.rabbitmq": await addonOpsRabbitmqHealth(fakeBaseUrl, fakeFetch)
    };
  } finally {
    fakeProm.close();
  }

  await t.test("every action's response carries its own discriminator field", () => {
    for (const [action, discriminator] of Object.entries(DISCRIMINATORS)) {
      assert.ok(
        discriminator in results[action],
        `${action}'s response is missing its own discriminator field "${discriminator}" -- this action's real shape may have changed; update DISCRIMINATORS to match`
      );
    }
  });

  await t.test("no action's response carries a DIFFERENT action's discriminator field", () => {
    for (const [action, result] of Object.entries(results)) {
      for (const [otherAction, otherDiscriminator] of Object.entries(DISCRIMINATORS)) {
        if (otherAction === action) continue;
        assert.ok(
          !(otherDiscriminator in result),
          `${action}'s response incorrectly contains ${otherAction}'s discriminator field "${otherDiscriminator}" -- ` +
          `this is exactly the defect class a dispatcher-wiring bug (e.g. an if-chain reordering) could introduce: ` +
          `${action} silently returning ${otherAction}'s shape`
        );
      }
    }
  });
});

// ops.health.summary / ops.health.summary.v2 are themselves composite
// wrappers around addonOpsHealthPlayers()/addonOpsHealthFarms() (see
// addonOpsHealthSummaryV2() in duneDb.js) -- their contract is "contains
// both sub-shapes, nested," not "carries its own unique flat
// discriminator," so they're verified separately rather than folded
// into the flat DISCRIMINATORS map above (which would produce a
// misleading "V2 leaked a field" false positive, since it's SUPPOSED to
// contain both).
test("ops.health.summary and ops.health.summary.v2 both return the real nested {players, farms} composite shape", async () => {
  const database = await getDb();
  if (!database) return;

  const v2 = await addonOpsHealthSummaryV2(database);
  assert.ok("players" in v2 && "farms" in v2);
  assert.ok("combinations" in v2.players, "nested players shape must be the real addonOpsHealthPlayers() shape");
  assert.ok("connectedPlayers" in v2.farms, "nested farms shape must be the real addonOpsHealthFarms() shape");

  const summary = await addonOpsHealthSummary(database);
  assert.deepEqual(summary, v2, "ops.health.summary must be identical to ops.health.summary.v2 (addonOpsHealthSummary() is a direct passthrough)");
});
