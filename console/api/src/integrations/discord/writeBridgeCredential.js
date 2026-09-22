// Hop B credential resolution for the Discord write bridge (issue #215,
// docs/rw-architecture.md sections 3.1/3.2/3.4). This is the internal
// loopback's own auth-resolution branch -- authenticates write/execute's
// self-call to Core's own real mutation route, entirely separate from Hop
// A (the incoming Discord-bot request, already resolved via
// requireDiscordBotToken + verifyActorSignature + requireDiscordCapability).
import { randomBytes } from "node:crypto";
import { constantTimeHexEqual } from "./actorSignature.js";
import { matchesWriteActionTarget } from "./writeActionRoutes.js";

export const WRITE_BRIDGE_TOKEN_HEADER = "x-dune-write-bridge-token";
export const WRITE_BRIDGE_ACTION_HEADER = "x-dune-write-bridge-action";
export const WRITE_BRIDGE_TIER_HEADER = "x-dune-write-bridge-tier";
export const WRITE_BRIDGE_ACTOR_USER_ID_HEADER = "x-dune-write-bridge-actor-user-id";
export const WRITE_BRIDGE_ACTOR_USERNAME_HEADER = "x-dune-write-bridge-actor-username";

const VALID_TIERS = new Set(["moderator", "admin", "owner"]);

// A single random token, generated once at process boot, held only in
// module-level memory -- never written to disk, nothing to rotate
// (docs/rw-architecture.md 3.4's "Rotation: N/A" framing). Lazily generated
// (not at import time) so tests can import this module without immediately
// minting a real token for a process that will never actually enable RW.
let token = null;

export function getWriteBridgeToken() {
  if (!token) token = randomBytes(32).toString("hex");
  return token;
}

// Test-only: force a fresh token (simulates a process restart, since this
// credential is explicitly per-process-lifetime -- section 3.4).
export function resetWriteBridgeTokenForTests() {
  token = null;
}

// The two-part gate (docs/rw-architecture.md 3.4): (1) reachability is
// filesystem-permission-gated -- enforced entirely by the Unix socket's own
// 0700 mode and the OS, never by this function, which is why
// `viaWriteBridgeSocket` is checked FIRST, before even looking at the token
// -- a request that didn't arrive via the socket listener is never eligible
// for this principal type, full stop, regardless of what headers it
// carries; (2) the token itself, compared via the same length-guarded
// constant-time comparison actorSignature.js already established
// (constantTimeHexEqual), reused here rather than reimplemented, per this
// design's own round-6 correction (#776).
//
// Exact-match path-scoping (CRITICAL #728): the credential is only ever
// recognized for a request whose (method, path) exactly matches the ONE
// specific WRITE_ACTION_ROUTES entry the caller claims via the action
// header -- never a broader grant. Failing any check returns null (not a
// distinct error) so a caller can fall through to normal handleApi
// auth resolution without leaking which specific check failed.
export function resolveWriteBridgePrincipal({ headers, method, path, viaWriteBridgeSocket }) {
  if (!viaWriteBridgeSocket) return null;

  const receivedToken = String(headers?.[WRITE_BRIDGE_TOKEN_HEADER] || "");
  if (!constantTimeHexEqual(receivedToken, getWriteBridgeToken())) return null;

  const action = String(headers?.[WRITE_BRIDGE_ACTION_HEADER] || "");
  if (!matchesWriteActionTarget(action, method, path)) return null;

  const tier = String(headers?.[WRITE_BRIDGE_TIER_HEADER] || "");
  if (!VALID_TIERS.has(tier)) return null;

  const discordUserId = String(headers?.[WRITE_BRIDGE_ACTOR_USER_ID_HEADER] || "").trim();
  if (!discordUserId) return null;
  const discordUsername = String(headers?.[WRITE_BRIDGE_ACTOR_USERNAME_HEADER] || "").trim();

  return {
    source: "discord-write-bridge",
    tier,
    // userId (issue #1010, this session's own audit): audit.js's
    // principalOf() reads session.userId for its generic-session
    // attribution branch, NOT discordUserId below -- without this field,
    // every write-bridge mutation's audit-log entry would carry no
    // Discord-actor identity at all.
    userId: discordUserId,
    discordUserId,
    discordUsername,
    // id: rate-limit keying (applyMutationRateLimit) needs this present so
    // per-actor limiting isolates Discord actors from each other, exactly
    // as it already does for browser/API-key sessions.
    id: `discord:${discordUserId}`,
    // CSRF does not apply to this principal type -- it never routes through
    // auth.requireAuth()'s cookie-session/CSRF check at all (see the
    // short-circuit in server.js: `bearer?.session || writeBridgePrincipal?.session
    // || auth.requireAuth(...)`), so this field is never read, but is set
    // explicitly (not left undefined) to make that non-reliance visible
    // rather than accidental.
    csrf: null
  };
}
