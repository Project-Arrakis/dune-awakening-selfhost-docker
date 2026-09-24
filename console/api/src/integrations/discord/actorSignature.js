// Actor signature verification for the Discord write bridge (issue #215).
//
// Problem: normalizeDiscordActor() (policy.js) trusts actor.userId,
// actor.roleIds, actor.guildId, etc. verbatim from the request body. The
// only prior gate on the adapter was a single shared bearer token
// (requireDiscordBotToken) that authenticates the bot *process*, not the
// specific Discord user or interaction — a confused-deputy trust boundary.
// Anyone holding the bearer token could claim any userId/roleIds. This is
// unacceptable for write/preview and write/execute specifically, since a
// forged actor could otherwise claim an elevated tier for a real mutation.
//
// Fix: an HMAC-SHA256 signature over the actor object's own fields, using a
// second shared secret distinct from the transport bearer token, plus a
// short freshness window to prevent replay. This binds the actor claims to
// something only a party holding DUNE_DISCORD_ACTOR_SECRET could produce.
//
// Scope: this module is used only by the write bridge's own two routes in
// this codebase (write/preview, write/execute) -- required, not opt-in, for
// both. Other Discord adapter routes are unaffected.

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { policyError } from "./policy.js";

const DEFAULT_MAX_SKEW_SECONDS = 30;
const SIGNATURE_HEADER = "x-dune-actor-signature";
const TIMESTAMP_HEADER = "x-dune-actor-timestamp";

// Fields covered by the signature. Order is fixed so the bot and console
// compute byte-identical canonical strings; unknown/extra actor fields are
// intentionally excluded so adding a new non-authorizing field to the actor
// payload later does not silently invalidate every existing signature. This
// is the default field set for verifyActorSignature()/signActorPayload();
// the write bridge's own two routes use WRITE_BRIDGE_SIGNED_ACTOR_FIELDS
// below instead, passed explicitly.
const SIGNED_ACTOR_FIELDS = ["userId", "guildId", "channelId", "roleIds", "interactionId"];

// Field set for the Discord write bridge's write/preview and write/execute
// routes (issue #215): adds `username` (a real actor field) and
// `roleSnapshotAt` (when the bot re-derived actor.roleIds from Discord --
// closes the gap where "actor signature + capability re-validated at both
// preview AND execute" only proves the same functions ran twice, not that
// roleIds reflects the actor's CURRENT roles rather than a value cached
// from the original interaction); deliberately omits `interactionId` since
// the write bridge's own 60s nonce/expiry already binds each request to one
// specific confirm-click, making a separate per-interaction replay guard
// redundant here.
//
// [Layer 3 integration audit fix, CRITICAL] `action` was missing entirely.
// write/preview and write/execute are the SAME route for every action --
// without `action` in the signed payload, the route-binding this file's own
// verifyActorSignature() provides cannot distinguish "this signed envelope
// authorizes player.warn" from "this signed envelope authorizes
// server.stop." A captured, legitimately-signed envelope from a real
// moderator+ actor could be replayed with a different action/params within
// the freshness window and still verify, since nothing about the signed
// payload changed. The route's caller (routes.js's readJsonWithActorSignature)
// merges body.action into the signed actor payload before verification --
// `action` cannot be read from actorPayload itself, since it is a sibling
// of `actor` in the request body, not one of its fields.
export const WRITE_BRIDGE_SIGNED_ACTOR_FIELDS = ["userId", "username", "roleIds", "guildId", "channelId", "roleSnapshotAt", "action"];

