# Popup+poll Discord sign-in for the main console login — L1 Design

**Status:** Draft (revision 1)
**Tracking issue:** dune-awakening-selfhost-docker#574 (PROMPT 3, F4)
**Base:** `tier1-upstream` @ `e0ccbfca` (same base as F3; re-verify current
before implementation, per this feature-set's own established discipline)

**Security-sensitive: this touches the console's real login path.** Per the
issue's own text and this project's Requirement 20, this gets the full
Layer 1/2/3 treatment, not an abbreviated pass.

## 1. Problem / goal

Today, Discord sign-in for the main console is a **full-page redirect**:
clicking "Continue with Discord" navigates the whole tab to
`/api/auth/discord/start`, then to Discord, then back to
`/api/auth/discord/callback`, which sets the session cookie and serves an
HTML page that does `window.location.replace("/")` — a full reload of the
console. The Updates panel's "QA Tester Login" instead opens a **popup**
window and **polls** a status endpoint from the main page, which feels
smoother (the console itself never navigates away). The ask is to give the
main sign-in the same popup+poll *feel*, without changing what actually
decides whether someone gets in.

## 2. Verified current surfaces (read directly, not assumed)

- **The QA reference flow is NOT a template to copy architecturally.**
  `qaUpdates.js`'s `start()`/`status()` implement an **OAuth 2.0
  device-flow-shaped exchange against a third-party broker**
  (`https://dunedocker.app/api/v1/qa` by default) — the popup navigates to a
  URL the *broker* controls, the console never runs its own Discord OAuth
  client for this path, and the "poll" hits the *broker's* `/session`
  endpoint (bearer-token-authenticated) to learn whether a human approved
  the device code. None of that applies here: the main sign-in must keep
  using the operator's own Discord application (client ID/secret, redirect
  URI, PKCE) exactly as it does today — only the *presentation* (popup
  vs. full-page) and the *completion signal* (poll vs. redirect) change.
  What genuinely IS worth mirroring: `window.open("about:blank", ...)`
  immediately in the click handler (avoids popup-blocker heuristics that
  fire on an async-opened window), `popup.location.replace(url)` once the
  real URL is known, a bounded poll loop with a "popup was closed without
  completing → treat as cancelled" check, and a popup-blocked fallback path.
