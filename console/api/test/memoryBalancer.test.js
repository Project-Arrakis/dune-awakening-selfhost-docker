import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerStatsSampler, createMemoryBalancer, dockerMemoryUpdateArgs, parseDockerStatsRow } from "../src/services/memoryBalancer.js";

test("memory balancer updates Docker swap limit with memory limit", () => {
  assert.deepEqual(dockerMemoryUpdateArgs("dune-server-overmap", 2 * 1024 ** 3), [
    "update",
    "--memory",
    "2048m",
    "--memory-swap",
    "2048m",
    "--memory-reservation",
    "2048m",
    "dune-server-overmap"
  ]);
});

test("memory balancer parses docker stats rows", () => {
  const row = parseDockerStatsRow(JSON.stringify({
    Name: "dune-server-overmap",
    MemUsage: "1.5GiB / 2GiB",
    MemPerc: "75.00%"
  }));
  assert.equal(row.container, "dune-server-overmap");
  assert.equal(row.map, "Overmap");
  assert.equal(row.percent, 75);
});

test("memory balancer canonicalizes DeepDesert containers", () => {
  const row = parseDockerStatsRow(JSON.stringify({
    Name: "dune-server-deepdesert-1-8",
    MemUsage: "3GiB / 16GiB",
    MemPerc: "18.75%"
  }));
  assert.equal(row.container, "dune-server-deepdesert-1-8");
  assert.equal(row.map, "DeepDesert_1");
});

test("live memory sampler caches completed Docker stats collections", async () => {
  let currentTime = 1000;
  let collections = 0;
  const sampler = createDockerStatsSampler({}, {
    cacheMs: 10000,
    now: () => currentTime,
    collect: async () => [{ container: `sample-${++collections}` }]
  });

  const first = await sampler.read();
  currentTime += 5000;
  const cached = await sampler.read();
  assert.equal(collections, 1);
  assert.strictEqual(cached, first);

  currentTime += 5001;
  const refreshed = await sampler.read();
  assert.equal(collections, 2);
  assert.notStrictEqual(refreshed, first);
});

test("live memory sampler coalesces overlapping and forced collections", async () => {
  let release;
  let collections = 0;
  const sampler = createDockerStatsSampler({}, {
    collect: () => {
      collections += 1;
      return new Promise((resolve) => { release = resolve; });
    }
  });

  const first = sampler.read();
  const overlapping = sampler.read({ fresh: true });
  await Promise.resolve();
  assert.equal(collections, 1);
  release([{ container: "dune-server-overmap" }]);
  assert.strictEqual(await overlapping, await first);

  const forced = sampler.read({ fresh: true });
  await Promise.resolve();
  assert.equal(collections, 2);
  release([{ container: "dune-server-survival-1" }]);
  await forced;
});

test("memory balancer persists enabled state across restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "dune-memory-balancer-"));
  const generatedDir = join(root, "runtime/generated");
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(generatedDir, "memory-balancer.json"), JSON.stringify({ enabled: true }));

  const balancer = createMemoryBalancer({ repoRoot: root, generatedDir });
  assert.equal(balancer.publicState().enabled, true);

  await balancer.setEnabled(false);
  assert.equal(JSON.parse(readFileSync(join(generatedDir, "memory-balancer.json"), "utf8")).enabled, false);

  rmSync(root, { recursive: true, force: true });
});
