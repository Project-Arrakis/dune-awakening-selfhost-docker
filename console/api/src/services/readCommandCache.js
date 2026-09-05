export function createReadCommandCache({ ttlMs = 2000, maxEntries = 128, clock = Date.now } = {}) {
  const entries = new Map();

  function prune(now) {
    for (const [key, entry] of entries) {
      if (!entry.promise && entry.expiresAt <= now) entries.delete(key);
    }
    if (entries.size >= maxEntries) {
      for (const [key, entry] of entries) {
        if (!entry.promise) entries.delete(key);
        if (entries.size < maxEntries) break;
      }
    }
  }

  async function run(key, work) {
    const now = clock();
    const existing = entries.get(key);
    if (existing?.promise) return existing.promise;
    if (existing && existing.expiresAt > now) return existing.value;

    prune(now);
    const promise = Promise.resolve().then(work);
    entries.set(key, { promise, expiresAt: Number.POSITIVE_INFINITY });
    try {
      const value = await promise;
      if (entries.get(key)?.promise === promise) {
        entries.set(key, { value, expiresAt: clock() + ttlMs });
      }
      return value;
    } catch (error) {
      if (entries.get(key)?.promise === promise) entries.delete(key);
      throw error;
    }
  }

  return { run };
}
