// Actor signature verification — closes FINDING-LINK-1 from
// docs/security/discord-player-link-hardening.md.
//
// Problem: normalizeDiscordActor() (policy.js) trusts actor.userId,
// actor.roleIds, actor.guildId, etc. verbatim from the request body. The
// only prior gate on the whole adapter was a single shared bearer token
// (requireDiscordBotToken) that authenticates the bot *process*, not the
// specific Discord user or interaction — a confused-deputy trust boundary.
// Anyone holding the bearer token could claim any userId/roleIds.
//
// Fix: an HMAC-SHA256 signature over the actor object's own fields, using a
// second shared secret distinct from the transport bearer token, plus a
// short freshness window to prevent replay. This binds the actor claims to
// something only a party holding DUNE_DISCORD_ACTOR_SECRET could produce.
//
// Backward compatibility: verification is opt-in. When
// DUNE_DISCORD_ACTOR_SECRET is not configured, actor signatures are not
// required and this module is a no-op, preserving the exact pre-existing
// behavior for deployments that have not yet configured a bot capable of
// signing. This lets the console ship verification ahead of any bot-side
// signing support. A future release train should remove the fallback and
// make signing mandatory once the ecosystem has migrated (tracked in
// docs/security/discord-player-link-hardening.md, FINDING-LINK-1).

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { policyError } from "./policy.js";

const DEFAULT_MAX_SKEW_SECONDS = 30;
const SIGNATURE_HEADER = "x-dune-actor-signature";
const TIMESTAMP_HEADER = "x-dune-actor-timestamp";

// [Layer 3 integration audit fix, MEDIUM, issue #1052] Matches the
// boundedTimeoutMs()/boundedEnvInt() pattern already established elsewhere
// in this feature (writeBridgeInternalClient.js, routes.js) -- `Number(x) ||
// default` silently treats an explicit "0" as "use the default" and
// enforces no upper bound, which would let a misconfigured or malicious
// value effectively disable the anti-replay freshness window this variable
// exists to enforce.
function boundedMaxSkewSeconds() {
  const value = Number(process.env.DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS);
  return Number.isInteger(value) && value >= 5 && value <= 300 ? value : DEFAULT_MAX_SKEW_SECONDS;
}

// Fields covered by the signature. Order is fixed so the bot and console
// compute byte-identical canonical strings; unknown/extra actor fields are
// intentionally excluded so adding a new non-authorizing field to the actor
// payload later does not silently invalidate every existing signature.
const SIGNED_ACTOR_FIELDS = ["userId", "guildId", "channelId", "roleIds", "interactionId"];

