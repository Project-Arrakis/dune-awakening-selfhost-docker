# UAT: Discord setup wizard embedded in Settings (#643)

**Purpose.** A manual, end-user test plan for reaching and using Discord
OAuth setup from an already-authenticated session (Settings → Discord
OAuth), as opposed to the pre-login flow. Automated tests
(`DiscordSetupWizard.test.tsx`, `SettingsPanel.discordSetup.test.tsx`,
`App.discordSetupReturn.test.tsx`, `oauthRoutes.integration.test.js`) cover
the component/route logic in isolation with mocked network calls; this
covers the real, full-page OAuth round-trip against the actual Discord API,
which cannot be exercised meaningfully by a mock.

**Who.** One QA engineer with Owner access, a real Discord account that
owns a test Discord server, and (for T08) a second console session/browser
already authenticated. Budget about 45 minutes.

**Result rule.** A case passes only if *every* expected line is observed.
The critical thing this plan exists to catch is **any case where the
operator is unexpectedly signed out** — note the exact moment if it
happens, even if the flow otherwise "worked."

---

## Environment (fill in before starting)

| Item | Value |
|---|---|
| Console URL (must be HTTPS — see T01) | `https://________________` |
| Build under test | commit `________` |
| Discord test application | Client ID/Secret already created, or ready to create fresh (T03 covers both paths) |
| Test Discord server | one you own, for the guild-ownership check |
| A second Discord account with 2FA off | for the MFA-requirement negative case, if re-testing T-series from the QA checklist alongside this plan |

**Before starting, back up current Discord config on the host:**
```bash
grep '^DISCORD_' .env > ~/qa-discord-backup.env 2>/dev/null
cp -p runtime/secrets/discord-oauth-client-secret.txt ~/qa-discord-secret-backup.txt 2>/dev/null
```

---

## Part 1 — Reaching the embedded wizard

### T01 · HTTPS gate blocks the connect step over plain HTTP
1. Load the console over `http://` (not `https://`) with no Discord app configured yet, sign in, open Settings → Discord OAuth.

**Expected:** A hard gate: "Discord sign-in requires HTTPS," listing free options (Cloudflare Tunnel, Tailscale cert, ngrok). No Client ID/Secret form is reachable. Reloading over HTTPS clears the gate.

### T02 · Opening the accordion mounts the wizard, not a manual form
1. Over HTTPS, sign in, go to Settings, click "Discord OAuth" to expand it.

**Expected:** The same guided flow used pre-login appears **inside** the Settings panel (no full-page takeover, no separate `<main>` element) — starting with "I already have a Discord application" / "I need to create one," not a flat form of text fields.

---

## Part 2 — First-time setup from Settings

### T03 · Guided app creation
1. Click "I need to create one." Follow the Developer Portal link and the numbered checklist to create a real Discord application; copy its Client ID and Secret back into the form.
2. Click Save.

**Expected:** A "Saved — restart needed" message with a working "Restart the console now" button (not silent, and not requiring you to separately know to restart by hand). After the restart completes, the page reloads and Settings' Discord accordion re-opens automatically at the next step.

### T04 · Continuing with Discord from Settings does NOT sign you out
1. Once the app is configured, reopen Settings → Discord OAuth (if not already there) and click "Continue with Discord."
2. Authorize the application on Discord's own consent screen.

