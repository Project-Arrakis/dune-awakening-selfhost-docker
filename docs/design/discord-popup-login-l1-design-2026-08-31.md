# Popup+poll Discord sign-in for the main console login — L1 Design

**Status:** Revision 2 (post Eight Hats Layer 1 audit — see §6)
**Tracking issue:** dune-awakening-selfhost-docker#574 (PROMPT 3, F4)
**Base:** `tier1-upstream` @ `e0ccbfca` (same base as F3; re-verify current
before implementation, per this feature-set's own established discipline)

**Security-sensitive: this touches the console's real login path.** Per the
issue's own text and this project's Requirement 20, this gets the full
Layer 1/2/3 treatment, not an abbreviated pass.

## 1. Problem / goal

Today, Discord sign-in for the main console is a **full-page redirect**:
clicking "Continue with Discord" (a plain `<a href="/api/auth/discord/start">`,
`App.tsx:908` — **not** a button with a click handler, unlike this design's
first revision implied) navigates the whole tab to
`/api/auth/discord/start`, then to Discord, then back to
`/api/auth/discord/callback`, which sets the session cookie and serves an
HTML page that does `window.location.replace("/")` — a full reload of the
console. The Updates panel's "QA Tester Login" instead opens a **popup**
window and **polls** a status endpoint from the main page, which feels
smoother. The ask is to give the main sign-in the same popup+poll *feel*,
without changing what actually decides whether someone gets in.

## 2. Verified current surfaces (read directly, not assumed)

- **The QA reference flow is NOT a template to copy architecturally.**
  `qaUpdates.js`'s `start()`/`status()` implement an **OAuth 2.0
  device-flow-shaped exchange against a third-party broker**
  (`https://dunedocker.app/api/v1/qa`) — the console never runs its own
  Discord OAuth client for that path. The main sign-in must keep using the
  operator's own Discord application (client ID/secret, redirect URI, PKCE)
  exactly as today — only *presentation* and *completion signal* change.
  Worth mirroring: `window.open("about:blank", ...)` synchronously in the
  click handler, `popup.location.replace(url)` once the real URL is known, a
  bounded poll with a "popup closed without completing" check, and a
  popup-blocked fallback. **Not worth mirroring, and explicitly must be
  fixed rather than copied (Architect + QA hats, both independently
  confirmed by reading the reference code):** `loginQa()`'s poll loop
  (`UpdatesPanel.tsx:147-175`) is a plain `for` loop of `await new
  Promise(setTimeout...)`, not a `useEffect`-owned, cleanup-safe interval —
  copied verbatim it would keep polling `/api/auth/me` for up to 5 minutes
  after the component unmounts (the operator navigates away mid-login),
  mutating dead state. §3 below specifies a cancellable loop instead.
- **The existing OAuth security machinery needs zero changes.**
  `oauthStateCookie()` is `SameSite=None; Secure; HttpOnly;
  Path=/api/auth/discord/callback` — a popup's top-level navigation to
  Discord and back is cross-site in exactly the relationship this attribute
  already exists to survive; SameSite is evaluated per-navigation, never
  per-window. **Independently confirmed by three hats (Architect, Security
  Architect, GRC)** reading `oauth.js` directly. PKCE verifier binding and
  single-use pending-state consumption (`createPendingStateStore`) need no
  change — only *how the flow was started* needs to be recorded.
- **The pending-state store already carries `purpose`/`sessionId`/`owner`
  through the full round trip** — the existing, already-tested mechanism
  for "the callback needs to behave differently depending on how the flow
  started." **Confirmed by the Architect and Security Architect hats
  reading `oauth.js`'s `consume()` function directly: `consume()`'s return
  statement currently surfaces only `{ok, verifier, purpose, sessionId}` —
  it does NOT pass through `entry.owner` today, and would not pass through
  a new `entry.presentation` either without its own explicit edit.** A new
  field on the pending-state object is not automatically visible to
  `handleOAuthCallback` just because `issue()` stored it — `consume()` must
  be extended too. This is now an explicit, named implementation step (§3),
  not an assumption.
- **The session cookie is `SameSite=Lax; Path=/`, `HttpOnly`**
  (`sessionCookieValue()`), set only by a same-origin server response after
  full PKCE+state verification — never at risk from any cross-origin actor,
  and this cookie is what makes `/api/auth/me` polling viable at all (see
  below): cookies are per-origin, not per-window, so the instant the
  popup's callback sets it, every tab/window of that browser origin
  (including the opener) sees it on its very next request.
- **`/api/auth/me` is the wrong endpoint to poll — `/api/auth/state` is the
  right one. This is the single most significant correction in this
  revision, found by the Architect hat and independently confirmed by
  reading `App.tsx` directly.** `App.tsx` gates the entire authenticated UI
  on `auth` (`useState(false)`) and gates every mutating request's CSRF
  header on `csrfToken`, both of which are set together **only** by
  `/api/auth/state`'s response (`{authenticated, csrfToken, ...}`,
  `App.tsx:488-503`) or by the password-login response body — **never** by
  `/api/auth/me`, whose response shape has no `csrfToken` field at all.
  Polling `/api/auth/me` as revision 1 proposed would, on success, populate
  `userInfo`/`allowedActions` but leave `auth` false and `csrfToken` stale
  — the console would keep showing the login screen, or (if `auth` were
  force-set some other way) silently 403 every mutating action
  ("Your browser login session expired") until a full reload. **Fix:** poll
  `GET /api/auth/state` instead. It is already `auth.readSession`-backed
  (never `requireAuth`, so it never 401s), and calling `setAuth(true)` +
  `setCsrfToken(state.csrfToken)` on success triggers the **existing**
  `[auth]`-keyed effect that already fetches `/api/auth/me` and populates
  `userInfo`/`allowedActions` — this is what "reuse the existing fetch,
  don't duplicate it" actually means once traced through the real state
  graph, not polling `/api/auth/me` directly.
