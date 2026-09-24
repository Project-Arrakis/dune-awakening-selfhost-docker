// Hop B credential resolution for the Discord write bridge. This is the internal
// loopback's own auth-resolution branch -- authenticates write/execute's
// self-call to Core's own real mutation route, entirely separate from Hop
// A (the incoming Discord-bot request, already resolved via
// requireDiscordBotToken + verifyActorSignature + requireDiscordCapability).
import { randomBytes } from "node:crypto";
import { constantTimeHexEqual } from "./actorSignature.js";
import { matchesWriteActionTarget } from "./writeActionRoutes.js";
import { meetsMinTier } from "./writeActionMinTier.js";
import { DISCORD_ROLE_TIERS } from "./policy.js";

export const WRITE_BRIDGE_TOKEN_HEADER = "x-dune-write-bridge-token";
export const WRITE_BRIDGE_ACTION_HEADER = "x-dune-write-bridge-action";
export const WRITE_BRIDGE_TIER_HEADER = "x-dune-write-bridge-tier";
export const WRITE_BRIDGE_ACTOR_USER_ID_HEADER = "x-dune-write-bridge-actor-user-id";
export const WRITE_BRIDGE_ACTOR_USERNAME_HEADER = "x-dune-write-bridge-actor-username";

// Derived from the canonical DISCORD_ROLE_TIERS rather than hand-listed a
// second time -- see writeActionMinTier.js's TIER_RANK for the same
// approach and its fuller rationale.
const VALID_TIERS = new Set(DISCORD_ROLE_TIERS.slice(DISCORD_ROLE_TIERS.indexOf("moderator")));

// A single random token, generated once at process boot, held only in
// module-level memory -- never written to disk, so there's no persisted
// secret to rotate; a process restart alone regenerates a fresh one (see
// resetWriteBridgeTokenForTests below). Lazily generated
// (not at import time) so tests can import this module without immediately
// minting a real token for a process that will never actually enable RW.
let token = null;

export function getWriteBridgeToken() {
  if (!token) token = randomBytes(32).toString("hex");
  return token;
}

// Test-only: force a fresh token (simulates a process restart, since this
// credential is explicitly per-process-lifetime).
export function resetWriteBridgeTokenForTests() {
  token = null;
}

// The two-part gate: (1) reachability is
// filesystem-permission-gated -- enforced entirely by the Unix socket's own
// 0700 mode and the OS, never by this function, which is why
// `viaWriteBridgeSocket` is checked FIRST, before even looking at the token
// -- a request that didn't arrive via the socket listener is never eligible
// for this principal type, full stop, regardless of what headers it
// carries; (2) the token itself, compared via the same length-guarded
// constant-time comparison actorSignature.js already established
// (constantTimeHexEqual), reused here rather than reimplemented -- a naive
// `===` string comparison here would leak timing information about how many
// leading bytes of a guessed token were correct.
//
// Exact-match path-scoping: the credential is only ever
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

  // Before this check, this boundary only verified the header carried A
  // valid tier STRING -- never that it actually met the specific action's
  // own declared minimum. The only real enforcement was routes.js's
  // writeExecuteRoute freshly recomputing actorTier from the real Discord
  // role snapshot before ever calling into Hop B; nothing here would have
  // caught a future second caller that skipped that step and simply
  // asserted a tier. Re-deriving the tier from live Discord role state at
  // this boundary would need the full role mapping threaded across Hop B (a
  // larger, separate change, not attempted here); this closes the concrete,
  // structural gap that matters today: Hop B itself now independently
  // rejects any asserted tier below what WRITE_ACTION_MIN_TIER requires for
  // this exact action, rather than trusting the caller's claim outright.
  // meetsMinTier() throws for an action with no WRITE_ACTION_MIN_TIER entry
  // -- caught here, not propagated, to preserve this function's documented
  // "any failure returns null" contract.
  try {
    if (!meetsMinTier(tier, action)) return null;
  } catch {
    return null;
  }

  const discordUserId = String(headers?.[WRITE_BRIDGE_ACTOR_USER_ID_HEADER] || "").trim();
  if (!discordUserId) return null;
  // The sender (writeBridgeInternalClient.js) encodeURIComponent()'s this
  // header so any real Discord display name -- not just ASCII ones -- can
  // survive as an HTTP header value at all. decodeURIComponent() can throw
  // on a malformed percent-sequence; falling back to the raw header value
  // rather than rejecting the whole request keeps this consistent with this
  // function's own "malformed input degrades gracefully, never crashes"
  // contract elsewhere (e.g. the tier/action checks above return null
  // instead of throwing).
  const rawUsernameHeader = String(headers?.[WRITE_BRIDGE_ACTOR_USERNAME_HEADER] || "").trim();
  let discordUsername;
  try {
    discordUsername = decodeURIComponent(rawUsernameHeader);
  } catch {
    discordUsername = rawUsernameHeader;
  }

  return {
    source: "discord-write-bridge",
    tier,
    // userId: audit.js's principalOf() reads session.userId for its
    // generic-session
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
