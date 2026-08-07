import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const sessions = new Map();

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(), microphone=(), camera=()"
};

export function withSecurityHeaders(headers = {}) {
  return { ...SECURITY_HEADERS, ...headers };
}

export function parseCookies(header = "") {
  const cookies = new Map();
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

export function createAuth(config) {
  const now = config.now || (() => Date.now());

  function sign(value) {
    return createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
  }

  function constantTimeStringEqual(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    if (a.length === 0) return false;
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // Sessions carry an identity + tier. The password login and the legacy
  // cookie synthesis default to "owner" (see readSession); the Discord OAuth
  // callback supplies its own identity when its bootstrap gate passes.
  function makeSession({ tier = "owner", userId = "", username = "", guildId = "" } = {}) {
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const expiresAt = now() + 12 * 60 * 60 * 1000;
    sessions.set(id, { id, csrf, expiresAt, tier, userId, username, guildId });
    return { id, csrf, expiresAt, tier, userId, username, guildId, cookie: `${id}.${sign(id)}` };
  }

  function readSession(req) {
    if (config.authDisabled) return { id: "dev", csrf: "dev", expiresAt: Number.MAX_SAFE_INTEGER, tier: "owner" };
    const raw = parseCookies(req.headers.cookie || "").get("asc_session");
    if (!raw) return null;
    const [id, sig] = raw.split(".");
    if (!id || !sig || !constantTimeStringEqual(sign(id), sig)) return null;
    let session = sessions.get(id);
    if (!session) {
      // Upgrade path (Strict Requirement 0): a signature-valid cookie whose
      // session is no longer in the in-memory Map (e.g. created by a
      // pre-RBAC build, or after a restart) synthesizes a fresh full-access
      // owner session rather than logging the operator out. The HMAC over
      // the session id is what proves the cookie is genuine.
      session = {
        id,
        csrf: randomBytes(24).toString("base64url"),
        expiresAt: now() + 12 * 60 * 60 * 1000,
        tier: "owner",
        userId: "",
        username: "",
        guildId: ""
      };
      sessions.set(id, session);
    }
    if (session.expiresAt < now()) {
      sessions.delete(id);
      return null;
    }
    session.expiresAt = now() + 12 * 60 * 60 * 1000;
    return session;
  }

  function passwordMatches(value) {
    const left = Buffer.from(String(value || ""));
    const right = Buffer.from(config.adminPassword);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  function requireAuth(req, res) {
    const session = readSession(req);
    if (!session) {
      json(res, 401, { error: "Your browser login session expired. Refresh the page, then sign in again." });
      return null;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method || "")) {
      const csrf = req.headers["x-csrf-token"];
      if (!config.authDisabled && csrf !== session.csrf) {
        json(res, 403, { error: "Your browser login session expired. Refresh the page, then sign in again." });
        return null;
      }
    }
    return session;
  }

  return { makeSession, readSession, passwordMatches, requireAuth };
}

export function setSessionCookie(res, session, config = {}) {
  res.setHeader("Set-Cookie", sessionCookieValue(session, config));
}

export function sessionCookieValue(session, config = {}) {
  const secure = config.secureCookies ? "; Secure" : "";
  return `asc_session=${encodeURIComponent(session.cookie)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`;
}

export function clearSessionCookie(res, config = {}) {
  res.setHeader("Set-Cookie", clearSessionCookieValue(config));
}

export function clearSessionCookieValue(config = {}) {
  const secure = config.secureCookies ? "; Secure" : "";
  return `asc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

export function json(res, status, body, headers = {}) {
  res.writeHead(status, withSecurityHeaders({ "content-type": "application/json; charset=utf-8", ...headers }));
  res.end(JSON.stringify(body));
}

export function html(res, status, body, headers = {}) {
  res.writeHead(status, withSecurityHeaders({ "content-type": "text/html; charset=utf-8", ...headers }));
  res.end(body);
}
