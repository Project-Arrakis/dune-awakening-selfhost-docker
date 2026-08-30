# Embed the guided Discord setup wizard into Settings — L1 Design

**Status:** Revision 2 — Eight Hats Layer 1 audit complete, CRITICAL/HIGH findings resolved below
**Tracking issue:** dune-awakening-selfhost-docker#643
**Related:** #641 (guided wizard, shipped to `tier1-upstream`/`feat/634-iam-visual-editor`), #634 (IAM Visual Editor, same branch)

## 1. Problem

(Unchanged from revision 1.) `SettingsPanel.tsx` has its own, older "Discord
OAuth" manual accordion, predating the guided wizard, with none of #641's
improvements and, confirmed live, a save flow that gives no restart feedback.
Decision (put to the operator, they chose it): embed `DiscordSetupWizard`
into Settings, replacing the manual accordion.

## 2. Access-control finding (revision 1, unchanged, re-verified independently by the Security Architect hat)

Every route the wizard calls (`write-oauth-config`, `save-oauth-secret`,
`discord-finalize`, `discord-restart`) is mapped to `settings:write`, which
is on `CROWN_JEWEL_DENY_ACTIONS` — permanently denied to non-owner tiers,
mechanically enforced. The Security Architect hat independently re-verified
the wildcard-matching fix (`de0ed64b`) is present and correct on `HEAD`, and
confirmed `settings:read` is also crown-jewel-denied (so `GET /api/settings`
itself can never leak to a non-owner). **No CRITICAL/HIGH access-control
finding.** One pre-existing, out-of-scope note: `App.tsx`'s
`hasSettingsAccess` has a fail-open clause (`allowedActions.length === 0`)
that is dead code today (only `enroll`/`resetup` scope sessions produce an
empty array, and those are intercepted before the sidebar renders) but is
undocumented as a dependency — tracked as a separate hardening note, not a
blocker for this change (see §5).

## 3. Eight Hats Layer 1 findings register