export function actorSignatureSecret(config = {}) {
  const direct = process.env.DUNE_DISCORD_ACTOR_SECRET || config.discordActorSecret || "";
  if (direct) return String(direct).trim();
  const file = process.env.DUNE_DISCORD_ACTOR_SECRET_FILE || config.discordActorSecretFile || "";
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

export function actorSignatureRequired(config = {}) {
  return Boolean(actorSignatureSecret(config));
}

// Deterministic string the bot and console must both compute identically.
// roleIds is sorted so role-array ordering differences never break a
// signature that is otherwise for the same actor.
//
// `route` binds the signature to the specific adapter route path (e.g.
// "/api/integrations/discord/players/link"). Without this, a signature
// covering only actor identity fields can be captured from one legitimate
// request (e.g. a routine "status" call, which requires no special
// privilege to observe) and replayed verbatim — with an attacker-chosen
// request body — against ANY OTHER route within the freshness window,
// including PLAYERS_LINK or BROADCAST, as long as the actor still qualifies
// for that route's capability. Binding the route closes that gap: a
// captured envelope only verifies against the exact route it was issued
// for. This does not fully eliminate replay (a captured envelope can still
// be resent verbatim to the SAME route with the SAME body within the skew
// window — see FINDING-LINK-1's Known Limitations for why a full nonce/
// one-time-use scheme was not implemented here), but it eliminates
// cross-route and cross-body-parameter forgery using a captured envelope.
export function canonicalActorSignaturePayload(actorPayload = {}, timestamp, route = "", fields = SIGNED_ACTOR_FIELDS) {
  const canonical = {};
  for (const key of fields) {
    const value = actorPayload?.[key];
    canonical[key] = Array.isArray(value) ? [...value].map(String).sort() : String(value ?? "");
  }
  return `${timestamp}.${String(route)}.${JSON.stringify(canonical)}`;
}

export function signActorPayload(actorPayload, secret, timestamp = Math.floor(Date.now() / 1000), route = "", fields = SIGNED_ACTOR_FIELDS) {
  const message = canonicalActorSignaturePayload(actorPayload, timestamp, route, fields);
  const signature = createHmac("sha256", String(secret)).update(message).digest("hex");
  return { signature, timestamp };
}

// Exported per round-6 audit (#776): this length-guard-then-timingSafeEqual
// pattern must have exactly one implementation, imported everywhere it's
// needed, not reimplemented -- unstated duplication of this exact logic is
// the recurring bug class (clear-backpack, history-clear wording drift) this
// design doc has already found more than once.
export function constantTimeHexEqual(a, b) {
  const bufferA = Buffer.from(String(a || ""), "hex");
  const bufferB = Buffer.from(String(b || ""), "hex");
  if (bufferA.length === 0 || bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

// Verifies actor authenticity. When `required` is true (mutation routes:
// link, verify, unlink, steam-link), the secret MUST be configured and the
// signature MUST be valid — no fallback. When `required` is false (status
// routes), behaves as opt-in: no-ops if no secret is configured, verifies
// if it is. This preserves backward compatibility for read-only routes
// while closing the confused-deputy gap for identity-binding mutations.
//
// `route` must be the exact adapter route path the request was made to
// (see canonicalActorSignaturePayload() for why).
export function verifyActorSignature({ actorPayload, headers, config, route = "", required = false, now = Math.floor(Date.now() / 1000), fields = SIGNED_ACTOR_FIELDS }) {
  const secret = actorSignatureSecret(config);
  if (!secret) {
    if (required) throw policyError("actor_signing_disabled", "Actor signing is not configured. Mutation routes require DUNE_DISCORD_ACTOR_SECRET.", 403);
    return { verified: false, required: false };
  }

  const signature = String(headers?.[SIGNATURE_HEADER] || "").trim();
  const timestampRaw = String(headers?.[TIMESTAMP_HEADER] || "").trim();
  if (!signature || !timestampRaw) {
    throw policyError("missing_actor_signature", "Discord actor signature is required but was not provided.", 403);
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw policyError("invalid_actor_signature", "Discord actor signature timestamp is invalid.", 403);
  }

  const maxSkewSeconds = Number(process.env.DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS) || DEFAULT_MAX_SKEW_SECONDS;
  if (Math.abs(now - timestamp) > maxSkewSeconds) {
    throw policyError("stale_actor_signature", "Discord actor signature has expired. Retry the command.", 403);
  }

  const expected = signActorPayload(actorPayload, secret, timestamp, route, fields).signature;
  if (!constantTimeHexEqual(signature, expected)) {
    throw policyError("invalid_actor_signature", "Discord actor signature does not match the expected value.", 403);
  }

  return { verified: true, required: true };
}

export const ACTOR_SIGNATURE_HEADER = SIGNATURE_HEADER;
export const ACTOR_TIMESTAMP_HEADER = TIMESTAMP_HEADER;
