// Console "Sign in with Discord" OAuth (console RBAC, Phase 2).
//
// This module is intentionally decoupled from Express/server.js: it exposes
// a small state machine and pure helpers so unit tests can drive every
// failure path with an injected fetch stub, and server.js only wires
// routes/rate-limiting/cookies/audit around it. Nothing here trusts request
// bodies for identity or tier — the Discord /users/@me response is the
// single source of identity, and role/tier resolution is deliberately not
// performed in this phase (Phase 3's signed handoff owns that).
//
// Security posture (see docs/security/console-rbac-implementation-and-testing.md):
// - authorization-code flow with short-lived, single-use, cookie-bound state
// - access token is used once for /users/@me then discarded (never stored)
// - membership + explicit operator gates before any owner-tier session
// - fail closed: any missing/invalid input yields no session, never a partial one

import { randomBytes, timingSafeEqual } from "node:crypto";

export const DISCORD_OAUTH_BASE_URL = "https://discord.com/api/v10";
export const DISCORD_OAUTH_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
export const OAUTH_SCOPES = "identify guilds";
export const STATE_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_STATES = 256;

export function oauthError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// ---- Pending-state store ----
export function createPendingStateStore({
  now = () => Date.now(),
  ttlMs = STATE_TTL_MS,
  maxEntries = MAX_PENDING_STATES
} = {}) {
  const pending = new Map();

  function issue(random = randomBytes) {
    if (pending.size >= maxEntries) return null;
    const state = random(16).toString("base64url");
    pending.set(state, { createdAt: now(), used: false });
    return state;
  }

  // Single-use, TTL-bounded, cookie-bound. Consume-before-verify so a failed
  // attempt never leaves a reusable state behind.
  function consume(state, cookieValue, timestamp = now()) {
    if (typeof state !== "string" || state.length === 0 || state.length > 128) {
      return { ok: false, reason: "invalid_state" };
    }
    if (typeof cookieValue !== "string" || cookieValue.length === 0) {
      return { ok: false, reason: "missing_pending_cookie" };
    }
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry || entry.used) return { ok: false, reason: "missing_or_reused_state" };
    if (!constantTimeStringEqual(state, cookieValue)) return { ok: false, reason: "state_cookie_mismatch" };
    if (timestamp - entry.createdAt > ttlMs) return { ok: false, reason: "stale_state" };
    entry.used = true;
    return { ok: true };
  }

  return { issue, consume, size: () => pending.size };
}

function constantTimeStringEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length === 0) return false;
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Discord HTTP helpers (injected fetchImpl for tests) ----
async function discordJsonRequest(url, init, { fetchImpl, label }) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw oauthError("discord_unreachable", `Discord ${label} request failed.`, 502);
  }
  if (!response.ok) {
    throw oauthError("oauth_upstream_error", `Discord rejected the ${label} request (HTTP ${response.status}).`, 502);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw oauthError("oauth_bad_response", `Discord returned a malformed ${label} response.`, 502);
  }
  if (payload === null || payload === undefined || (typeof payload !== "object")) {
    throw oauthError("oauth_bad_response", `Discord returned a malformed ${label} response.`, 502);
  }
  return payload;
}

export async function exchangeDiscordAuthCode({
  code,
  redirectUri,
  clientId,
  clientSecret,
  apiBaseUrl = DISCORD_OAUTH_BASE_URL,
  fetchImpl = globalThis.fetch
}) {
  if (typeof code !== "string" || code.length === 0 || code.length > 1024) {
    throw oauthError("missing_code", "Missing Discord authorization code.", 400);
  }
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code: code.trim(),
    redirect_uri: redirectUri
  });
  const token = await discordJsonRequest(`${apiBaseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString()
  }, { fetchImpl, label: "token" });
  if (typeof token.access_token !== "string" || token.access_token.length === 0 || token.access_token.length > 1000) {
    throw oauthError("oauth_missing_token", "Discord token response did not include an access token.", 502);
  }
  return token;
}

export async function fetchDiscordIdentity({ accessToken, apiBaseUrl = DISCORD_OAUTH_BASE_URL, fetchImpl = globalThis.fetch }) {
  const [user, guilds] = await Promise.all([
    discordJsonRequest(`${apiBaseUrl}/users/@me`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    }, { fetchImpl, label: "identity" }),
    discordJsonRequest(`${apiBaseUrl}/users/@me/guilds`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    }, { fetchImpl, label: "guilds" })
  ]);
  const userId = String(user?.id || "");
  const username = String(user?.username || "");
  if (!/^\d{17,19}$/.test(userId)) {
    throw oauthError("oauth_bad_identity", "Discord identity response is missing a valid user id.", 502);
  }
  if (username.length === 0 || username.length > 64) {
    throw oauthError("oauth_bad_identity", "Discord identity response is missing a username.", 502);
  }
  const guildIds = Array.isArray(guilds)
    ? guilds.map((guild) => String(guild?.id || "")).filter((id) => /^\d{17,19}$/.test(id))
    : [];
  return { userId, username, guildIds };
}

// ---- Tier decision (Phase 3: signed handoff with Phase 2 owner-bootstrap fallback) ----
// Phase 2 resolveBootstrapTier is kept as a pure fallback function — it only
// ever produces "owner" or "" and is used only when the handoff is not
// configured. Phase 3 resolveOAuthTier delegates to the signed handoff when
// available and falls back to the bootstrap gates when it isn't.
export function resolveBootstrapTier({ userId, guildIds, allowOwnerBootstrap, homeGuildId, ownerAllowlist = [] }) {
  if (!allowOwnerBootstrap) return "";
  if (!homeGuildId) return "";
  if (!guildIds.includes(homeGuildId)) return "";
  if (!ownerAllowlist.includes(userId)) return "";
  return "owner";
}

export function createOAuthTierResolver({ bootstrap = {}, handoff = null } = {}) {
  return async function resolveOAuthTier(identity) {
    const { userId, guildIds } = identity;

    if (handoff && handoff.enabled) {
      const tier = await handoff.resolveTier({ userId, username: identity.username });
      if (tier) return tier;
    }

    return resolveBootstrapTier({
      userId,
      guildIds,
      allowOwnerBootstrap: bootstrap.allowOwnerBootstrap || false,
      homeGuildId: bootstrap.homeGuildId || "",
      ownerAllowlist: bootstrap.ownerAllowlist || []
    });
  };
}

export function parseDiscordAllowlist(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return list.map((item) => String(item || "").trim()).filter((item) => /^\d{17,19}$/.test(item));
}

export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES,
    state
  });
  return `${DISCORD_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

// The pending OAuth state is bound to a short-lived, path-scoped cookie so a
// third-party site cannot start a login and complete it in a victim's
// browser (login CSRF). SameSite=Lax + HttpOnly; cleared after the callback.
export function oauthStateCookie(value) {
  return `discord_oauth_state=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/api/auth/discord/callback; Max-Age=600; Secure`;
}

export function clearOAuthStateCookie() {
  return `discord_oauth_state=; HttpOnly; SameSite=Lax; Path=/api/auth/discord/callback; Max-Age=0; Secure`;
}
