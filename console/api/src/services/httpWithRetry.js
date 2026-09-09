// httpWithRetry.js -- a real timeout + single-retry-on-5xx-or-connection-
// failure policy for outbound server-to-server calls. Verified during
// planning: no existing helper in this codebase does this (addons.js's
// community-catalog fetch has a timeout but falls back to a stale cache on
// failure, rather than retrying the request itself) -- this is new,
// standalone code, reused wherever this exact policy is needed (currently:
// Core's call to mentat-backend.darkdante.org for hosted-bot registration).
const DEFAULT_TIMEOUT_MS = 15000;

async function attemptOnce(url, init, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// fetchWithTimeoutAndRetry: exactly one retry, only on a 5xx response or a
// connection-level failure (thrown error, including our own abort) -- never
// on a 4xx, since retrying an already-rejected request wastes whatever
// rate-limit budget the caller is trying to protect.
export async function fetchWithTimeoutAndRetry(url, init = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  try {
    const first = await attemptOnce(url, init, fetchImpl, timeoutMs);
    if (first.ok || (first.status >= 400 && first.status < 500)) return first;
    return await attemptOnce(url, init, fetchImpl, timeoutMs);
  } catch (firstError) {
    try {
      return await attemptOnce(url, init, fetchImpl, timeoutMs);
    } catch (secondError) {
      // Minor fix (final integration review): `firstError` was caught and
      // silently discarded -- if the retry also fails, attach the first
      // attempt's failure as `cause` so a caller/log sees both failures
      // instead of only the second, identical-looking one.
      throw new Error(secondError.message, { cause: firstError });
    }
  }
}
