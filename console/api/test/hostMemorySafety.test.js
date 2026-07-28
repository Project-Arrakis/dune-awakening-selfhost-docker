import test from "node:test";
import assert from "node:assert/strict";
import { calculateAlwaysOnHostMemorySafety } from "../src/services/hostMemorySafety.js";

const GIB = 1024 ** 3;

test("limits a 30 GiB host to one concurrent heavy map startup", () => {
  assert.deepEqual(calculateAlwaysOnHostMemorySafety(30 * GIB), {
    physicalMemoryGiB: 30,
    reserveGiB: 5,
    recommendedParallelism: 1
  });
});

test("scales startup parallelism with physical memory while preserving headroom", () => {
  assert.deepEqual(calculateAlwaysOnHostMemorySafety(64 * GIB), {
    physicalMemoryGiB: 64,
    reserveGiB: 10,
    recommendedParallelism: 3
  });
  assert.equal(calculateAlwaysOnHostMemorySafety(256 * GIB).recommendedParallelism, 13);
});

test("honors a configured host reserve and handles tiny hosts safely", () => {
  assert.equal(calculateAlwaysOnHostMemorySafety(64 * GIB, "16").reserveGiB, 16);
  assert.equal(calculateAlwaysOnHostMemorySafety(2 * GIB).recommendedParallelism, 1);
});
