export function createReadCommandCache({ ttlMs = 2000, staleMs = 0, maxEntries = 128, clock = Date.now } = {}) {
  const entries = new Map();

  function prune(now) {
    for (const [key, entry] of entries) {
      if (!entry.promise && (entry.staleUntil ?? entry.expiresAt) <= now) entries.delete(key);
    }
    if (entries.size >= maxEntries) {
      for (const [key, entry] of entries) {
        if (!entry.promise) entries.delete(key);
        if (entries.size < maxEntries) break;
      }
    }
  }

  function start(key, work, previous = null) {
    const promise = Promise.resolve().then(work);
    entries.set(key, { ...(previous || {}), promise });
    promise.then((value) => {
      if (entries.get(key)?.promise === promise) {
        const expiresAt = clock() + ttlMs;
        entries.set(key, { value, expiresAt, staleUntil: expiresAt + staleMs });
      }
    }, () => {
      if (entries.get(key)?.promise !== promise) return;
      if (previous) entries.set(key, previous);
      else entries.delete(key);
    });
    return promise;
  }

  async function run(key, work) {
    const now = clock();
    const existing = entries.get(key);
    if (existing && existing.expiresAt > now) return existing.value;
    if (existing && existing.staleUntil > now && Object.hasOwn(existing, "value")) {
      if (!existing.promise) {
        const previous = { value: existing.value, expiresAt: existing.expiresAt, staleUntil: existing.staleUntil };
        // Keep status polling responsive while one shared refresh runs. A
        // failed background refresh retains the bounded previous snapshot and
        // must not create an unhandled rejection in the API process.
        void start(key, work, previous).catch(() => {});
      }
      return existing.value;
    }
    if (existing?.promise) return existing.promise;

    prune(now);
    return start(key, work);
  }

  return { run };
}
