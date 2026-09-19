import { readFileSync, rmSync, statSync } from "node:fs";
import { writeJsonAtomic } from "../jsonStore.js";

const MAX_PERSISTED_CACHE_BYTES = 64 * 1024;

export function createUpdateCheckCache(config, options = {}) {
  const collect = options.collect; // required, injected by caller
  const now = options.now || Date.now;
  const cacheMs = Math.max(0, Number(options.cacheMs ?? config.updateCheckCacheMs ?? 30 * 60 * 1000));
  const cacheFile = options.cacheFile === undefined ? config.updateCheckCacheFile : options.cacheFile;
  let cached = null;
  let inFlight = null;
  let generation = 0;
  let diskLoaded = false;

  function loadDiskCache() {
    if (diskLoaded) return;
    diskLoaded = true;
    if (!cacheFile) return;
    try {
      if (statSync(cacheFile).size > MAX_PERSISTED_CACHE_BYTES) return;
      cached = normalizeEntry(JSON.parse(readFileSync(cacheFile, "utf8")));
    } catch {
      cached = null;
    }
  }

  function persist(entry) {
    if (!cacheFile) return;
    try {
      writeJsonAtomic(cacheFile, entry, 0o600);
    } catch {
      // A read-only runtime directory must not make a successful Steam check
      // fail. The current process can still reuse its in-memory result.
    }
  }

  async function read(readOptions = {}) {
    loadDiskCache();
    const currentTime = now();
    if (!readOptions.fresh && cached && currentTime - cached.sampledAtMs < cacheMs) {
      return { ...cached, fromCache: true };
    }
    if (inFlight?.generation === generation) {
      return inFlight.promise.then((entry) => ({ ...entry, fromCache: false }));
    }
    const collectionGeneration = generation;
    const pending = Promise.resolve().then(collect).then((result) => {
      const sampledAtMs = now();
      const entry = { ...result, sampledAtMs, sampledAt: new Date(sampledAtMs).toISOString() };
      if (collectionGeneration === generation) {
        cached = entry;
        persist(entry);
      }
      return entry;
    }).finally(() => {
      if (inFlight?.promise === pending) inFlight = null;
    });
    inFlight = { generation: collectionGeneration, promise: pending };
    return pending.then((entry) => ({ ...entry, fromCache: false }));
  }

  function peek() {
    loadDiskCache();
    const currentTime = now();
    if (cached && currentTime - cached.sampledAtMs < cacheMs) {
      return { ...cached, fromCache: true };
    }
    return null;
  }

  function invalidate() {
    generation += 1;
    cached = null;
    diskLoaded = true;
    if (cacheFile) {
      try { rmSync(cacheFile, { force: true }); } catch { /* best effort */ }
    }
  }
  return { read, peek, invalidate };
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid update-check cache");
  const code = Number(value.code);
  const sampledAtMs = Number(value.sampledAtMs);
  if (![0, 100].includes(code) || !Number.isFinite(sampledAtMs) || sampledAtMs <= 0) {
    throw new Error("Invalid update-check cache");
  }
  const stdout = typeof value.stdout === "string" ? value.stdout : "";
  const stderr = typeof value.stderr === "string" ? value.stderr : "";
  if (stdout.length + stderr.length > MAX_PERSISTED_CACHE_BYTES) throw new Error("Update-check cache is too large");
  return {
    code,
    stdout,
    stderr,
    sampledAtMs,
    sampledAt: new Date(sampledAtMs).toISOString()
  };
}
