import assert from "node:assert/strict";
import test from "node:test";
import { addonOpsRabbitmqHealth, promVector } from "../src/duneDb.js";

// Builds a fake fetchImpl answering Prometheus's own instant-query
// response shape for a fixed map of PromQL query string -> either a
// scalar value (wrapped as a single-entry vector) or a full vector
// (array of { metric, value } entries, for rabbitmq_up's real
// per-instance shape).
function fakePrometheusFetch(answers) {
  return async (url) => {
    const query = new URL(url).searchParams.get("query");
    if (!(query in answers)) {
      return { ok: true, json: async () => ({ status: "success", data: { resultType: "vector", result: [] } }) };
    }
    const answer = answers[query];
    const result = Array.isArray(answer)
      ? answer
      : [{ metric: {}, value: [Date.now() / 1000, String(answer)] }];
    return { ok: true, json: async () => ({ status: "success", data: { resultType: "vector", result } }) };
  };
}

test("promVector returns the real per-instance result array, not reduced to a single value", async () => {
  const fetchImpl = fakePrometheusFetch({
    "rabbitmq_up": [
      { metric: { service: "rabbitmq-admin" }, value: [0, "1"] },
      { metric: { service: "rabbitmq-game" }, value: [0, "1"] }
    ]
  });
  const result = await promVector("http://prom.local:9090", "rabbitmq_up", fetchImpl);
  assert.equal(result.length, 2);
  assert.equal(result[0].metric.service, "rabbitmq-admin");
  assert.equal(result[1].metric.service, "rabbitmq-game");
});

test("promVector returns an empty array (not a throw) when the fetch itself fails", async () => {
  const result = await promVector("http://prom.local:9090", "rabbitmq_up", async () => { throw new Error("connection refused"); });
  assert.deepEqual(result, []);
});

test("addonOpsRabbitmqHealth reports the metrics-stack-not-running planned shape when rabbitmq_up is unreachable", async () => {
  const fetchImpl = fakePrometheusFetch({});
  const result = await addonOpsRabbitmqHealth("http://prom.local:9090", fetchImpl);
  assert.equal(result.status, "planned");
  assert.equal(result.reason, "metrics_stack_not_running");
});

test("addonOpsRabbitmqHealth returns real per-instance up state, queue depth, memory%, and fd% when live", async () => {
  const fetchImpl = fakePrometheusFetch({
    "min(rabbitmq_up)": 1,
    "rabbitmq_up": [
      { metric: { service: "rabbitmq-admin" }, value: [0, "1"] },
      { metric: { service: "rabbitmq-game" }, value: [0, "1"] }
    ],
    "sum(rabbitmq_queue_messages_ready)": 40,
    "sum(rabbitmq_queue_messages_unacked)": 2,
    "100 * max(rabbitmq_process_resident_memory_bytes / rabbitmq_resident_memory_limit_bytes)": 12.345,
    "100 * max(rabbitmq_process_open_fds / rabbitmq_process_max_fds)": 4.1
  });
  const result = await addonOpsRabbitmqHealth("http://prom.local:9090", fetchImpl);
  assert.deepEqual(result, {
    up: true,
    instances: [
      { name: "rabbitmq-admin", up: true },
      { name: "rabbitmq-game", up: true }
    ],
    queueDepth: 42,
    memPercent: 12.3,
    fdPercent: 4.1
  });
});

test("addonOpsRabbitmqHealth reports a down instance honestly, not silently omitted", async () => {
  const fetchImpl = fakePrometheusFetch({
    "min(rabbitmq_up)": 0,
    "rabbitmq_up": [
      { metric: { service: "rabbitmq-admin" }, value: [0, "1"] },
      { metric: { service: "rabbitmq-game" }, value: [0, "0"] }
    ]
  });
  const result = await addonOpsRabbitmqHealth("http://prom.local:9090", fetchImpl);
  assert.equal(result.up, false, "min(rabbitmq_up) == 0 means at least one instance is down");
  assert.deepEqual(result.instances, [
    { name: "rabbitmq-admin", up: true },
    { name: "rabbitmq-game", up: false }
  ]);
});

test("addonOpsRabbitmqHealth's queueDepth is null (not 0) when Prometheus has no data for either query", async () => {
  const fetchImpl = fakePrometheusFetch({
    "min(rabbitmq_up)": 1,
    "rabbitmq_up": [{ metric: { service: "rabbitmq-admin" }, value: [0, "1"] }]
    // sum(rabbitmq_queue_messages_ready)/unacked deliberately absent --
    // both promScalar() calls return null.
  });
  const result = await addonOpsRabbitmqHealth("http://prom.local:9090", fetchImpl);
  assert.equal(result.queueDepth, null, "must not fabricate 0 when both underlying queries are genuinely unavailable");
});

test("addonOpsRabbitmqHealth uses the exact PromQL from runtime/metrics/rules/rabbitmq.yml's own alert expressions, not an invented variant", async () => {
  const seenQueries = [];
  const fetchImpl = async (url) => {
    const query = new URL(url).searchParams.get("query");
    seenQueries.push(query);
    return { ok: true, json: async () => ({ status: "success", data: { result: [{ metric: { service: "x" }, value: [0, "1"] }] } }) };
  };
  await addonOpsRabbitmqHealth("http://prom.local:9090", fetchImpl);
  assert.ok(seenQueries.includes("sum(rabbitmq_queue_messages_ready)"));
  assert.ok(seenQueries.includes("sum(rabbitmq_queue_messages_unacked)"));
  assert.ok(seenQueries.includes("100 * max(rabbitmq_process_resident_memory_bytes / rabbitmq_resident_memory_limit_bytes)"));
  assert.ok(seenQueries.includes("100 * max(rabbitmq_process_open_fds / rabbitmq_process_max_fds)"));
});
