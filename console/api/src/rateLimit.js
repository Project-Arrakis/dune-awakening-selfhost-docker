// Resolves the address used to key the login rate limiter (#406, gate #424
// prerequisite 3). Deliberately generic, not Cloudflare-specific -- an
// earlier RFC draft's CF-Connecting-IP mechanism was rejected because most
// operators of this project don't run Cloudflare Tunnel/Access at all (see
// docs/rfc-console-auth.md). Default behavior (trustedProxyIps empty) is
// byte-identical to before this existed: the raw socket address, so an
// operator who never sets CONSOLE_TRUSTED_PROXY_IPS sees no change.
//
// X-Forwarded-For is trusted ONLY when the immediate TCP peer is in the
// operator-declared trustedProxyIps list -- an untrusted peer can put
// anything in that header, so honoring it unconditionally would let a
// remote attacker forge their rate-limit key and dodge the limiter entirely
// (or frame another client for their own failures). The leftmost entry is
// taken as the original client; this does not handle a chain of more than
// one trusted proxy, which is out of scope for this fix (see
// docs/rfc-console-auth.md's own "generic proxy-aware fix... deferred" note).
export function resolveClientIp(req, trustedProxyIps = []) {
  const socketIp = normalizeIp(req.socket?.remoteAddress);
  if (!trustedProxyIps.length || !socketIp || !trustedProxyIps.includes(socketIp)) {
    return socketIp || "unknown";
  }
  const header = req.headers?.["x-forwarded-for"];
  if (!header) return socketIp;
  const forwarded = normalizeIp(String(header).split(",")[0].trim());
  return forwarded || socketIp;
}

function normalizeIp(ip) {
  return ip ? ip.replace(/^::ffff:/, "") : "";
}

export function createLoginRateLimiter(options = {}) {
  const {
    maxAttempts = 8,
    globalMaxAttempts = 32,
    windowMs = 15 * 60 * 1000,
    blockMs = 15 * 60 * 1000,
    now = () => Date.now()
  } = options;
  const attempts = new Map();
  const globalKey = "__global__";

  function check(key) {
    const timestamp = now();
    const blocked = [activeAttempt(key, timestamp), activeAttempt(globalKey, timestamp)]
      .filter((current) => current?.blockedUntil && current.blockedUntil > timestamp)
      .map((current) => Math.ceil((current.blockedUntil - timestamp) / 1000));
    if (blocked.length) return { allowed: false, retryAfterSeconds: Math.max(...blocked) };
    return { allowed: true, retryAfterSeconds: 0 };
  }

  function recordFailure(key) {
    const timestamp = now();
    increment(key, maxAttempts, timestamp);
    increment(globalKey, globalMaxAttempts, timestamp);
    return check(key);
  }

  function recordSuccess(key) {
    attempts.delete(key);
  }

  function activeAttempt(key, timestamp) {
    const current = attempts.get(key);
    if (!current) return null;
    if (current.blockedUntil && current.blockedUntil > timestamp) return current;
    if (current.firstAttemptAt + windowMs <= timestamp) {
      attempts.delete(key);
      return null;
    }
    return current;
  }

  function increment(key, limit, timestamp) {
    const current = activeAttempt(key, timestamp);
    const next = !current || current.firstAttemptAt + windowMs <= timestamp
      ? { count: 1, firstAttemptAt: timestamp, blockedUntil: 0 }
      : { ...current, count: current.count + 1 };
    if (next.count >= limit) next.blockedUntil = timestamp + blockMs;
    attempts.set(key, next);
  }

  return { check, recordFailure, recordSuccess };
}

export function createMutationRateLimiter(options = {}) {
  const {
    maxRequests = 20,
    globalMaxRequests = 200,
    windowMs = 60 * 1000,
    now = () => Date.now()
  } = options;
  const requests = new Map();
  const globalKey = "__global_mutations__";

  function check(key) {
    const timestamp = now();
    const current = activeRequest(key, timestamp);
    const global = activeRequest(globalKey, timestamp);
    const retryAfterSeconds = Math.ceil(windowMs / 1000);
    if (current && current.count >= maxRequests) {
      return { allowed: false, retryAfterSeconds: retryAfter(current, timestamp, retryAfterSeconds) };
    }
    if (global && global.count >= globalMaxRequests) {
      return { allowed: false, retryAfterSeconds: retryAfter(global, timestamp, retryAfterSeconds) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  function record(key) {
    const timestamp = now();
    increment(key, timestamp);
    increment(globalKey, timestamp);
    return check(key);
  }

  function activeRequest(key, timestamp) {
    const current = requests.get(key);
    if (!current) return null;
    if (current.firstRequestAt + windowMs <= timestamp) {
      requests.delete(key);
      return null;
    }
    return current;
  }

  function increment(key, timestamp) {
    const current = activeRequest(key, timestamp);
    const next = current
      ? { ...current, count: current.count + 1 }
      : { count: 1, firstRequestAt: timestamp };
    requests.set(key, next);
  }

  function retryAfter(current, timestamp, fallback) {
    return Math.max(1, Math.ceil((current.firstRequestAt + windowMs - timestamp) / 1000) || fallback);
  }

  return { check, record };
}
