// autoInvite.js -- Core-side integration for the fully-automated hosted-bot
// auto-invite flow (dune-awakening-selfhost-docker#832's design, Phase 6,
// docs/design/hosted-bot-auto-invite-and-role-picker-l1-design-2026-09-10.md
// §4.1/§4.4/§4.5). Deliberately a SIBLING to hostedBotOAuth.js's existing
// "Connect to hosted bot" flow, not a modification of it -- both coexist
// until this new flow is confirmed working end-to-end (§9 Option B); this
// file's own routes/cookies use distinct names so the two flows can never
// be confused mid-flight, matching hostedBotOAuth.js's own stated
// convention for why IT is a sibling of oauth.js.
import { constantTimeStringEqual } from "./oauth.js";

// Sahir Venn's existing, shared, org-owned Discord Application -- the SAME
// client_id "Add to Discord" already uses today (see
// console/web/src/features/settings/DiscordBotSection.tsx's
// MENTAT_BOT_INVITE_URL). The whole point of this flow (design doc goal
// G2) is that the operator never creates or configures their own Discord
// Application, so this is a fixed, public constant, not operator
// configuration -- there is exactly one correct value in every real
// deployment.
export const AUTO_INVITE_DISCORD_CLIENT_ID = "1546203607807041697";
const AUTO_INVITE_DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";

// One consent screen (design doc goal G1): bot install + applications.commands
// (matching the existing invite link's own scope) PLUS identify+guilds (new
// -- lets mentat independently re-verify guild ownership after this single
// consent, the same load-bearing security property /register's own flow
// already depends on). permissions=128 matches the existing static
// MENTAT_BOT_INVITE_URL's own value exactly -- not a new permission grant.
export function buildAutoInviteAuthorizeUrl({ redirectUri, state }) {
  const url = new URL(AUTO_INVITE_DISCORD_AUTHORIZE_URL);
  url.searchParams.set("client_id", AUTO_INVITE_DISCORD_CLIENT_ID);
  url.searchParams.set("scope", "bot applications.commands identify guilds");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("permissions", "128");
  return url.toString();
}

const AUTO_INVITE_PENDING_TTL_MS = 20 * 60 * 1000;
const AUTO_INVITE_MAX_PENDING = 256;