- **The existing OAuth security machinery needs zero changes.** Verified in
  `oauth.js`: `oauthStateCookie()` is already `SameSite=None; Secure;
  HttpOnly`, `Path=/api/auth/discord/callback` — chosen specifically
  because a cross-site top-level navigation (Discord → console) drops a
  `SameSite=Lax` cookie (a real past incident, see the file's own comment).
  A popup window navigating to the same callback URL is *also* a top-level
  navigation *within that popup*, from Discord's origin to the console's —
  identical cross-site relationship to today's full-page case. **The state
  cookie, PKCE verifier binding, and single-use pending-state consumption
  (`createPendingStateStore`) do not need to change at all** — only *how the
  flow was started* (full page vs. popup) needs to be recorded, so the
  callback knows which HTML to serve back.
- **The pending-state store already carries a `purpose` field through the
  full round trip** (`"login"` vs `"setup"`, consumed via `store.consume()`
  and read in `handleOAuthCallback`) — this is the existing, already-tested
  mechanism for "the callback needs to behave differently depending on how
  the flow started." A new field on the same object is the natural,
  zero-new-mechanism way to add "was this started as a popup."
- **The session cookie is `SameSite=Lax; Path=/`** (`sessionCookieValue()`,
  `server.js`). Cookies are per-origin, not per-tab: the instant the
  popup's callback response sets this cookie, it is immediately visible to
  *every* tab/window of that browser for this origin — including the
  opener. **This means the opener can learn "login succeeded" simply by
  polling the console's own existing, already-authenticated `GET
  /api/auth/me` endpoint — no new signal channel, no `postMessage`, no new
  endpoint is required for the success case.**
- **`auth.requireAuth()` fails clean for polling**: an unauthenticated `GET
  /api/auth/me` returns a plain `401` JSON body (`auth.js:122-136`) — no
  redirect, no side effect. `App.tsx`'s existing mount-time `/api/auth/me`
  fetch already tolerates a failure via `.catch()`. Polling this endpoint
  from the opener while the popup is still in flight is therefore safe and
  requires no new backend leniency.
- **`oauthReturnPage()`/`oauthErrorPage()`** (`server.js:6640-6653`) are the
  current callback responses: success does a full-page `window.location.
  replace("/")`; failure renders a readable HTML page with a link back to
  sign-in. Both are wrong verbatim for a **popup**: a success page must not
  navigate the small popup window to the full console UI, and a failure
  page needs a bounded lifetime (a popup that never closes on its own
  denies the opener its "was this cancelled" signal, since detecting
  `popup.closed` is the only fallback failure signal available without a
  richer status channel — see §3).

## 3. Design

### Starting the flow

`GET /api/auth/discord/start` gains an optional query flag,
`?presentation=popup`. When present, the pending state issued by
`store.issue()` additionally carries `presentation: "popup"` (a fourth field
alongside the existing `purpose`/`sessionId`/`owner`, default `"page"`).
Every other line of `/api/auth/discord/start`'s existing logic (rate
limiting, handoff/role-mapping misconfiguration checks, the state cookie
itself) is **unchanged** — this is purely an extra field riding through the
same already-tested pending-state object.

### The popup itself

Frontend (`App.tsx`, alongside the existing `loginQa`-equivalent pattern in
`UpdatesPanel.tsx`, but for the MAIN sign-in's "Continue with Discord"
button): open `window.open("about:blank", "console-discord-login",
"popup,width=480,height=720")` **synchronously in the click handler**
(popup-blocker-safe, same reasoning as the QA flow), then navigate it via
`popup.location.replace("/api/auth/discord/start?presentation=popup")`. If
`window.open` returns `null` (blocked), **fall back immediately to the
existing full-page redirect** (`window.location.href =
"/api/auth/discord/start"`, no `presentation` flag) — this is the explicit
no-JS/popup-blocked fallback the issue asks for, and it is the *existing,
already-shipped, already-audited* code path, not new code.

### Completion signal

The opener polls `GET /api/auth/me` on an interval (mirroring the QA flow's
2-second cadence and ~150-attempt bound — 5 minutes, generous for a human
completing a Discord login) until one of:
- **200 with a real user** → success. Update the same `userInfo`/
  `allowedActions`/`meLoaded` state the existing mount-time fetch already
  populates (reuse that function, don't duplicate it). Call `popup?.close()`
  defensively (it should already be closing itself, see below).
- **`popup.closed` becomes true before success** → treat as cancelled/failed,
  exactly like the QA flow's identical check. Show a message and stop
  polling. This is the **only** failure signal for the popup path — there is
  no attempt to smuggle a specific denial reason out of the popup (see §4's
  explicit non-goal).
- **Poll budget exhausted** → time out with an actionable message ("Discord
  sign-in did not complete in time — try again, or use the regular sign-in
  link").

No `postMessage` is used. This is a deliberate simplification over the
issue's own "postMessage-or-poll" framing: the session cookie is *already*
the trusted, un-forgeable channel (HttpOnly, SameSite=Lax, set only by the
server after full PKCE+state verification) — introducing `postMessage`
would add a second signal path to secure (origin checks, source-window
checks) for **zero** functional benefit, since polling the cookie-gated
`/api/auth/me` already can't be forged by a third party: a page on another
origin cannot read or set this console's cookies, and cannot cause
`/api/auth/me` to return a real user without the actual signed session
cookie being present. Flagged explicitly for the Security Architect hat to
confirm this reasoning holds.

### The silent-retry path must carry `presentation` forward too

**Found during this design's own research, not by the Eight Hats — worth
recording as a concrete example of why Layer 1 exists.** `handleOAuthCallback`
already has a **second** `issue()` call site: when Discord's first,
silent (`prompt=none`) attempt comes back needing real interaction
(`login_required`/`consent_required`/`interaction_required`), the console
re-issues a pending state and 302-redirects the **same window** back to
Discord for an interactive prompt (`server.js` ~line 6703):
`oauthPendingStates.issue(undefined, { purpose: consumed.purpose, sessionId:
consumed.sessionId, owner: rateKey })`. This already threads `purpose`/
`sessionId` through the retry — but **not** a `presentation` field, because
that field doesn't exist yet. If this design added `presentation` only to
the *first* `issue()` call site (§3's "Starting the flow"), a popup-initiated
login that needs the interactive retry (the common case for a first-time
sign-in, per this code's own comment: "`/start` always tries `prompt=none`
first") would silently lose its `presentation: "popup"` flag on retry — the
retry's own redirect keeps happening correctly inside the same popup window
(it's a server-side 302, unaffected by JS), but the **eventual callback**
that finally succeeds or fails would then see `consumed.presentation`
undefined and serve the **full-page** response inside the popup, which
would try to `window.location.replace("/")` and load the entire console UI
inside a 480×720 popup. **Fix, part of this design, not deferred to
implementation:** the retry's `issue()` call must also pass `presentation:
consumed.presentation`. This must have an explicit test (§5) — the exact
class of bug Layer 1 audits over a design doc (rather than starting straight
from code) are supposed to catch before it ships.

### The callback's response, by presentation

`handleOAuthCallback` already has `consumed` (the result of
`store.consume()`) in scope at the point it decides success/failure.
Branching only on `consumed.presentation === "popup"`:
- **Success:** serve a new, minimal self-closing page (`oauthPopupReturnPage()`)
  instead of `oauthReturnPage()` — sets no navigation, just `window.close()`
  in a `<script>` (works because the popup was opened via `window.open`) and
  a plain-text fallback ("Signed in. You can close this window.") for the
  rare case script execution is blocked. The session cookie is set on this
  same response exactly as today — **the opener sees it on its very next
  poll**, typically before the popup has even finished closing.
- **Failure:** serve the **existing, unchanged** `oauthErrorPage(message)` —
  same specific, actionable text as today (2FA required, not authorized,
  role mapping unsound, etc.) — with one addition when
  `consumed.presentation === "popup"`: a short auto-close timer (a few
  seconds) so an operator who doesn't manually close the popup still lets
  the opener's `popup.closed` check fire reasonably promptly, after having
  had a real chance to read the specific reason.

### Non-goals

- Does **not** touch the guided Discord *setup* wizard flow (`purpose:
  "setup"`) — that flow already has its own, separately-built return
  mechanism (the `DISCORD_SETUP_RETURN_KEY` sessionStorage marker built
  earlier in this same feature line) and is out of scope here.
- Does **not** add a `postMessage` channel (see above) or a new
  status-with-reason endpoint mirroring `qaUpdates.js`'s richer `/session`
  response — the binary "is `/api/auth/me` now authenticated" signal is
  judged sufficient, since the specific reason is still shown *in the
  popup itself* via the existing `oauthErrorPage()`.
- Does **not** change PKCE, the state cookie's attributes, single-use
  pending-state consumption, or any tier-resolution logic — this is
  presentation-layer only.

## 4. Explicit questions for the Eight Hats

- **Security Architect:** does the "no `postMessage`, poll the existing
  cookie-gated endpoint" reasoning in §3 actually close the issue's own
  concern ("a completion signal can't be forged by a third party")? Is
  there any way a malicious page (in another tab, or an iframe) could
  cause the opener to observe a false-positive "authenticated" poll result,
  or interfere with the popup/opener relationship (e.g., `window.open`
  window-naming collisions — the fixed name `"console-discord-login"` means
  a second concurrent login attempt reuses the same popup; is that a race
  or just a UX quirk)?
- **Security Architect / Network:** is there any risk from the popup and
  opener being same-origin windows sharing cookies mid-flow — e.g., could
  the opener's own concurrent activity (another tab open to Settings,
  say) observe or interfere with the in-flight pending state?
- **UI/UX:** is "poll until success or popup-closed, with only a generic
  cancelled message" an acceptable UX regression from today's specific,
  readable full-page error messages, given the specific reason IS still
  shown inside the popup itself? Is the auto-close timer's length (a few
  seconds, unspecified exactly) long enough to actually read a real message
  like the 2FA-required text?
- **QA:** what does the Requirement 19(e) end-to-end redirect-chain test
  need to cover for the popup variant specifically, beyond what
  `oauthRoutes.integration.test.js`'s existing `signInWithCode()`-based
  tests already exercise for the full-page path? Is a single shared test
  helper (parameterized by `presentation`) the right shape, or does the
  popup path need its own dedicated suite section?
- **Architect:** is a query-string flag (`?presentation=popup`) the right
  place for this, or should it be a POST body field / header, given
  `/api/auth/discord/start` is a `GET` route today (a query flag matches
  its existing `?setup=1` precedent for the setup-mode flag — confirm this
  precedent before assuming it's the right pattern to extend).
- **GRC:** does `docs/rfc-console-auth.md` or another operational doc need
  updating to describe this second entry point, and does this change need
  a changelog note for operators who might have any client-side automation
  or embedding assumptions about the current full-page flow?

## 5. Tests (Requirement 19(e) mandatory end-to-end coverage)

- The full redirect chain for `presentation=popup`, exactly mirroring
  `oauthRoutes.integration.test.js`'s existing `signInWithCode()` pattern:
  start (with the popup flag) → real `Set-Cookie` on the state cookie → a
  real HTTP request to the callback carrying that cookie → real session
  cookie set on success. Must assert the state cookie's exact attributes
  (`SameSite=None; Secure; HttpOnly`) are unchanged for this path.
- The popup success response is the new self-closing page, not
  `oauthReturnPage()`'s full-page redirect — and vice versa, the
  `presentation` omitted (or `page`) path still gets today's unchanged
  `oauthReturnPage()`.
- A denied/failed popup-path callback still serves the existing
  `oauthErrorPage()` content (same specific messages), with the added
  auto-close script only on the popup variant.
- **The silent-retry path** (`login_required`/`consent_required`/
  `interaction_required`) preserves `presentation: "popup"` through the
  retry's own `issue()` call, so a popup login that needs the interactive
  round trip still gets the self-closing popup response on its eventual
  completion, not the full-page one. This must be a real end-to-end test,
  not a code-reading assertion: drive a popup-flagged start through a
  simulated `login_required` response and confirm the *final* callback
  response (after the retry) is still the popup variant.
- `/api/auth/me` polling tolerance: a 401 before login completes does not
  throw or redirect (already true today — a regression test pinning it,
  since the new frontend polling code now depends on this behavior that
  was previously incidental).
- Frontend: the popup-blocked fallback actually triggers the existing
  full-page `window.location.href` path when `window.open` returns null.
- Frontend: polling stops and shows a cancelled message when `popup.closed`
  becomes true before success.