**Expected — this is the critical case.** You land back in **Settings**, still signed in under your original session, on the role-mapping step. You are **not** dropped into a full-page "Set up Discord sign-in" screen, and you are **not** signed out. (This was a real CRITICAL bug, independently found by two audit passes: the OAuth round-trip's return used to always land on the pre-login takeover regardless of where it was started, and finishing that takeover force-logged the session out.)

### T05 · Role mapping and turning it on
1. On the role-mapping step, map an Admin role (required) and, optionally, Moderator/Player roles.
2. Click "Turn on Discord sign-in," then restart when prompted.

**Expected:** After the restart, the sign-in page offers "Sign in with Discord" alongside the password option.

---

## Part 3 — Reconfiguring an already-live setup (the main point of #643)

### T06 · Reopening shows "Reconfiguring," not "Connecting"
1. With Discord sign-in already fully configured (T05 done), sign in (password or Discord — see T08), go to Settings → Discord OAuth, click "Continue with Discord," authorize again.

**Expected:** The role-mapping step now says **"Reconfiguring `<your server name>`"**, not "Connecting" — and the button reads **"Save role mapping,"** not "Turn on Discord sign-in." (Seeing the first-time-activation copy here was a real, live-reported point of confusion: "if I logged in with Discord OAuth, why am I being asked to 'Turn on Discord sign-in'?")

### T07 · Existing role mappings and the MFA toggle pre-fill
1. Before reopening, note the current Admin/Moderator/Player role IDs and the "Require Discord two-factor" checkbox state (Settings, or ask whoever set it up).
2. Reopen the wizard per T06, reach the role-mapping step.

**Expected:** All three role fields are already filled in with the existing values, and the MFA checkbox already reflects the existing setting — none of it resets to blank or flips on by default. (A real gap: reopening used to silently reset every role field to empty and the MFA checkbox to checked, an undocumented lockout risk for other admins.)

### T08 · A Discord-login owner skips the redundant round-trip entirely
1. Sign **out** completely.
2. Sign back in using **"Sign in with Discord"** (not the admin password) — as the account that owns the test server.
3. Go to Settings → Discord OAuth.

**Expected:** The wizard goes **straight to the role-mapping step** ("Reconfiguring...") — it does **not** show "Continue with Discord" first. Your login *is* the proof; the wizard reuses it instead of asking you to prove Discord ownership a second time in the same session.

**Important:** this only works for a *fresh* Discord login taken after this fix is deployed — a session that was already open before the deploy won't have it, and needs a fresh sign-out/sign-in to pick it up. If step 3 still shows "Continue with Discord," check you actually got a new session (re-signed in) after the current build was deployed before calling this a failure.

### T09 · Rotating the application's own credentials
1. From the role-mapping or authorize step, find and click "Change application credentials."

**Expected:** The Client ID/Secret form reappears (Client ID pre-filled from the existing value, Secret field blank with "Paste a new one to replace"), letting you update the Discord application's own credentials without needing to touch role mappings at all. (Without this, once past initial setup there was no UI path left to rotate a leaked Client Secret.)

### T10 · Role-conflict check is instant, no round-trip
1. On the role-mapping step, put the same Discord role ID into both the Admin Role and Moderator Role fields.

**Expected:** An inline message appears immediately ("Each Discord role can map to only one access level...") and "Save role mapping"/"Turn on Discord sign-in" becomes disabled — before you click anything, no network request happens. (This client-side check existed in the older manual form and was accidentally dropped when it was replaced by the embedded wizard; restored.)

### T11 · Cancel leaves Settings in a sane state
1. Open the Discord OAuth accordion, then click "Cancel" (or the general Settings "Cancel" affordance) partway through, without saving.

**Expected:** The accordion collapses cleanly. No error, no stuck loading state. Reopening it starts fresh from wherever server state actually is.

### T12 · Restarting from Settings warns about the session ending
1. Reach a restart prompt from within the embedded (Settings) wizard — either the connect-step "Saved" panel (T03) or the done-step panel (T05/T06).

**Expected:** The restart panel includes an explicit line that this will end your current session and you'll need to sign back in — distinct from the pre-login flow's copy, which doesn't need that warning since you're mid-login there anyway.

---

## Results

| Case | Pass/Fail/Blocked | Evidence |
|---|---|---|
| T01 | | |
| T02 | | |
| T03 | | |
| T04 | | |
| T05 | | |
| T06 | | |
| T07 | | |
| T08 | | |
| T09 | | |
| T10 | | |
| T11 | | |
| T12 | | |
