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

import { resolveRoleTier, higherTier, mfaGateReason } from "./roleTiers.js";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";

export const DISCORD_OAUTH_BASE_URL = "https://discord.com/api/v10";
export const DISCORD_OAUTH_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
// guilds.members.read lets the console read the signed-in member's own roles
// in the home guild (rfc-console-auth.md §2.1.1). Operators who authorized
// under the older "identify guilds" scope are asked by Discord to re-authorize
// once.
export const OAUTH_SCOPES = "identify guilds guilds.members.read";
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
    const verifier = random(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    pending.set(state, { createdAt: now(), used: false, verifier, challenge });
    return { state, challenge };
  }

  // PKCE-enabled consume: returns code_verifier on success.
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
    return { ok: true, verifier: entry.verifier };
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
    const rejected = oauthError("oauth_upstream_error", `Discord rejected the ${label} request (HTTP ${response.status}).`, 502);
    rejected.upstreamStatus = response.status; // callers may treat 403/404 as "not a member", never as "sign-in failed"
    throw rejected;
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
  codeVerifier,
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
  if (codeVerifier) params.set("code_verifier", codeVerifier);
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

export async function fetchDiscordIdentity({ accessToken, homeGuildId = "", apiBaseUrl = DISCORD_OAUTH_BASE_URL, fetchImpl = globalThis.fetch }) {
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
  const mfaEnabled = user?.mfa_enabled === true;
  // Member roles for the home guild, from the user's own token. Only asked for
  // when a home guild is configured and the user is in it; a 403/404 here means
  // "not a member" and yields no roles rather than failing sign-in.
  let roleIds = [];
  if (/^\d{17,19}$/.test(homeGuildId) && guildIds.includes(homeGuildId)) {
    try {
      const member = await discordJsonRequest(`${apiBaseUrl}/users/@me/guilds/${homeGuildId}/member`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
      }, { fetchImpl, label: "member" });
      roleIds = Array.isArray(member?.roles) ? member.roles.map((id) => String(id)).filter((id) => /^\d{17,19}$/.test(id)) : [];
    } catch (error) {
      if (error?.upstreamStatus !== 403 && error?.upstreamStatus !== 404) throw error;
    }
  }
  return { userId, username, guildIds, roleIds, mfaEnabled };
}

// ---- Tier decision (Phase 3: signed handoff, authoritative when configured) ----
// Phase 2 resolveBootstrapTier is kept as a pure first-owner-bootstrap
// function — it only ever produces "owner" or "" and applies only to
// installs that have never configured a handoff at all. When the handoff
// is configured its result is authoritative: an empty result means deny
// (bot unreachable, or bot said no), never "fall through to the static
// allowlist" (rfc-console-auth.md §1.1/§2.1 — the previous fallthrough
// silently restored owner access from a stale allowlist entry whenever
// the bot had any hiccup).
export function resolveBootstrapTier({ userId, guildIds, allowOwnerBootstrap, homeGuildId, ownerAllowlist = [] }) {
  if (!allowOwnerBootstrap) return "";
  if (!homeGuildId) return "";
  if (!guildIds.includes(homeGuildId)) return "";
  if (!ownerAllowlist.includes(userId)) return "";
  return "owner";
}

// Resolves to { tier, source, reason }. source is "handoff" or
// "bootstrap"; reason is "" on success and names the denial cause for
// the audit log only — it must never influence the authorization
// decision, which is tier-empty-means-deny regardless of reason.
export function createOAuthTierResolver({ bootstrap = {}, handoff = null, roleTiers = null, requireMfaTiers = [] } = {}) {
  return async function resolveOAuthTier(identity) {
    const { userId, guildIds, roleIds = [], mfaEnabled = false } = identity;

    // A configured handoff stays authoritative (§2.1): the bot is the single
    // source of truth for operators who run one, and this resolver must never
    // produce a second, competing answer beside it.
    if (handoff && handoff.enabled) {
      const { tier, reason } = await handoff.resolveTier({ userId, username: identity.username });
      return { tier, source: "handoff", reason: tier ? "" : (reason || "denied") };
    }

    const bootstrapTier = resolveBootstrapTier({
      userId,
      guildIds,
      allowOwnerBootstrap: bootstrap.allowOwnerBootstrap || false,
      homeGuildId: bootstrap.homeGuildId || "",
      ownerAllowlist: bootstrap.ownerAllowlist || []
    });
    // Roles count only for members of the home guild; fetchDiscordIdentity
    // already returns no roles otherwise, but the membership check is repeated
    // here so the decision does not depend on how identity was assembled.
    const inHomeGuild = Boolean(bootstrap.homeGuildId) && guildIds.includes(bootstrap.homeGuildId);
    const roleTier = inHomeGuild ? resolveRoleTier(roleIds, roleTiers) : "";
    const tier = higherTier(bootstrapTier, roleTier);
    const source = tier === roleTier && roleTier ? "roles" : "bootstrap";
    if (!tier) return { tier: "", source, reason: "not_authorized" };

    // Discord-account 2FA gate (§2.1.1 item 4): reuses the factor the user
    // already carries for Discord instead of adding an enrollment on top of OAuth.
    const mfaReason = mfaGateReason(tier, mfaEnabled, requireMfaTiers);
    if (mfaReason) return { tier: "", source, reason: mfaReason, deniedTier: tier };
    return { tier, source, reason: "" };
  };
}

export function parseDiscordAllowlist(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return list.map((item) => String(item || "").trim()).filter((item) => /^\d{17,19}$/.test(item));
}

export function buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES,
    state
  });
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${DISCORD_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

// The pending OAuth state is bound to a short-lived, path-scoped cookie so a
// third-party site cannot start a login and complete it in a victim's
// browser (login CSRF). SameSite=None; Secure + HttpOnly; cleared after the callback.
export function oauthStateCookie(value, secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `discord_oauth_state=${encodeURIComponent(value)}; HttpOnly; SameSite=None; Path=/api/auth/discord/callback; Max-Age=600${securePart}`;
}

export function clearOAuthStateCookie(secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `discord_oauth_state=; HttpOnly; SameSite=None; Path=/api/auth/discord/callback; Max-Age=0${securePart}`;
}