| # | Hat(s) | Severity | Finding | Resolution |
|---|--------|----------|---------|------------|
| 1 | Architect + UI/UX (independently) | **CRITICAL** | The OAuth round-trip is a full top-level page navigation (`server.js`'s setup callback ends in `window.location.replace("/?discordSetup=done")`). `App.tsx`'s existing `discordSetupOpen` state is derived purely from that URL param's presence and its render branch (`if (auth && discordSetupOpen) return <DiscordSetupWizard onDone={...logout...} />`) fires **before** tab-based rendering, unconditionally, regardless of whether the round-trip was started from the pre-login flow or from an already-authenticated Settings session. An operator reconfiguring Discord from Settings who clicks "Continue with Discord" is dropped into the standalone top-level wizard instead of returning to Settings, and finishing it force-logs them out via `onDone`'s unconditional `post("/api/auth/logout")` + `setAuth(false)`. | **Fixed in this revision — see §4.1.** |
| 2 | Cloud Security | HIGH | The wizard's `step` derivation only shows the credential-entry form (`formClientId`/`formClientSecret`) in `step === "connect"`, which is unreachable once `app?.configured` is true. Embedding this in Settings removes the operator's only remaining UI path to rotate the Discord Client Secret — the old manual form always rendered editable fields regardless of configuration state. | **Fixed — see §4.2** (explicit "Change application credentials" affordance). |
| 3 | GRC | HIGH | `DiscordSetupWizard`'s `map` step initializes `adminRoleIds`/`moderatorRoleIds`/`playerRoleIds` to `""` and `requireMfa` to `true` unconditionally — no pre-fill from already-saved config exists (unlike the old `SettingsPanel` form, which pre-filled all four from real state). Reopening from Settings can silently flip "Require Discord 2FA" on for an install that has it off, and forces re-typing role IDs from memory — a real, undocumented access-lockout risk for non-owner admins whose Discord accounts lack 2FA. | **Fixed — see §4.3** (pre-fill from `app`/existing config). |
| 4 | QA | HIGH (x2) | (a) No structural test exists or is required for the `embedded` wrapper swap — existing tests are all text/role-based and would pass identically regardless of wrapper correctness. (b) `SettingsPanel`'s Discord accordion has zero existing test coverage today; replacing it with no new integration test would ship the mount/`onDone`/`onCancel` wiring completely untested. | **Fixed — see §4.4** (both tests required before merge, listed concretely). |
| 5 | UI/UX | HIGH (x2) | "Back to sign in" (`done` step) and "the sign-in page shows Sign in with Discord" (copy) are contextually wrong once already logged in — embedded-context copy must not claim the operator is being signed back in when they were never signed out (post-fix-#1, they no longer will be, for the reconfiguration path). Restarting the console from Settings ends the current session with no warning specific to that context. | **Fixed — see §4.5** (conditional copy + restart warning). |
| 6 | DBA | HIGH | Silent overwrite of role/guild config with no confirmation step (unlike the secret field's existing 409 overwrite-guard) — pre-existing in the wizard since #641, exposure increased by reachability from Settings. | **Deferred, tracked** — see §5 (pre-existing behavior, not introduced by this change; filing a follow-up rather than expanding this change's scope). |
| 7 | DBA | MEDIUM | No concurrency control on `.env` writes (two tabs racing) — pre-existing in `envFile.js`, exposure increased by a second reachable mount point. | **Deferred, tracked** — see §5. |
| 8 | Security Architect | MEDIUM | `hasSettingsAccess`'s fail-open clause, undocumented as a dependency. Pre-existing, currently dead code. | **Deferred, tracked** — see §5. |
| 9 | Architect + UI/UX | MEDIUM | Collapsing the Settings accordion mid-entry (or switching tabs, which unmounts `SettingsPanel` entirely) silently discards unsaved input, no confirmation. | **Accepted as-is** — matches the wizard's own already-accepted same-session-reset behavior (`appPath` resets on remount, documented in the component's own comments as a bounded, accepted exception). Not blocking. |
| 10 | GRC | HIGH | Two **Status: Current** docs (`docs/console/authentication-upgrade-guide.md`, `docs/console/authentication-qa-checklist.md`) describe the old manual form's exact fields and test steps; both go false on ship. | **Fixed — see §4.6** (updated in the same PR, per Requirement 14). |
| 11 | GRC | MEDIUM | No CHANGELOG plan stated. | **Fixed** — entry added to fork `main`'s CHANGELOG in the implementation PR. |
| 12 | Network | LOW (informational) | The HTTPS gate only covers `step === "connect"`; `authorize`/`map` have no gate. Pre-existing (#641 scope), but embedding makes the ungated steps the routine path for reconfiguration (Settings is opened when Discord is typically already configured). | **Noted, not blocking** — cross-referenced to #641; no incremental risk from this change's own scope, since `isHttps`/`redirectUri` are both document-globals unaffected by mount point (confirmed by both Network and Security Architect hats independently). |

## 4. Resolutions

### 4.1 Fix for finding #1 (CRITICAL): origin-aware return routing, no forced logout for the reconfiguration path

Before navigating to `/api/auth/discord/start?setup=1` (the "Continue with
Discord" link), when `embedded` is true, set a `sessionStorage` marker:
`sessionStorage.setItem("dune-console:discord-setup-return", "settings")`.

In `App.tsx`, where `discordSetupOpen`/`wantDiscordSetup` are currently
derived purely from the `?discordSetup` URL param's presence: additionally
check and consume this marker. If present:
- Clear the marker and the URL param.
- Call `setTab("Settings")` and pass a new `autoOpenDiscordSetup` prop to
  `SettingsPanel` (read once, then cleared) so it auto-expands its Discord
  accordion on mount.
- **Do not** set `discordSetupOpen` to `true` and do not render the
  standalone top-level `<DiscordSetupWizard>` mount at all for this path —
  the embedded instance inside `SettingsPanel` re-probes on its own mount
  (`probe()` is unconditional, not gated on a URL param) and naturally
  continues from wherever server state now says (`identity` captured →
  `step === "map"`).
- Critically, this means `onDone`'s `post("/api/auth/logout")` +
  `setAuth(false)` **never fires** for this path — there is no forced
  logout for an operator reconfiguring Discord from an already-established
  session.

If the marker is **not** present (the original pre-login bootstrap flow,
unchanged since #641): behavior is byte-identical to today — same
`discordSetupOpen` branch, same `onDone` logout (which is correct there:
finishing initial setup legitimately requires a fresh login to pick up the
newly-resolved tier/policy from a clean session).

### 4.2 Fix for finding #2 (HIGH): credential rotation path

Add a small "Change application credentials" link, visible once
`app?.configured` is true (in the `authorize`/`map` steps), that sets a new
local state (`forceReconfigure`) forcing the wizard back to the
credential-entry form regardless of `step`'s normal derivation. Pre-fills
`formClientId` from `app.clientId` as the connect step already does; the
secret field stays blank with existing "leave blank to keep current"
semantics (`overwrite` flag already supported by `save-oauth-secret`).

### 4.3 Fix for finding #3 (HIGH): pre-fill role/MFA state

Initialize `adminRoleIds`/`moderatorRoleIds`/`playerRoleIds`/`requireMfa`
from `app`'s probed config (already fetched via `/api/settings`'s
`serverConfig`) instead of hardcoded blank/`true`, matching what the old
`SettingsPanel` form already did correctly.

### 4.4 Fix for finding #4 (HIGH x2): required tests

Before merge:
1. `DiscordSetupWizard.test.tsx`: render with `embedded` and assert via
   `container.querySelector` that `main.login-screen` is absent and the
   embedded wrapper is present; render without the prop and assert the
   inverse — structural, not text-based, since text queries cannot detect a
   wrapper-tag regression.
2. A new `SettingsPanel`-scoped test: opening the Discord accordion mounts
   the wizard (assert wizard-only text appears); `onCancel` collapses it;
   `onDone` collapses it and re-runs Settings' own config probe (mocked/
   spied).
3. A regression test for §4.1's fix: simulate the `?discordSetup=done` +
   sessionStorage-marker return and assert `setTab("Settings")` fires with
   no `/api/auth/logout` call, versus the marker absent (pre-login case)
   where the existing standalone-mount + logout behavior is unchanged.

### 4.5 Fix for finding #5 (HIGH x2): contextual copy

`done` step's "Back to sign in" / "the sign-in page shows Sign in with
Discord" copy becomes conditional on `embedded`: embedded reads "Back to
Settings" and drops the sign-in-page reference. The restart prompt (shared
with the connect-step fix from this session) gets an additional line when
`embedded`: "This will end your current session — you'll need to sign back
in after the restart."

### 4.6 Fix for finding #10 (HIGH): documentation

Update `docs/console/authentication-upgrade-guide.md` and
`docs/console/authentication-qa-checklist.md` (both **Status: Current**) in
the same implementation PR to describe the guided wizard instead of the old
manual per-field form, and revise the QA checklist's now-inexecutable manual
steps (T31–T36).

## 5. Explicitly deferred (tracked, not blocking this change)

Findings #6, #7, #8 above are real but pre-existing (introduced by #641 or
earlier, not by this reuse) — filing follow-up issues rather than expanding
this change's scope to fix them:
- DBA #6/#7 (silent overwrite, concurrent-write race on `.env`): follow-up
  issue on the shared `envFile.js`/wizard-save mechanism.
- Security Architect #8 (`hasSettingsAccess` fail-open dependency,
  currently dead code): follow-up hardening issue.

## 6. Explicitly out of scope

- Any other change to the wizard's own OAuth/HTTPS-gate/restart logic
  beyond §4.1–4.5 above.
- A "keep both forms" fallback — the decision was full replacement.