- **`oauthReturnPage()`/`oauthErrorPage()`** are the current callback
  responses: success does a full-page `window.location.replace("/")`;
  failure renders readable HTML with a link back to sign-in. Both are wrong
  verbatim for a popup (see §3).
- **New finding, Security Architect hat: `window.open()` creates an
  unmitigated `window.opener` reference (reverse-tabnabbing risk).**
  Grepped the whole `console/` tree: zero occurrences of `noopener`,
  `Cross-Origin-Opener-Policy`, or any `window.opener` handling anywhere.
  Once the popup navigates to Discord's authorize domain (a third-party
  origin), nothing severs `popup.opener` — a malicious or compromised page
  reached via an open redirect in that chain could, in principle, run
  `window.opener.location = "..."` and silently redirect the console tab
  the operator is still looking at, while their attention is on the popup.
  `rel="noopener"` is not usable here (it makes `window.open()` return
  `null`, breaking the `popup.closed`/`popup?.close()`/
  `popup.location.replace()` control this design needs) — the fix is a
  `Cross-Origin-Opener-Policy: same-origin` response header, which severs
  `popup.opener` the moment the popup navigates cross-origin while
  preserving the opener's own already-held reference. **This exact gap
  already exists, unnoticed, in the shipped QA popup flow
  (`UpdatesPanel.tsx:148`)** — not a new risk class introduced by this
  design, but the right moment to fix both, since this design is about to
  extend the same unmitigated pattern from a low-traffic QA feature to the
  primary sign-in button every operator uses.

## 3. Design (revision 2 — incorporates all HIGH/MEDIUM Eight Hats findings)

### Starting the flow

