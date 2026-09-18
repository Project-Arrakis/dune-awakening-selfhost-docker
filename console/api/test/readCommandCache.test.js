import test from "node:test";
import assert from "node:assert/strict";
import { createReadCommandCache } from "../src/services/readCommandCache.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("concurrent readers share one in-flight command and its result", async () => {
  const gate = deferred();
  const cache = createReadCommandCache();
  let runs = 0;
  const work = () => { runs += 1; return gate.promise; };

  const readers = [cache.run("ready", work), cache.run("ready", work), cache.run("ready", work)];
  gate.resolve({ stdout: "READY" });

  assert.deepEqual(await Promise.all(readers), [
    { stdout: "READY" },
    { stdout: "READY" },
    { stdout: "READY" }
  ]);
  assert.equal(runs, 1);
});

test("a short-lived result cache absorbs sequential browser refreshes", async () => {
  let now = 1000;
  let runs = 0;
  const cache = createReadCommandCache({ ttlMs: 2000, clock: () => now });
  const work = async () => ({ run: ++runs });

  assert.deepEqual(await cache.run("status", work), { run: 1 });
  now = 2999;
  assert.deepEqual(await cache.run("status", work), { run: 1 });
  now = 3000;
  assert.deepEqual(await cache.run("status", work), { run: 2 });
});

test("different command arguments never share a result", async () => {
  const cache = createReadCommandCache();
  let runs = 0;
  const work = async () => ++runs;

  assert.equal(await cache.run('["maps","one"]', work), 1);
  assert.equal(await cache.run('["maps","two"]', work), 2);
});

test("failed commands are not cached and can be retried", async () => {
  const cache = createReadCommandCache();
  let runs = 0;

  await assert.rejects(() => cache.run("ready", async () => {
    runs += 1;
    throw new Error("Docker is busy");
  }), /Docker is busy/);

  assert.equal(await cache.run("ready", async () => ++runs), 2);
});