// createAutoInvitePendingStateStore: Core's OWN copy of "this state was
// issued by this console, still pending" -- consumed exactly once by
// /auto-invite/complete (design doc §4.5, hostedBotAutoInvitePendingStates).
// Deliberately NOT oauth.js's createPendingStateStore() reused as-is: this
// store never needs PKCE (Core itself never exchanges a code in this flow
// -- that happens entirely on mentat's side, see the design doc's own
// "why state alone, no PKCE, on the mentat leg" reasoning, §4.5), so a
// dedicated, simpler shape avoids carrying unused challenge/verifier
// fields through code that will never read them.
//
// TTL is deliberately generous (20 minutes, not the shorter windows
// elsewhere in this flow) -- per the design doc's own §4.5 note, this
// store must survive the FULL owner-confirmation wait (mentat's own
// pendingOwnerConfirmations store uses 15 minutes) plus slack for this
// console's own return-leg processing, not the much shorter 2-minute
// autoInviteSessions TTL that bounds mentat's OWN first-leg window.
// issue() takes MENTAT's own state value as input (returned by mentat-link's
// /auto-invite/start proxy call), rather than generating a fresh one of its
// own -- unlike the OLD flow's PKCE-based store, this one's state value is
// the SAME string that round-trips all the way through Discord's own
// consent screen and back through mentat's signed redirect (design doc
// §4.1's sequence diagram: "window.open(discord authorize URL,
// state=<mentat's state>, popup)"). Recording THAT exact value as the
// double-submit-cookie pair (rather than minting an unrelated second
// value Core would then need to separately correlate with mentat's) is
// simpler and no less secure: an attacker would need to forge a cookie
// matching a state value that ALSO exists as a genuine entry in this
// store, which only happens for a state this route itself actually
// issued via a real call to mentat-link.
export function createAutoInvitePendingStateStore({
  now = () => Date.now(),
  ttlMs = AUTO_INVITE_PENDING_TTL_MS,
  maxEntries = AUTO_INVITE_MAX_PENDING
} = {}) {
  const pending = new Map();

  function issue(state) {
    if (typeof state !== "string" || state.length === 0) return null;
    if (pending.size >= maxEntries) return null;
    pending.set(state, { createdAt: now(), used: false });
    return { state };
  }

  function consume(state, cookieValue, timestamp = now()) {
    if (typeof state !== "string" || state.length === 0 || state.length > 128) {
      return { ok: false, reason: "invalid_state" };
    }
    if (typeof cookieValue !== "string" || cookieValue.length === 0) {
      return { ok: false, reason: "missing_state_cookie" };
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

// Distinct cookie name/path from hostedBotOAuthStateCookie() (the OLD
// flow's own state cookie) -- same reasoning as this file's own header
// comment: the two flows must never be confusable mid-flight. SameSite=Lax
// (not None, unlike the old flow's cookie): this cookie is read back on
// /auto-invite/complete, reached via a normal top-level browser navigation
// FROM mentat-link's bounce page (a client-side window.location assignment,
// the same category of navigation as clicking a same-site link) -- not a
// direct cross-site redirect from Discord itself the way the old flow's
// /oauth/callback is, so Lax is sufficient here.
export function autoInviteStateCookie(value, secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `auto_invite_state=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/api/integrations/discord/hosted-bot/auto-invite; Max-Age=1200${securePart}`;
}

export function clearAutoInviteStateCookie(secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `auto_invite_state=; HttpOnly; SameSite=Lax; Path=/api/integrations/discord/hosted-bot/auto-invite; Max-Age=0${securePart}`;
}

// autoInviteCompletePage: the popup's own return page (design doc §4.1:
// "Core-->>Op: Small return page (mirrors existing hostedBotOAuthReturnPage()),
// auto-closes popup"). Deliberately DIFFERENT closing behavior from
// hostedBotOAuthReturnPage() above: that one does a full top-level
// window.location.replace("/") because the OLD flow's own OAuth round trip
// is NOT a popup; THIS flow's whole point (design doc goal G1) is a SINGLE
// popup covering bot-invite + ownership verification, so its own return
// leg must close the popup and hand the outcome back to the opener, not
// navigate the popup itself anywhere.
//
// Uses postMessage rather than openBotInviteWindow()'s existing bare
// `.closed`-poll pattern -- that mechanism can only tell the opener "the
// popup closed," with no way to carry WHICH outcome (ok/guildName/reason/
// reclaimed) occurred. The visible on-page text is deliberately a FIXED,
// generic string (never guildName/reason interpolated into raw HTML) --
// the real outcome data only ever reaches the opener via the JSON-encoded
// postMessage payload, which Core's own React app renders using JSX's own
// auto-escaping, sidestepping any HTML-escaping-discipline risk here
// entirely rather than relying on getting it right in this template
// string. postMessage's targetOrigin is this page's own window.location.origin
// (never "*") -- the opener is always this exact same console origin.
export function autoInviteCompletePage({ ok, guildName = "", reason = "", reclaimed = false }) {
  const payload = { ok: Boolean(ok), guildName: String(guildName), reason: String(reason), reclaimed: Boolean(reclaimed) };
  const safeJson = JSON.stringify(payload).replace(/</g, "\\u003c");
  const message = ok ? "Request sent — check Discord to confirm the connection." : "Could not connect. Check the console for details.";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Connecting…</title></head><body><p>${message}</p><noscript><p>Close this window and return to the console.</p></noscript><script>
var result = ${safeJson};
try {
  if (window.opener) {
    window.opener.postMessage({ type: "hosted-bot-auto-invite-complete", result: result }, window.location.origin);
  }
} catch (e) {}
setTimeout(function () { window.close(); }, 1200);
</script></body></html>`;
}
