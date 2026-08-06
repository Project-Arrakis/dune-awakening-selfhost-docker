import test from "node:test";
import assert from "node:assert/strict";
import { flushBaseRefillQueues } from "../src/services/baseRefillFlush.js";

test("map-down refill flush waits for both queues and labels their results", async () => {
  const completed = [];
  let releaseWater;
  const waterBlocked = new Promise((resolve) => { releaseWater = resolve; });

  const pending = flushBaseRefillQueues({
    flushGenerators: async () => {
      completed.push("generator");
      return { flushed: [{ baseId: 11, ok: true }] };
    },
    flushWater: async () => {
      await waterBlocked;
      completed.push("water");
      return { flushed: [{ baseId: 22, ok: true }] };
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completed, ["generator"]);
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the map-down hook must remain pending while either queue is flushing");

  releaseWater();
  const result = await pending;
  assert.deepEqual(completed, ["generator", "water"]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.flushed, [
    { baseId: 11, ok: true, refillType: "generator" },
    { baseId: 22, ok: true, refillType: "water" }
  ]);
});

test("a failed queue does not stop the hook waiting for the other queue", async () => {
  let waterFinished = false;
  const result = await flushBaseRefillQueues({
    flushGenerators: async () => { throw new Error("generator database unavailable"); },
    flushWater: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      waterFinished = true;
      return { flushed: [{ baseId: 33, ok: true }] };
    }
  });

  assert.equal(waterFinished, true);
  assert.deepEqual(result.flushed, [{ baseId: 33, ok: true, refillType: "water" }]);
  assert.deepEqual(result.failures, [{ refillType: "generator", error: "generator database unavailable" }]);
});
