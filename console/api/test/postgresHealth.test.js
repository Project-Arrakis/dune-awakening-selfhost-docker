import assert from "node:assert/strict";
import test from "node:test";
import { addonOpsPostgresHealth, promScalar } from "../src/duneDb.js";

// Builds a fake fetchImpl that answers Prometheus's own instant-query
// response shape (/api/v1/query) for a fixed map of PromQL query string
// -> scalar value. Mirrors the exact response shape promScalar() parses
// (body.data.result[0].value[1]), not a simplified/reimplemented one.
function fakePrometheusFetch(answers) {
  return async (url) => {
    const parsed = new URL(url);
    const query = parsed.searchParams.get("query");
    if (query === undefined) throw new Error(`Unexpected fetch: ${url}`);
    if (!(query in answers)) {
      return { ok: true, json: async () => ({ status: "success", data: { resultType: "vector", result: [] } }) };
    }
    const value = answers[query];
    return {
      ok: true,
      json: async () => ({
        status: "success",
        data: { resultType: "vector", result: [{ metric: {}, value: [Date.now() / 1000, String(value)] }] }
      })
    };
  };
}

test("promScalar parses a real Prometheus instant-query response", async () => {
  const fetchImpl = fakePrometheusFetch({ "pg_up": 1 });
  const result = await promScalar("http://prom.local:9090", "pg_up", fetchImpl);
  assert.equal(result, 1);
});

test("promScalar returns null when the query result is empty (no metric, not a fabricated 0)", async () => {
  const fetchImpl = fakePrometheusFetch({});
  const result = await promScalar("http://prom.local:9090", "some_missing_metric", fetchImpl);
  assert.equal(result, null);
});

test("promScalar returns null (not a throw) when the fetch itself fails", async () => {
  const result = await promScalar("http://prom.local:9090", "pg_up", async () => { throw new Error("connection refused"); });
  assert.equal(result, null);
});

test("addonOpsPostgresHealth reports the metrics-stack-not-running planned shape when pg_up is unreachable", async () => {
  const fetchImpl = fakePrometheusFetch({});
  const result = await addonOpsPostgresHealth("http://prom.local:9090", fetchImpl);
  assert.equal(result.status, "planned");
  assert.equal(result.reason, "metrics_stack_not_running");
});

test("addonOpsPostgresHealth returns real connection/cache/deadlock data when pg_up is live", async () => {
  const fetchImpl = fakePrometheusFetch({
    "pg_up": 1,
    "sum(pg_stat_activity_count)": 18,
    "sum(pg_settings_max_connections)": 100,
    // Real query strings must match exactly what addonOpsPostgresHealth()
    // sends -- see the assertion for the exact deadlocks query below,
    // which pins the real PromQL string this function issues.
    '100 * (pg_stat_database_blks_hit{datname="dune"} / (pg_stat_database_blks_hit{datname="dune"} + pg_stat_database_blks_read{datname="dune"}))': 98.24,
    'increase(pg_stat_database_deadlocks{datname="dune"}[5m])': 0
  });
  const result = await addonOpsPostgresHealth("http://prom.local:9090", fetchImpl);
  assert.deepEqual(result, {
    up: true,
    connections: { active: 18, max: 100 },
    cacheHitRatioPercent: 98.2,
    deadlocksLast5m: 0
  });
});

test("addonOpsPostgresHealth reports up: false without fabricating connection/cache data when pg_up reports 0", async () => {
  const fetchImpl = fakePrometheusFetch({ "pg_up": 0 });
  const result = await addonOpsPostgresHealth("http://prom.local:9090", fetchImpl);
  assert.equal(result.up, false);
  // Connections/cache/deadlocks are still queried and returned honestly
  // (null, since this fake only answers pg_up) -- addonOpsPostgresHealth
  // does not special-case a down database by omitting the other fields;
  // it queries them the same way regardless, and Prometheus's own
  // absence of a result for those metrics is what produces null here.
  assert.equal(result.connections.active, null);
  assert.equal(result.connections.max, null);
  assert.equal(result.cacheHitRatioPercent, null);
  assert.equal(result.deadlocksLast5m, null);
});

test("addonOpsPostgresHealth uses the exact PromQL from runtime/metrics/rules/postgres.yml's own alert expressions, not an invented variant", async () => {
  // Regression pin: this function's queries must stay byte-identical to
  // the alerting rules' own expressions (per the L1 design doc's
  // explicit goal -- a UI number and an Alertmanager warning must always
  // describe the same underlying query). If this test needs to change,
  // runtime/metrics/rules/postgres.yml changed too and both must move
  // together.
  const seenQueries = [];
  const fetchImpl = async (url) => {
    const query = new URL(url).searchParams.get("query");
    seenQueries.push(query);
    return { ok: true, json: async () => ({ status: "success", data: { result: [{ metric: {}, value: [0, "1"] }] } }) };
  };
  await addonOpsPostgresHealth("http://prom.local:9090", fetchImpl);
  assert.ok(seenQueries.includes("sum(pg_stat_activity_count)"));
  assert.ok(seenQueries.includes("sum(pg_settings_max_connections)"));
  assert.ok(seenQueries.includes('100 * (pg_stat_database_blks_hit{datname="dune"} / (pg_stat_database_blks_hit{datname="dune"} + pg_stat_database_blks_read{datname="dune"}))'));
  assert.ok(seenQueries.includes('increase(pg_stat_database_deadlocks{datname="dune"}[5m])'));
});
