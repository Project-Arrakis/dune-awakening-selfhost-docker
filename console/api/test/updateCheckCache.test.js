import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateCheckCache } from "../src/services/updateCheckCache.js";

test("update check cache reuses a completed result within the TTL", async () => {
  let currentTime = 1000;
  let collections = 0;
  const cache = createUpdateCheckCache({}, {
    cacheMs: 10000,
    now: () => currentTime,
    collect: async () => ({ code: 0, stdout: `build-${++collections}` })
  });

  const first = await cache.read();
  assert.equal(collections, 1);
  assert.equal(first.fromCache, false);

  currentTime += 5000;
  const cached = await cache.read();
  assert.equal(collections, 1);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.stdout, "build-1");

  currentTime += 5001;
  const refreshed = await cache.read();
  assert.equal(collections, 2);
  assert.equal(refreshed.fromCache, false);
  assert.equal(refreshed.stdout, "build-2");
});

test("update check cache coalesces overlapping and forced reads onto one in-flight collection", async () => {
  let release;
  let collections = 0;
  const cache = createUpdateCheckCache({}, {
    collect: () => {
      collections += 1;
      return new Promise((resolve) => { release = resolve; });
    }
  });

  const first = cache.read();
  const overlapping = cache.read({ fresh: true });
  await Promise.resolve();
  assert.equal(collections, 1);

  release({ code: 0, stdout: "build-result" });
  const firstResult = await first;
  const overlappingResult = await overlapping;

  assert.equal(firstResult.stdout, "build-result");
  assert.equal(overlappingResult.stdout, "build-result");
  assert.equal(firstResult.code, overlappingResult.code);
});

test("update check cache does not cache a rejected collection", async () => {
  let collections = 0;
  let shouldReject = true;
  const cache = createUpdateCheckCache({}, {
    collect: async () => {
      collections += 1;
      if (shouldReject) {
        throw new Error("steamcmd timeout");
      }
      return { code: 0, stdout: "build-success" };
    }
  });

  await assert.rejects(() => cache.read(), /steamcmd timeout/);
  assert.equal(collections, 1);

  shouldReject = false;
  const result = await cache.read();
  assert.equal(collections, 2);
  assert.equal(result.stdout, "build-success");
});

test("invalidate clears the cached result and forces the next read to recollect", async () => {
  let collections = 0;
  const cache = createUpdateCheckCache({}, {
    cacheMs: 10000,
    collect: async () => ({ code: 0, stdout: `build-${++collections}` })
  });

  const first = await cache.read();
  assert.equal(collections, 1);

  cache.invalidate();

  const second = await cache.read();
  assert.equal(collections, 2);
  assert.equal(second.stdout, "build-2");
});

test("invalidate prevents an older in-flight collection from repopulating the cache", async () => {
  const releases = [];
  let collections = 0;
  const cache = createUpdateCheckCache({}, {
    cacheMs: 10000,
    collect: () => {
      collections += 1;
      return new Promise((resolve) => releases.push(resolve));
    }
  });

  const staleRead = cache.read();
  await Promise.resolve();
  assert.equal(collections, 1);

  cache.invalidate();
  const currentRead = cache.read();
  await Promise.resolve();
  assert.equal(collections, 2, "a post-invalidation read must not join stale in-flight work");

  releases[1]({ code: 0, stdout: "current-build" });
  await currentRead;
  assert.equal(cache.peek()?.stdout, "current-build");

  releases[0]({ code: 0, stdout: "stale-build" });
  await staleRead;
  assert.equal(cache.peek()?.stdout, "current-build", "stale work must not overwrite the current cache");
});

test("peek returns null before anything has been cached", () => {
  let collections = 0;
  const cache = createUpdateCheckCache({}, {
    collect: async () => ({ code: 0, stdout: `build-${++collections}` })
  });

  const result = cache.peek();
  assert.equal(result, null);
  assert.equal(collections, 0);
});

test("peek returns the cached entry within the TTL without invoking collect", async () => {
  let currentTime = 1000;
  let collections = 0;
  const cache = createUpdateCheckCache({}, {
    cacheMs: 10000,
    now: () => currentTime,
    collect: async () => ({ code: 0, stdout: `build-${++collections}` })
  });

  const first = await cache.read();
  assert.equal(collections, 1);

  currentTime += 5000;
  const peeked = cache.peek();
  assert.notEqual(peeked, null);
  assert.equal(peeked.fromCache, true);
  assert.equal(peeked.stdout, "build-1");
  assert.equal(collections, 1);
});

test("peek returns null once the cached entry is past its TTL", async () => {
  let currentTime = 1000;
  let collections = 0;
  const cache = createUpdateCheckCache({}, {
    cacheMs: 10000,
    now: () => currentTime,
    collect: async () => ({ code: 0, stdout: `build-${++collections}` })
  });

  await cache.read();
  assert.equal(collections, 1);

  currentTime += 10001;
  const result = cache.peek();
  assert.equal(result, null);
});

test("completed update checks survive a Console restart and invalidation removes the durable cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dune-update-check-cache-"));
  const cacheFile = join(dir, "game-update-check.json");
  let currentTime = 1000;
  let collections = 0;
  const firstProcess = createUpdateCheckCache({}, {
    cacheFile,
    cacheMs: 30000,
    now: () => currentTime,
    collect: async () => ({ code: 100, stdout: `build-${++collections}`, stderr: "" })
  });

  const live = await firstProcess.read();
  assert.equal(live.fromCache, false);
  assert.equal(existsSync(cacheFile), true);

  currentTime += 1000;
  const restartedProcess = createUpdateCheckCache({}, {
    cacheFile,
    cacheMs: 30000,
    now: () => currentTime,
    collect: async () => { throw new Error("durable cache should be reused"); }
  });
  const restored = await restartedProcess.read();
  assert.equal(restored.fromCache, true);
  assert.equal(restored.code, 100);
  assert.equal(restored.stdout, "build-1");

  restartedProcess.invalidate();
  assert.equal(existsSync(cacheFile), false);
  assert.equal(restartedProcess.peek(), null);
});

test("a malformed durable update-check cache fails closed and recollects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dune-update-check-cache-invalid-"));
  const cacheFile = join(dir, "game-update-check.json");
  writeFileSync(cacheFile, JSON.stringify({ code: 7, sampledAtMs: 1000, stdout: "bad" }));
  const cache = createUpdateCheckCache({}, {
    cacheFile,
    now: () => 2000,
    collect: async () => ({ code: 0, stdout: "fresh", stderr: "" })
  });

  const result = await cache.read();
  assert.equal(result.fromCache, false);
  assert.equal(result.stdout, "fresh");
});

test("peek returns null immediately after invalidate", async () => {
  let collections = 0;
  const cache = createUpdateCheckCache({}, {
    cacheMs: 10000,
    collect: async () => ({ code: 0, stdout: `build-${++collections}` })
  });

  const first = await cache.read();
  assert.notEqual(cache.peek(), null);

  cache.invalidate();

  assert.equal(cache.peek(), null);
});