// Independent field set for the Discord write bridge (docs/rw-architecture.md
// section 3.8, issue #215). Deliberately NOT added to SIGNED_ACTOR_FIELDS above
// -- that array is consumed by every existing actor-signed route (link, verify,
// unlink, steam-link), and expanding a shared signed-field set consumed by
// multiple already-shipped routes needs a separate, coordinated, versioned
// rollout across both repos, since Core and the bot ship on independent
// release trains. write/preview and write/execute are brand-new routes with
// no existing wire format to preserve, so they define their own set from
// inception instead: adds `username` (a real actor field, not currently in
// the shared subset) and `roleSnapshotAt` (when the bot re-derived
// actor.roleIds from Discord, closing the gap where "actor signature +
// capability re-validated at both preview AND execute" only proves the same
// functions ran twice, not that roleIds reflects the actor's CURRENT roles
// rather than a value cached from the original interaction); deliberately
// omits `interactionId` since the write bridge's own 60s nonce/expiry
// already binds each request to one specific confirm-click, making a
// separate per-interaction replay guard redundant here.
//
// [CRITICAL fix] `action` added: write/preview and write/execute are the
// SAME route for every action -- without it in the signed payload, a
// captured, legitimately-signed envelope from a real moderator+ actor could
// be replayed with a DIFFERENT action/params within the freshness window
// and still verify, since nothing about the signed payload changed.
// routes.js's readJsonWithActorSignature merges body.action into the signed
// actor payload before verification -- `action` cannot be read from
// actorPayload itself, since it is a sibling of `actor` in the request
// body, not one of its fields. mentat's own actorSignature.js must sign the
// identical shape or every real write-bridge request fails verification
// (see that repo's own fix, same finding).
//
// [CRITICAL fix, issue #1070] `params` was ALSO missing, leaving the exact
// same class of gap the `action` fix above closed for the action name, just
// one level down: write/preview's own handler (routes.js's
// writePreviewRoute) mints a brand-new nonce binding whatever `body.params`
// the request carries, using only the actor+action signature to authorize
// doing so. Since params was never part of what the signature covers, an
// attacker positioned to observe (not forge -- a MITM, a compromised
// reverse proxy, a logging tap on the Hop A path) one legitimately-signed
// write/preview envelope for, say, `player.kick {playerId: "Alice"}` could
// replay it verbatim within the freshness window with `params` substituted
// to `{playerId: "Bob"}` and mint a fully valid, correctly-signed nonce to
// kick Bob instead -- something the real signer never asked for.
// (write/execute's own request body params are never actually trusted for
// the dispatch -- it always uses the nonce-stored params from the original
// write/preview call -- so this gap was real specifically at write/preview's
// minting step, not at execute time; `params` is still included here for
// both routes so the two share one signed-field contract.) The route's
// caller (routes.js's readJsonWithActorSignature) merges body.params into
// the signed actor payload the same way it already does for `action`, for
// the same reason: params is a sibling of `actor` in the request body, not
// one of its own fields.
export const WRITE_BRIDGE_SIGNED_ACTOR_FIELDS = ["userId", "username", "roleIds", "guildId", "channelId", "roleSnapshotAt", "action", "params"];

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
// Deep, key-sorted canonicalization for an object-valued signed field (used
// by `params` above) -- plain `String(value)` on an object collapses every
// distinct object to the literal string "[object Object]", which would make
// signing an object field a complete no-op (every possible params payload
// would canonicalize identically). Object keys are sorted recursively so
// the same logical params object signs identically regardless of the
// property insertion order the sender happened to use; array ELEMENT order
// is preserved as-is (unlike the top-level roleIds field's own deliberate
// sort-as-a-set behavior below), since a params array's order can be
// semantically meaningful (e.g. an ordered list of ids) in a way roleIds's
// unordered set is not.
function canonicalizeValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value && typeof value === "object") {
    // [CRITICAL fix, issue #1073] `sorted` must NOT be a plain `{}` --
    // JSON.parse creates a "__proto__" key as a real OWN enumerable
    // property (it uses CreateDataProperty, not [[Set]]), so a params
    // object with a literal "__proto__" key genuinely has it in
    // Object.keys(value). But a plain object literal inherits
    // Object.prototype's own "__proto__" ACCESSOR, so `sorted[key] = ...`
    // for that one key invoked the inherited setter instead of creating an
    // own property -- silently dropping that key (and its whole subtree)
    // from the canonical string that gets signed, while it remained a real
    // own property everywhere else params was read (body.params, the
    // nonce store, etc.). Object.create(null) has no prototype at all, so
    // every key -- including "__proto__" -- is an ordinary own-property
    // assignment here, at every nesting depth via this same recursive call.
    const sorted = Object.create(null);
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalizeValue(value[key]);
    return sorted;
  }
  return value;
}

export function canonicalActorSignaturePayload(actorPayload = {}, timestamp, route = "", fields = SIGNED_ACTOR_FIELDS) {
  const canonical = {};
  for (const key of fields) {
    const value = actorPayload?.[key];
    if (Array.isArray(value)) {
      canonical[key] = [...value].map(String).sort();
    } else if (value && typeof value === "object") {
      canonical[key] = canonicalizeValue(value);
    } else {
      canonical[key] = String(value ?? "");
    }
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

  const maxSkewSeconds = boundedMaxSkewSeconds();
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