`GET /api/auth/discord/start` gains an optional query flag,
`?presentation=popup` (consistent with the existing `?setup=1` precedent,
confirmed appropriate by the Architect hat — `sanitizedUrl()` already strips
query strings before every audit-log write, so this adds no logging
exposure). The pending state issued by `store.issue()` carries
`presentation: "popup"` (default `"page"`) alongside the existing
`purpose`/`sessionId`/`owner`. **`store.consume()`'s return object must be
extended to include `presentation`** (§2's finding — not automatic).

### Response headers: `Cross-Origin-Opener-Policy`

Add `Cross-Origin-Opener-Policy: same-origin` to the console's response
headers (the existing `withSecurityHeaders()` helper in `auth.js` is the
natural home, alongside `X-Frame-Options: DENY` etc. — applying it
globally, not just to the OAuth routes, since the QA popup flow needs the
same fix and there is no reason for it to differ route-by-route). **Must be
verified empirically in a real browser before shipping** (Security
Architect hat's explicit instruction) — exact `window.opener` severance
timing across browsers is not something to assume correct from
spec-reading alone on a live login path.

### The popup itself

`App.tsx`'s "Continue with Discord" control gains an `onClick` handler
(converting from a bare `<a href>`, per the Architect hat's correction to
revision 1's inaccurate "alongside the existing loginQa pattern" framing —
no such click-handler scaffold exists on this control today). The handler:
calls `event.preventDefault()` only when it successfully proceeds with the
popup path; a modifier-click (ctrl/cmd/middle-click) is **not**
intercepted, so it falls through to native anchor behavior and opens the
current full-page flow in a new tab — a reasonable, unsurprising outcome
for a user who explicitly asked for a new tab, not a gap to close.

On a plain click: **disable the control synchronously, before any await**
(UI/UX + Architect hats: prevents a second click mid-flight from opening a
second competing poll loop against the same named popup window — the fixed
name `"console-discord-login"` is confirmed by the Security Architect hat
to be purely a UX race, never a security issue, since the pending-state
store is keyed by the random `state` value, not by window identity, and a
mismatched retry fails closed on `state_cookie_mismatch` — but the
synchronous disable is still required as the actual mitigation, not the
window name). Then: `window.open("about:blank", "console-discord-login",
"popup,width=480,height=720")`, then `popup.location.replace(
"/api/auth/discord/start?presentation=popup")`. If `window.open` returns
`null` (blocked), fall back **on the same click** to the existing full-page
redirect (`window.location.href = "/api/auth/discord/start"`, no
`presentation` flag) — automatic, no second click required (UI/UX hat:
this is already better than the QA reference, which throws an error
requiring a manual retry after enabling popups; keep it that way).

### Completion signal (corrected: poll `/api/auth/state`, cancellable)

A `useEffect`-owned poll loop (an interval, not `loginQa`'s uncancellable
`for`/`await sleep` loop — QA hat finding), cleared on unmount via the
effect's cleanup function or an `AbortController`/mounted-ref guard so no
fetch or state update ever fires after the component unmounts:
- Every ~2 seconds (bounded to ~150 attempts / 5 minutes, matching the QA
  flow's cadence), call `GET /api/auth/state`.
- **`authenticated: true`** → call `setAuth(true)` + `setCsrfToken(
  state.csrfToken)` (the fix from §2) → this alone triggers the existing
  `[auth]`-effect to fetch `/api/auth/me` and populate
  `userInfo`/`allowedActions`. Call `popup?.close()` defensively. Stop
  polling, re-enable the control.
- **`popup.closed` becomes true before success** → stop polling, re-enable
  the control, show a message (exact copy TBD at L2, but **must be
  non-empty** — the QA reference's identical branch silently clears its
  error state with no message at all, which the UI/UX hat flagged as a
  likely-to-be-copied gap to explicitly avoid here, since an accidentally
  closed popup with zero feedback reads as "did anything happen?").
- **Budget exhausted** → stop, show a timeout message, re-enable the
  control.

No `postMessage` is used — the session cookie is already the trusted,
un-forgeable channel; introducing `postMessage` would add a second signal
path to secure for no benefit, confirmed sound by the Security Architect
hat (a page on another origin cannot read/set this console's cookies or
otherwise cause `/api/auth/state` to report authenticated without the real
signed cookie present).

### The callback's response, by presentation

Branching on `consumed.presentation === "popup"`:
- **Success:** a new, minimal self-closing page (`oauthPopupReturnPage()`)
  — `window.close()` in a `<script>`, plain-text fallback ("Signed in. You
  can close this window.") if script execution is blocked. Session cookie
  set on this same response exactly as today.
- **Failure: do NOT auto-close.** **Revised from revision 1 per the UI/UX
  hat's HIGH finding**: revision 1's "auto-close after a few seconds" risked
  an operator never actually reading the specific, actionable message
  (2FA required, not authorized, role mapping unsound, etc.) before the
  popup vanished — a real dead end, not a cosmetic one, since the main
  page's only fallback message is a generic "cancelled." The popup instead
  serves the **existing, unchanged** `oauthErrorPage(message)` with **no**
  auto-close script at all — the operator reads the real reason and closes
  it themselves (a manual close still fires the opener's `popup.closed`
  check, ending the poll with the generic message as a safety net, but the
  operator will already have read the specific one). This trades a slightly
  longer-lived popup for never losing an actionable error — the right
  tradeoff for a login failure path.

### The silent-retry path carries `presentation` forward

The existing `login_required`/`consent_required`/`interaction_required`
retry branch's own `issue()` call gains `presentation: consumed.presentation`
alongside its existing `purpose`/`sessionId`. Without this, a popup login
needing the interactive retry (the common first-time-sign-in case, per this
code's own comment that `/start` always tries `prompt=none` first) would
lose the flag on retry and load the full console UI inside the popup on
eventual success.

### Non-goals

- Does **not** touch the guided Discord *setup* wizard flow (`purpose:
  "setup"`) — separately-built, out of scope. **Explicit guardrail (GRC
  hat):** a future change must not casually extend `presentation: "popup"`
  support to `purpose: "setup"` without its own fresh Layer 1/2 pass — the
  two fields are independent by type today, and must stay that way without
  a deliberate, audited decision to combine them.
- Does **not** add a `postMessage` channel or a richer status-with-reason
  endpoint mirroring `qaUpdates.js` — the specific reason is shown *in the
  popup itself*.
- Does **not** change PKCE, the state cookie's attributes, single-use
  pending-state consumption, or any tier-resolution logic.

## 4. Test-coverage strategy for the popup/cross-window mechanic (GRC HIGH finding, resolved)

**No Playwright or other real-browser E2E tooling exists anywhere in this
repository** (confirmed: no `playwright` dependency in any `package.json`,
no `playwright.config.*` anywhere in the tree). The GRC hat's finding that
no real-browser test is committed to for the actual `window.open`/
cross-window/`popup.closed` mechanic is correct and would otherwise be a
real audit-trail gap — Requirement 19(e) exists precisely because a past
incident (the `SameSite=Lax` bug) evaded non-browser testing once already.
Rather than introduce new E2E infrastructure as a side effect of one
feature (a real, separate infrastructure decision this design does not
make unilaterally), coverage is split explicitly across three layers, each
verifying what it can actually verify:
1. **Backend HTTP integration tests** (real spawned server, real request
   chain, exactly `oauthRoutes.integration.test.js`'s established pattern)
   — the redirect chain, cookie attributes, and the presentation-aware
   callback response shape. This is genuinely real HTTP, not mocked.
2. **Frontend unit tests** (mocked `window.open`/`fetch`) — the JS state
   machine: disables-on-click, popup-blocked fallback, poll-until-success,
   popup-closed handling, and unmount cleanup (no fetch fires after
   unmount — directly testing the QA hat's confirmed leak-risk fix).
3. **Mandatory manual UAT case, in a real browser, against a real
   deployment** — the actual `window.open`/cross-window cookie visibility/
   `Cross-Origin-Opener-Policy` behavior, which is standard browser
   platform behavior (not console-specific logic) and is exactly what this
   project's own T-numbered UAT-doc discipline exists to cover cheaply
   without new test infrastructure. This is a **release-blocking** UAT
   case, not an optional one, given the security sensitivity.

## 5. Tests (Requirement 19(e) mandatory end-to-end coverage)

- The full redirect chain for `presentation=popup`, mirroring
  `oauthRoutes.integration.test.js`'s `signInWithCode()` pattern, asserting
  the state cookie's attributes are unchanged. **QA hat's correction:** this
  assertion by itself is not popup-specific (the cookie function isn't
  branched on `presentation` at all) — it must be combined, in the SAME
  test, with an assertion that the response is the new self-closing popup
  page, or it is dead-weight coverage relative to what this feature
  actually changes.
- The `presentation` omitted (or `"page"`) path still gets today's
  unchanged `oauthReturnPage()` — a direct regression guard.
- A denied/failed popup-path callback serves the existing
  `oauthErrorPage()` content with **no** auto-close script (revised: no
  auto-close at all, see §3).
- **The silent-retry chain, done in full, not shallow (QA hat's HIGH
  finding — the shallow version is a tautology relative to the bug it
  claims to catch):** start(popup) → callback with `?error=login_required`
  → capture the **retry's own fresh state cookie** from that response →
  a **second** callback call using that cookie with a real code → assert
  *that* final response is the popup variant. Stopping at the retry's 302
  shape (state, prompt-less URL) never actually reads `consumed.
  presentation` post-retry and would pass even with the regression this
  design exists to prevent.
- **A popup-flagged pending state is still counted/evicted by
  `MAX_PENDING_PER_OWNER` like any other** (QA hat: this project has a real
  prior incident — a retry's `issue()` call once omitted `owner`, pooling
  requests into one unattributed, uncounted bucket, `oauth.test.js`'s
  existing regression test at "the silent-auth interactive retry
  attributes its pending state to an owner, like every other issue() call
  site"). A cheap source-pin or behavioral check that `presentation` didn't
  introduce a second store or bypass this eviction path.
- `/api/auth/state` polling tolerance regression test (never 401s, unlike
  `/api/auth/me` — the new frontend code depends on this).
- Frontend: popup-blocked fallback triggers the full-page path on the SAME
  click (no second interaction).
- Frontend: polling stops with a non-empty message when `popup.closed`
  becomes true before success.
- Frontend: **no fetch or state update occurs after the component
  unmounts mid-poll** (QA hat's confirmed leak-risk finding — must be a
  real test, not just a code-review assertion that the cleanup exists).
- `Cross-Origin-Opener-Policy: same-origin` header present on relevant
  responses — a header-presence test plus the mandatory manual UAT case
  (§4) for actual cross-window-severance behavior in a real browser.

## 6. Eight Hats Layer 1 audit — findings summary

Full independent dispatch, 8 agents, each reading the real code directly
before reporting.

| # | Hat | Severity | Finding | Resolution |
|---|-----|----------|---------|------------|
| 1 | Architect | **HIGH** | Polling `/api/auth/me` (rev 1) never sets `auth`/`csrfToken` — every popup login would leave the console stuck on the login screen or silently 403ing every mutation | Fixed in revision 2: poll `/api/auth/state` instead (§2, §3) |
| 2 | UI/UX | **HIGH** | Auto-closing the popup on failure (rev 1) risks losing the specific, actionable error message before the operator can read it | Fixed in revision 2: no auto-close on failure at all (§3) |
| 3 | QA | **HIGH** | `loginQa()`'s reference poll loop is a plain uncancellable `for` loop — copied verbatim it leaks background polling past component unmount | Fixed in revision 2: cleanup-safe `useEffect` interval (§3) |
| 4 | QA | **HIGH** | The silent-retry test, as loosely specified in rev 1, is a tautology unless it chains through a second real callback call | Made explicit and specific in §5 |
| 5 | GRC | **HIGH** | No real-browser E2E test committed to for the actual popup/cross-window mechanic | Resolved via an explicit three-layer coverage strategy (§4), given no E2E tooling exists in this repo; a mandatory real-browser UAT case is release-blocking |
| 6 | Security Architect | MEDIUM (STRIDE: Tampering/Spoofing) | Uncontrolled `window.opener` reference is a reverse-tabnabbing risk once the popup navigates to a third-party origin (Discord) — also already present, unnoticed, in the shipped QA flow | Fixed in revision 2: `Cross-Origin-Opener-Policy: same-origin` on console responses, verified empirically in a real browser before shipping |
| 7 | Architect / Security Architect | MEDIUM (dual-found) | `consume()` does not currently pass through `entry.owner`, and would not pass through a new `entry.presentation` without its own explicit edit | Made an explicit, named implementation step (§2, §3) rather than an assumption |
| 8 | QA | MEDIUM | Missing test: a popup-flagged pending state is still counted/evicted by `MAX_PENDING_PER_OWNER`, matching a real prior incident in this exact file | Added to §5 |
| 9 | QA | MEDIUM | The "state cookie attributes unchanged" test, taken alone, isn't popup-specific and risks masquerading as coverage of the new code | Merged into one test with the popup-response assertion (§5) |
| 10 | GRC | MEDIUM | `docs/rfc-console-auth.md` update was posed as a rhetorical question in rev 1, not committed to | Committed: same-PR doc update required (implementation checklist) |
| 11 | UI/UX | MEDIUM | Fixed popup window name + no explicit synchronous button-disable requirement | Made explicit: disable synchronously on click, before any await (§3) |
| 12 | Architect | LOW | The current sign-in control is a bare `<a href>`, not a button with a click handler as rev 1 implied | Corrected in §1/§3; modifier-click/new-tab semantics explicitly preserved |
| 13 | Network | LOW | `/api/auth/me`/`/api/auth/state` have no dedicated rate limiter today (pre-existing, not introduced by this change) | Noted as an opportunistic hardening item, non-blocking |
| 14 | Cloud Security | LOW | General popup-phishing risk against Discord's own domain | Bounded by the browser and Discord's own page; not this design's responsibility |
| 15 | GRC | LOW | The session cookie's `SameSite=Lax` safety reasoning was implicit | Made explicit in §2 |
| 16 | GRC | LOW | No explicit guardrail against future scope creep into `purpose: "setup"` reuse of `presentation=popup` | Added to §3 non-goals |
| 17 | GRC | LOW | CHANGELOG entry has no home on this upstream-bound branch | Deferred to a fork-`main` post-merge commit, matching the #647/#648/#651 precedent |
| 18 | UI/UX | LOW | Busy-label/disabled-button copy left implicit | Deferred to L2 implementation, non-blocking |

**Non-findings (explicitly confirmed correct, no action needed):**
- Security Architect: this design introduces no new way to mint, forge, or
  prematurely trust a session — the OAuth/PKCE/tier-resolution logic is
  completely untouched; the SameSite=None state-cookie reasoning holds
  exactly as claimed; the poll-vs-postMessage reasoning is sound; the fixed
  popup window name is a pure UX race, never a cross-flow authorization
  mixup (the pending-state store is keyed by the random `state` value, not
  window identity); the silent-retry `presentation` loss (absent the
  reverse-tabnabbing finding) would only ever load the real, correctly
  authenticated console inside the popup — no privilege escalation.
- Network: no new endpoint, port, or outbound dependency; the redirect URI
  is unchanged and identical for both presentations.
- Cloud Security: no new credential, secret, or trust relationship;
  Discord's own OAuth behavior is unaffected by popup vs. full-page.
- DBA: no schema/migration/persistence concern; the in-memory pending-state
  Map's existing bounds (`MAX_PENDING_STATES`, `MAX_PENDING_PER_OWNER`) are
  unaffected by one more small field per entry.

### STRIDE summary (Layer 1)

| STRIDE Category | Finding(s) | Severity | Status |
|---|---|---|---|
| Spoofing | #6 (reverse-tabnabbing via `window.opener`) | MEDIUM | Resolved in design (COOP header + real-browser verification) |
| Tampering | #6 (dual-mapped with Spoofing) | MEDIUM | Resolved in design |
| Repudiation | None found | N/A | — |
| Information Disclosure | None found | N/A | — |
| Denial of Service | Network hat's LOW (no dedicated rate limit on the polled endpoint, pre-existing) | LOW | Non-blocking, opportunistic hardening noted |
| Elevation of Privilege | None found — confirmed no new session-minting path | N/A | — |

All HIGH findings (#1-#5) and the one MEDIUM security finding (#6) are
resolved in this revision before implementation begins, per Requirement 20.
Remaining MEDIUM/LOW items are either fixed inline in the design or tracked
as explicit, justified deferrals (CHANGELOG home, rate-limit hardening).
