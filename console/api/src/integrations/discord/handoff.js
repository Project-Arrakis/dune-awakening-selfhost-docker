// Console RBAC Phase 3 — signed tier handoff between bot and console.
//
// Mechanism B (operator-approved 2026-08-06): the ACP bot resolves a
// Discord user's effective console tier for the configured home guild
// and returns a signed handoff payload. The console verifies the HMAC
// before trusting any tier claim — fail-closed. No unsigned claim may
// ever produce a tiered session.
//
// Payload (the bot signs this shape):
//   { userId: string, guildId: string, tier: Tier, ts: number }
//
// Signature: HMAC-SHA256(sharedSecret, JSON.stringify(payload)) as hex.
//
// Max age: 30 s — a handoff is a real-time assertion, not a durable token.
// The console calls the bot anew on every login; the timestamp prevents
// replays within the window.

import { createHmac, timingSafeEqual } from "node:crypto";

const VALID_TIERS = new Set(["owner", "admin", "moderator", "player", "observer"]);
const USER_SNOWFLAKE_RE = /^\d{17,19}$/;
const MAX_HANDOFF_AGE_MS = 30_000;
const HTTP_TIMEOUT_MS = 5_000;

// ---- Public API ----

export function createHandoff(config) {
  const { secret, botUrl } = config;
  if (!secret || !botUrl) {
    return disabledHandoff();
  }
  return liveHandoff(config);
}

// ---- Signature helpers (also exported for tests) ----

export function signPayload(payload, secret) {
  const json = JSON.stringify(payload);
  return createHmac("sha256", String(secret)).update(json).digest("hex");
}

export function verifyPayload(payload, signature, secret) {
  if (typeof signature !== "string" || signature.length < 16) return false;
  const expected = signPayload(payload, secret);
  return constantTimeStringEqual(expected, signature);
}

export function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "invalid_payload" };
  const { userId, guildId, tier, ts } = payload || {};
  if (typeof userId !== "string" || !USER_SNOWFLAKE_RE.test(userId)) return { ok: false, reason: "invalid_user_id" };
  if (typeof guildId !== "string" || !USER_SNOWFLAKE_RE.test(guildId)) return { ok: false, reason: "invalid_guild_id" };
  if (typeof tier !== "string" || !VALID_TIERS.has(tier)) return { ok: false, reason: "invalid_tier" };
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return { ok: false, reason: "invalid_timestamp" };
  return { ok: true, payload };
}

export function isFresh(payload, maxAgeMs = MAX_HANDOFF_AGE_MS, now = Date.now) {
  const age = now() - payload.ts;
  return age >= 0 && age < maxAgeMs;
}

// ---- Handoff implementation ----

function disabledHandoff() {
  return {
    enabled: false,
    async resolveTier() { return ""; }
  };
}

function liveHandoff(config) {
  const { secret, botUrl, homeGuildId, fetchImpl = globalThis.fetch, now = () => Date.now() } = config;

  async function resolveTier({ userId, username = "" } = {}) {
    if (typeof userId !== "string" || !USER_SNOWFLAKE_RE.test(userId)) return "";
    if (!homeGuildId) return "";

    let response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
      response = await fetchImpl(`${botUrl}/resolve-console-tier`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ userId, guildId: homeGuildId }),
        signal: controller.signal
      });
      clearTimeout(timer);
    } catch {
      return "";
    }

    if (!response.ok) return "";

    let body;
    try {
      body = await response.json();
    } catch {
      return "";
    }

    if (!body || typeof body !== "object") return "";
    const { signature, ...payload } = body;

    const payloadCheck = validatePayload(payload);
    if (!payloadCheck.ok) return "";

    if (!verifyPayload(payloadCheck.payload, body.signature, secret)) return "";

    if (!isFresh(payloadCheck.payload, MAX_HANDOFF_AGE_MS)) return "";

    if (payloadCheck.payload.userId !== userId) return "";
    if (payloadCheck.payload.guildId !== homeGuildId) return "";

    return payloadCheck.payload.tier;
  }

  return { enabled: true, resolveTier };
}

function constantTimeStringEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length === 0) return false;
  return a.length === b.length && timingSafeEqual(a, b);
}
