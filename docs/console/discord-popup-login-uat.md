# UAT: Popup+poll Discord sign-in (#574)

**Purpose.** A manual, end-user test plan for the popup+poll Discord
sign-in on the main console login screen. This is a **release-blocking**
UAT case, not an optional one: this repository has no real-browser E2E
testing tooling (no Playwright or equivalent), so the actual
`window.open`/cross-window/`Cross-Origin-Opener-Policy` behavior — the
part of this feature automated tests structurally cannot verify — depends
entirely on this checklist actually being run in a real browser before
this ships. Automated tests cover the HTTP redirect chain
(`console/api/test/oauthRoutes.integration.test.js`) and the JS state
machine in isolation (`console/web/src/features/auth/discordPopupLogin.test.ts`,
`console/web/src/App.discordPopupLogin.test.tsx`) — this covers what a
human actually sees, and the real browser platform behavior those tests
can only simulate.

**Who.** One QA engineer or operator, in a real browser (test in at least
two: one Chromium-based, one Firefox — `Cross-Origin-Opener-Policy` and
popup-blocking heuristics are not always identical across engines).
Budget about 30 minutes for T01–T09, plus 10 more for the optional T10
(the silent-retry path, which can't always be triggered on demand).

**Result rule.** A case passes only if *every* expected line is observed.
If the popup's size, the busy label's text, or an error message differs
from what is written here, that is a finding even when sign-in still
basically works.

**Getting this build onto your instance.** No git checkout is needed or
expected. On your console: **Updates → QA Tester Login** (Discord sign-in),
then confirm the build shown under *Latest GitHub Pre-Release* is the one
you were told to test (ask whoever assigned this UAT for the expected short
SHA if it isn't obvious), then **Apply Pre-Release**. This rebuilds and
restarts the console for you — wait for it to come back healthy before
starting T01.

---

## Environment (fill in before starting)

| Item | Value |
|---|---|
| Console URL used in the browser | `https://________________` (must be a real HTTPS origin — the state cookie is `Secure`, so a plain `http://` URL cannot complete this flow at all, popup or not) |
| Browser + version (first pass) | `________` |
| Browser + version (second pass, different engine) | `________` |
| Build under test | short SHA shown in **Updates → Latest GitHub Pre-Release** after applying it: `________` |
| Discord account for sign-in | account: `________` |
| Browser DevTools access | needed for T08 (`window.opener` check) — no host/SSH access to your instance is needed anywhere in this plan |
| Popup blocking | test once with popups **allowed** for this site (T01–T07), once with popups **blocked** (T05) |

---

## How to record results

For each case: **Pass / Fail / Blocked**, plus evidence — a screenshot of
the popup and the main page side by side where relevant, and the exact
on-screen text for any message. Keep the completed results table at the
end with your test records for the build.

---

## Part 1 — The happy path

### T01 · Clicking "Sign in with Discord" opens a popup, not a full-page navigation
1. Open the console sign-in page (popups allowed for this site).
2. Click **Sign in with Discord**.

**Expected**
- A new, small popup window opens (roughly 480×720). The main console tab
  does **not** navigate away — it stays on the sign-in page.
- The main page's button now reads **"Waiting for Discord..."** and is
  not clickable again.

### T02 · The popup shows Discord's real sign-in/consent screen
1. Look at the popup.

**Expected**
- The popup navigates to a real `discord.com` URL and shows Discord's own
  login/authorize UI — nothing about this screen is rendered by the
  console.

### T03 · Completing sign-in in the popup closes it and logs the main tab in — no reload
1. Complete the Discord authorization in the popup (log in and/or approve
   if prompted).

**Expected**
- The popup closes itself within a couple of seconds of completing.
- The main tab, **without ever reloading**, transitions to the signed-in
  console — sidebar, nav, everything — showing your Discord account's
  display name and access tier in the sidebar chip.
- Every part of the console works normally from here: navigate to a
  couple of tabs, confirm no "session expired" or CSRF errors appear on
  any action you try (this specifically covers a real bug this feature's
  design caught and fixed — an earlier version would have left you stuck
  half-logged-in at this exact point).

### T04 · A denied/failed sign-in shows the SAME specific error as the full-page flow, inside the popup, and does not auto-close
*Setup:* trigger a real denial (e.g., decline Discord's consent prompt, or
use an account this console denies for some documented reason — not
authorized, 2FA required, etc., if you can arrange one). **Important:** the
console always attempts a *silent* sign-in first — if the same Discord
account already authorized this application earlier in this same test pass
(e.g., during T01–T03), Discord will skip the consent screen entirely and
there will be no "Cancel"/"Deny" button to click. Before this case, either
use a Discord account that has never authorized this application, or revoke
the existing authorization first (Discord → User Settings → Authorized Apps
→ remove this console's application).
1. Start Discord sign-in again from the main page.
2. In the popup, cause the denial (e.g., click "Cancel"/"Deny" on
   Discord's own prompt).

**Expected**
- The popup shows a readable error page with the **same specific
  message** the full-page flow would show (e.g., "Discord sign-in was
  cancelled..." or a 2FA/authorization-specific message) — not a generic
  "something went wrong."
- The popup does **not** close itself automatically. You have to close it
  yourself. (This is deliberate — an earlier version of this feature
  would have auto-closed it after a few seconds, risking you missing the
  actual reason.)
3. Close the popup by hand.

**Expected**
- The main page's button returns to "Sign in with Discord" (no longer
  busy) and shows a generic message like "Discord sign-in was closed
  before it completed. Try again." — this is expected; the *specific*
  reason was only ever shown in the popup itself, which you just read.

---

## Part 2 — Fallbacks and edge cases

### T05 · Popup blocked → automatic fallback to the full-page flow, same click
*Setup:* configure your browser to block popups for this console's
origin (or trigger a browser's popup-block heuristic — some browsers
block a popup opened from certain contexts even with a direct click).
1. Click **Sign in with Discord**.

**Expected**
- **No error message, no stuck busy button.** The page itself navigates
  away to Discord's sign-in — i.e., it falls back to today's regular
  full-page flow, automatically, on the same click. You should not need
  to click anything a second time.
2. Complete sign-in normally (full-page flow).

**Expected**
- Sign-in completes exactly as it always has — this is the pre-existing,
  unmodified code path.

### T06 · Closing the popup before completing shows a clear message, and the button is immediately usable again
1. Click **Sign in with Discord**. In the popup, close it (the window's
   own close button) before finishing Discord's screens.

**Expected**
- Within a few seconds, the main page's button returns to "Sign in with
  Discord" and shows a message like "Discord sign-in was closed before
  it completed. Try again."
2. Click **Sign in with Discord** again.

**Expected**
- A fresh popup opens normally — no leftover state from the cancelled
  attempt blocks a new attempt.

### T07 · A modifier-click opens the full-page flow in a new tab instead
1. Ctrl-click (Cmd-click on macOS) or middle-click **Sign in with
   Discord**.

**Expected**
- A **new browser tab** opens showing Discord's sign-in — this is the
  browser's own native "open link in new tab" behavior for the button's
  underlying link, not the popup flow. No small popup window appears in
  this case.
- The original tab is unaffected (still showing the sign-in page, button
  not busy).

---

## Part 3 — Security verification (do not skip)

### T08 · `window.opener` is severed once the popup navigates to Discord (reverse-tabnabbing mitigation)
*This is the single most important case in this document — it is the one
piece of this feature no automated test can verify, and it is a real
security property, not a cosmetic one.*
1. Click **Sign in with Discord** and let the popup open and navigate to
   Discord's page (T02).
2. Click into the **popup window itself** to give it focus, then open a
   *fresh* DevTools instance for that window specifically — right-click
   anywhere inside the popup and choose **Inspect**, or press the
   DevTools shortcut (F12, or Cmd+Opt+I on macOS) while the popup is the
   focused window. (A popup is a separate top-level window, not a frame/
   iframe of the main tab — there is no "frame picker" that switches into
   it from the main tab's own DevTools; you open DevTools on it directly,
   the same way you would on any other window.)
3. In the DevTools console attached to the **popup**, evaluate: `window.opener`

**Expected**
- `window.opener` is `null` (or inaccessible/undefined) once the popup
  has navigated to Discord's origin. If it is a live, non-null reference
  to the main console window, **this is a real security finding — stop
  and report it immediately, do not ship.**
4. Complete sign-in normally afterward and confirm T03 still holds (the
   opener can still detect completion and the popup can still close
   itself — severing `window.opener` must not break the console's own
   *held* reference to the popup, only the popup's reference back).

### T09 · The response headers carry `Cross-Origin-Opener-Policy: same-origin`
1. With DevTools' Network tab open, reload the sign-in page (or any
   console page).
2. Inspect the response headers for the page request.

**Expected**
- `Cross-Origin-Opener-Policy: same-origin` is present.

---

## Part 4 — Optional / best-effort

### T10 · The silent-retry path (interactive re-consent) still completes correctly in the popup
*This can't always be triggered on demand — Discord only asks for
interactive re-consent under certain conditions (e.g., first-time
authorization, revoked grants, or certain account states). Attempt it
with an account/app combination likely to need it; mark Blocked if you
cannot reproduce the precondition.*
1. Trigger a sign-in that requires Discord to show an interactive consent
   screen rather than completing silently (e.g., a Discord account
   that has never authorized this application before).

**Expected**
- The popup shows Discord's interactive consent screen (not just a flash
  of a blank page).
- After approving, the popup still closes itself normally (T03's
  behavior) — it does **not** load the full console UI inside the small
  popup window. (This exact scenario is what this feature's own design
  process found as a real bug during design review, before any code was
  written — this case exists specifically to confirm the fix holds in a
  real browser, not just in the automated test that also covers it.)

---

## Results

| Case | Pass/Fail/Blocked | Browser | Notes |
|---|---|---|---|
| T01 | | | |
| T02 | | | |
| T03 | | | |
| T04 | | | |
| T05 | | | |
| T06 | | | |
| T07 | | | |
| T08 | | | |
| T09 | | | |
| T10 (optional) | | | |
