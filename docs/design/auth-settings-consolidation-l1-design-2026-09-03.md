# Consolidate Settings' Password/2FA and Discord OAuth sections — L1 Design

**Status:** Revision 3 — Eight Hats Layer 1 audit complete (8 independent dispatches), all CRITICAL/HIGH findings resolved below; #678 pulled into implementation scope (§6.5)
**Tracking issue:** dune-awakening-selfhost-docker#676
**Related:** #641 (guided Discord app-creation wizard, shipped to `tier1-upstream`), #643 (embed that wizard into Settings — this design treats #643 as a given), #665/#666 (the originating live-testing feedback thread), #634 (IAM Visual Editor, same branch), #678 (`.env` write-race, surfaced again by this audit, filed for real this time), #679 (Phase 3 — age-encryption, split out per the audit below)

## 1. Problem

Live operator testing (feedback relayed from Red-Blink) found Settings' authentication area confusing once Discord OAuth is configured:

- The "Two-Factor Authentication" section gives no indication it governs the *password* credential (Tier 3) specifically — it has zero relationship to Discord OAuth sign-in (Tier 1), but nothing on the page says so.
- There is no guided path between the two credentials in either direction.
- No tier-loss scenario has a designed answer beyond what already exists piecemeal in the RFC's credential-loss table (§3.4) and various error-page strings.

This design covers the full space: page structure, every tier-to-tier transition, and every break-glass path — verified against the real code, not assumed, and independently re-verified by an 8-hat Layer 1 audit (§13) before this revision.

## 2. Terminology and verified current state

**Tier 3** = password only. **"Tier 4"** = Tier 3 with TOTP enabled. **Tier 1** = Discord OAuth. **Tier 2** = passkey/WebAuthn — does not exist in code, every Tier 2 cell below is out of scope.

Verified directly against `tier1-upstream`@`e602dbd6`, re-verified by the audit hats against the same commit:

- `requireFreshTier3Proof()` requires the literal current password "regardless of how the acting session authenticated" (RFC §2.2) — deliberate, and **this design does not weaken that rule anywhere** (independently confirmed by the Security Architect hat, §13).
- No route exists to remove/unconfigure Discord OAuth once set — only rotate-in-place.
- `/api/settings/admin-password` only ever *sets* a new password; there is no route that reveals the current one.
- Console TOTP has zero connection to the Discord OAuth login path (code comment: "never a second factor on top of Discord"). Discord's own 2FA is a separate mechanism (`discordOAuthRequireMfaTiers` / `mfaGateReason()`).
- Every Discord OAuth failure path points to: "Sign in with the admin password in the meantime." Tier 1's break-glass *is* Tier 3.
- The wizard's `done` step *can* trigger a full container restart, which unconditionally wipes the in-memory session store — **but the audit found this restart is skippable** (a "Back to sign in" button bypasses `restartNow()` entirely, `DiscordSetupWizard.tsx` line ~290) — corrected from this doc's revision 1, which stated the restart was unconditional. See §7.
- Discord OAuth's operator-configured fields, confirmed against `config.js` (not a hand-counted list — see §6's revision-2 fix): `DISCORD_OAUTH_CLIENT_ID`, `DISCORD_OAUTH_REDIRECT_URI`, `DISCORD_HOME_GUILD_ID`, `DISCORD_CONSOLE_ADMIN_ROLE_IDS`, `DISCORD_CONSOLE_MODERATOR_ROLE_IDS`, `DISCORD_CONSOLE_PLAYER_ROLE_IDS`, `DISCORD_OAUTH_REQUIRE_MFA_TIERS`, `DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP`, `DISCORD_OAUTH_OWNER_ALLOWLIST` — **plus the Client Secret, which is not an `.env` key at all**: it lives in `runtime/secrets/discord-oauth-client-secret.txt` (mode 0600), written by `saveOAuthClientSecret`, read via `readInlineOrFile()`. Revision 1 incorrectly described this as "seven `.env` keys" and omitted the file-backed secret entirely — see §6.
- `discordOAuthConfigured` and `discordOAuthAppConfigured` are two separately-computed booleans (`config.js`). The OAuth callback route and the setup-mode start route gate on `discordOAuthAppConfigured` only, not `discordOAuthConfigured` — a distinction revision 1 missed. See §6.
- The Settings nav item and every `settings:*` action are already owner-only (sidebar filter + `CROWN_JEWEL_DENY_ACTIONS`). No change needed.
- Multi-owner support is explicitly out of scope (operator decision).

## 3. Settings page structure

Restructure the authentication area into a primary/secondary split, driven by `discordOAuthConfigured`:

- **Not configured:** Password Sign-In (password change + Two-Factor toggle) stays primary/visible. A prominent call-to-action for the embedded Discord wizard (#643) sits alongside it.
- **Configured and active:** the embedded Discord wizard becomes primary, open by default. Password Sign-In moves under a collapsed **"Password Sign-In (fallback)"** disclosure, closed by default — same controls, just demoted in prominence.
  - **Renamed from "(Advanced)" to "(fallback)" in this revision** — the UI/UX hat flagged that "Advanced" reads as "expert-only," which risks discouraging exactly the break-glass use this section exists for, at exactly the moment (mid-incident) speed matters most. "Fallback" states its actual role.
  - Persistent reminder in this section: *"This password is Discord sign-in's break-glass fallback if it's ever unavailable — make sure whoever manages Discord access also knows it."* **Extended in this revision** (UI/UX hat finding): once Discord OAuth's own MFA requirement covers the acting tier, this section also states *"Discord sign-in already requires its own two-factor for your role — you can safely turn off this password-based two-factor here any time, whether or not you completed the guided offer during setup."* This closes the "silently never appears again" gap the tab-close/skip-restart limitations (§7) create — the option is always independently discoverable here, not only through the one-time guided flow.
- **Configured but disabled** (§6): a compact banner — "Discord Sign-In (disabled)" — with a one-click "Re-enable," Password Sign-In reverts to primary, plus a secondary "Forget this configuration entirely" action.

## 4. Full tier-transition matrix

| From → To | Mechanism | Settings panel: visible/functional | Interrupted mid-way? |
|---|---|---|---|
| **3 → 4** | Settings → Two-Factor → Enable → QR → confirm → forced logout → re-login. | Before: "Two-Factor (off)," open, primary. After: enrolled state. | Safe — enrollment only commits on `/2fa/confirm`. |
| **4 → 3** | Settings → Two-Factor → Disable (password + current code). | Both states already built. | Safe — single atomic request. |
| **3 → 1** | Discord setup wizard (#641/#643) from a password session. | Discord OAuth becomes primary; password collapses per §3. | Resilient — wizard re-derives its step from live server state on every mount. |
| **4 → 1** | Same wizard, **plus a new post-login `offer` screen — corrected in this revision to NOT be a wizard step** (see §7). | Same as 3→1, plus a one-time full-screen offer shown after the first fresh Discord login following setup, not inside the wizard itself. | See §7's revised marker-durability and skip-restart handling. |
| **1 → 3** (full removal) | Soft-disable (§6), reversible. Secondary: hard "forget" (§6). | Discord section shows the disabled banner; Password Sign-In returns to primary. | Mitigated by non-skippable restart for `/disable` specifically — see §6. |
| **1 → 4** | Resolved via operator awareness (§8), not a bypass. **Also now enforced, not just advised, universally** — see §3's extended reminder and §7's zero-2FA guard fix. | Enable/Disable forms carry contextual copy; the zero-2FA guard now applies regardless of entry path. | N/A |

## 5. Break-glass per tier

| Tier broken | Recovery path today | Depends on |
|---|---|---|
| 3 (forgot password) | Host filesystem access only, by explicit RFC design. | Physical/host access |
| 4, TOTP device lost, codes held | Recovery-code login → forced re-enrollment | Having saved the codes |
| 4, TOTP *and* codes lost | Host-filesystem reset → falls back to Tier 3 | Physical/host access |
| 1 broken | "Sign in with the admin password in the meantime." | **Knowing the Tier 3 password** |
| 2 | N/A — not built | — |

**GRC finding (§13): this table and the RFC's own §3.4 credential-loss table are now two independent, un-reconciled sources for the same information.** Resolution: this design's implementation PR must add a cross-reference from RFC §3.4 to this document (or fold a Tier 1 row directly into §3.4 — preferred, since §3.4 is the RFC's own stated canonical table) rather than leaving two tables that can silently drift apart. Tracked as a required doc-update item in §10.

**Central finding, unchanged from revision 1:** Tier 1 → 4 being blocked and Tier 1's own break-glass fail for the identical reason — an Owner who has only ever used Discord OAuth, never told the password, is one Discord outage away from total lockout with no in-browser recovery. §8 is this design's answer.

## 6. Tier 1 → 3, complete removal

**Substantially revised in this revision to resolve three CRITICAL/HIGH audit findings** (a missed secret file, an incomplete field list, and an unenforced audit trail) plus several MEDIUM findings. This is now the most heavily specified section of the document.

### 6.1 What "clear" actually means (resolves DBA CRITICAL + HIGH)

Revision 1 described the clear-list as "seven `.env` keys" and the Forget action as clearing them — **this was wrong on two counts**, confirmed by the DBA hat: the real field count is nine `.env` keys (§2's list), and the Client Secret is not an `.env` key at all — it's a separately-stored file (`runtime/secrets/discord-oauth-client-secret.txt`) that revision 1's "Forget" spec never touched, leaving the one genuinely sensitive artifact on disk after an operator believes it's gone.

**Fix:** both the disable and forget handlers must derive their field list programmatically from the same source `config.js` already uses to compute `discordOAuthConfigured`/`discordOAuthAppConfigured` — never a hand-maintained, hardcoded list in the route handler. "Forget" additionally deletes `runtime/secrets/discord-oauth-client-secret.txt` outright (not just clears its referencing `.env` key, since there is none). This closes both the CRITICAL (secret survives) and the HIGH (incomplete `.env` accounting) in one fix, by construction rather than by a second hand-maintained list.

### 6.2 Two gating booleans, not one (resolves Architect HIGH)

Revision 1 assumed a single new flag (`DISCORD_OAUTH_DISABLED`) short-circuiting `discordOAuthConfigured`/`discordSignInAvailable` was sufficient. The Architect hat found this misses `discordOAuthAppConfigured` — a **separate** boolean that gates the OAuth callback route and the setup-mode start route directly, and is not touched by soft-disable's on-disk-preservation design (client ID/secret/redirect URI stay present, so `discordOAuthAppConfigured` stays `true`).

**Fix:** every route currently gated on `discordOAuthAppConfigured` must additionally check `!config.discordOAuthDisabled`. This makes "disabled" genuinely inert at every API layer, not just the routes revision 1 happened to name. (Not a privilege-escalation risk as specified — both affected routes still require an existing authenticated owner session — but "disabled" must mean *disabled*, not *reachable-but-hidden*.)

This also resolves the Architect's related finding that the wizard's own step-derivation logic (`app?.configured ? "authorize" : "connect"`) cannot currently distinguish "soft-disabled, previously fully configured" from "first-time setup, credentials saved but nothing else chosen yet" — both produce `discordOAuthAppConfigured: true` / `discordOAuthConfigured: false`. **Fix:** `discordOAuthDisabled` must be exposed via the same config/state endpoint the wizard already reads, and the wizard's step derivation must check it first — landing on the "disabled" banner (§3) rather than jumping into `authorize`/`map`, if an owner reaches it directly while soft-disabled.

### 6.3 Fresh proof, restart atomicity, and audit trail (resolves GRC CRITICAL + Security Architect MEDIUMs)

- **Both `disable` and `forget` require fresh Tier-3 proof** (`requireFreshTier3Proof`, `requireEnrolled: false` — explicitly stated here per the Architect hat's finding that revision 1 never specified this value, and getting it wrong would block the exact TOTP-less-owner population this feature serves). Revision 1 left `forget`'s gating ambiguous (Security Architect finding) — it is **at least as strict as disable**, given it's irreversible for the non-secret configuration (§6.4).
- **`enable` requires no fresh proof** — it only restores a working login option, it cannot strand anyone.
- **The restart for `/disable` specifically must not be skippable the way the wizard's benign credential-rotation restart is.** Revision 1 assumed the wizard's existing optional "Restart later" pattern applied here; the Security Architect hat correctly noted that `discordOAuthConfigured` is computed once at process boot, so between the API call succeeding and an operator actually restarting, Discord sign-in — and any already-open Discord session — keeps working while the UI may already show "disabled," a false assurance during exactly the scenario (suspected compromise) this action exists for. The `/disable` and `/forget` flows must restart immediately as part of the same operation, not offer a "restart later" choice.
- **New audit events, matching this codebase's existing naming convention** (`settings.totp-disabled`, etc.): `settings.discord-oauth-disabled`, `settings.discord-oauth-enabled`, `settings.discord-oauth-forgotten` — each logged with the acting session's tier/userId, matching every other Tier-3-adjacent action in this file. Revision 1 specified none of these (GRC CRITICAL finding); their absence would have made "who disabled/forgot our Discord config, and when" unanswerable, and indistinguishable from each other in any log.

### 6.4 Rollback and recoverability (resolves DBA HIGH)

Revision 1's "no meaningful security difference" framing for soft-disable is accurate for filesystem exposure, but the DBA hat correctly noted the *forget* action's stated reversibility rationale ("the operator can always regenerate a Discord Client Secret from Discord's own portal") only covers the secret — not the home guild ID, the three role-ID→tier mappings, or the MFA-required-tier list, none of which are recoverable from any external system.

**Fix:** the `settings.discord-oauth-forgotten` audit entry (§6.3) logs the pre-wipe non-secret fields (guild ID, role mappings, MFA list — never the secret itself) as a recoverable record an operator can consult after a mistaken click, rather than requiring full reconstruction from memory. The confirmation dialog for "Forget" is upgraded from the standard `confirmAction()` danger dialog to require typing the word "forget" (matching this codebase's existing pattern for its most destructive confirmations), given ordinary confirmation friction was judged insufficient for an action this irreversible.

### 6.5 Concurrent writes — remediated in this implementation, not deferred (revision 3 decision)

`services/envFile.js`'s `updateEnvFileValue()` has no locking/atomicity — two Settings actions racing can silently drop one write. This is real, pre-existing, and was already found once before (a #643-revision design doc's own DBA finding, since deleted from the repo with its promised follow-up never filed) — independently rediscovered by two hats in this audit, filed for real as #678.

**Revision 3: #678's remediation is pulled into this implementation rather than left tracked-but-deferred** (operator decision, given `/disable`/`/enable`/`/forget` were about to become the third/fourth/fifth writer to this same unprotected file — shipping more writers on top of a known, acknowledged race was judged worse than fixing it now that it's directly in scope). A single serialized-write helper (an in-process async mutex/queue is sufficient — all writers run in the same Node process, no cross-process coordination needed) wraps every `updateEnvFileValue()` call site, including the pre-existing wizard/manual-form writers, not just this design's three new ones. #678 stays open only to track backporting the same fix to any other in-flight branch that touches `envFile.js` independently.

### 6.6 Credential rotation reminder (resolves Cloud Security MEDIUM)

Neither disable nor forget invalidates the Client Secret *at Discord* — it stays valid until an operator manually rotates it in Discord's Developer Portal, independent of any console-side action. **Fix:** the "Re-enable" confirmation adds one line: *"If you disabled this because you suspected the Discord application's credentials were compromised, rotate the Client Secret in Discord's Developer Portal before re-enabling — turning this back on does not rotate it for you."*

## 7. Guided Tier 4 → 1 flow (the "Switch to Discord Sign-In" journey)

**Corrected in this revision to fix a CRITICAL structural error.** Revision 1 described the `offer` step as "one appended conditional step... on the existing 4-step Discord wizard." **The Architect hat found this is not physically possible**: the wizard's restart flow ends in `window.location.replace("/")`, a hard navigation that unmounts the entire `DiscordSetupWizard` component tree. The subsequent real Discord sign-in that this design leans on for live verification happens through `App.tsx`'s plain OAuth login path — which the wizard component never sees and has no branch for. The wizard's step-derivation logic (`connect`/`authorize`/`map`/`done`) has no way to represent a 5th step reached after the component no longer exists.

**Corrected design:** the `offer` screen is a new, standalone, full-screen takeover in `App.tsx` — the same architectural pattern already used for `TotpSetupScreen` (gated by `setupMode`) — not a wizard step. It's shown after a normal, successful Discord OAuth login, gated by the `sessionStorage` marker below, rendered *before* the normal dashboard mounts, exactly the way `setupMode` already intercepts rendering today (`if (setupMode) return <TotpSetupScreen .../>`, `App.tsx` line ~850). This is a smaller change than it sounds — App.tsx already has this exact interception pattern for exactly this class of "full-screen step before the dashboard" flow; the offer just becomes a second instance of a pattern that already exists, correctly, rather than a step bolted onto a component architecturally unable to host it.

Trigger conditions, unchanged in substance: a first-time configuration transition (unconfigured → configured), not a re-edit, **and** `secondFactorEnrolled: true` at the time setup began.

**Marker mechanism, corrected for two real gaps found by this audit:**
- `sessionStorage.setItem("dune-console:discord-oauth-just-configured", ...)` is set **only at the moment `restartNow()` is actually invoked** (not earlier) — this means the Security Architect hat's finding that the wizard's restart is skippable ("Back to sign in") is handled for free: skipping restart means the marker is never set, so the offer correctly never fires (fail-safe, consistent with the tab-close case below), rather than firing against a config change that was never actually applied.
- **Known limitation, unchanged:** `sessionStorage` is cleared if the tab closes before the marker is consumed — the offer silently doesn't appear. **Compensating fix (resolves UI/UX MEDIUM):** §3's collapsed fallback section now independently, persistently offers the same choice ("you can safely turn off this password-based two-factor here any time"), so a missed one-time offer is never the *only* path to the outcome it was nudging toward.
- **New, explicit handling for marker tampering (Security Architect LOW):** the marker is a UI-convenience signal only — planting or replaying it manually can at most cause the offer screen to render inappropriately; it cannot itself weaken any credential, because the screen's actual disable action still goes through the unmodified, fully-gated `requireFreshTier3Proof` path. Stated explicitly here so a future reader doesn't need to re-derive this from first principles.

**Tie-back copy (resolves UI/UX MEDIUM):** given the real gap between wizard completion and the offer's appearance (restart wait, page reload, fresh login, live OAuth round-trip), the offer screen opens with explicit context: *"You just connected Discord sign-in — since your password login also has two-factor turned on, here's a quick decision about it."*

### The zero-2FA guard — now enforced everywhere the disable action is reachable, not just here (resolves Security Architect + UI/UX convergent HIGH)

Revision 1's guard only existed inside this one-time guided flow. **The Security Architect hat found this doesn't close the risk it's meant to close**: the pre-existing, always-available "Disable Two-Factor Authentication" control in the (now-relabeled) fallback section reaches the identical unsafe end state — Discord OAuth active, no Discord-side MFA requirement, no password TOTP — with zero interaction with this guard, guided flow or not.

**Fix:** the same branch logic now lives at the point of disable itself, not only in the offer screen:
- **Discord's own MFA already required for the acting tier:** disabling proceeds normally (existing form, unchanged).
- **Not required:** the Disable-TOTP form (wherever it's reached — offer screen or the fallback section directly) shows: *"Disabling this will leave your console with no two-factor authentication anywhere — Discord sign-in doesn't require Discord's own two-factor for your role. [Turn that on instead] [Disable anyway]"* — a soft warning with an explicit override, not a hard block (a hard block could itself create an availability problem for an operator who has a considered reason to run with no 2FA). This closes the gap for real, at every entry path, rather than only advising once during setup — resolving both the Security Architect's HIGH (enforcement) and the UI/UX hat's convergent HIGH (the "not required" branch previously stranding the operator with no return path — it no longer needs one, since the same choice is always available at the same place, not gated behind a one-time flow).

## 8. Tier 1 → 4 (enable TOTP from a Discord-only session)

Unchanged in substance from revision 1 — no bypass of `requireFreshTier3Proof` anywhere. Confirmed independently by the Security Architect hat as holding throughout this revision too, including the §7 changes above (Finding 7 of the audit, §13: "a session that can already prove the Tier 3 password already has everything the disable route gives it — no escalation path found").

**Scoping note added per the Security Architect hat's finding #8 (§13):** "no bypass of the auth-proof gate" and "no path to the unsafe end state" are two different guarantees — revision 1's framing conflated them. §7's fix above closes the second guarantee too, not just the first; this section's claim is now explicitly scoped to the first (the credential-proof boundary itself, which was never at risk).

- New required step in the Discord wizard's `map`/`done` step (unchanged): password-awareness checkbox before "Finish and Restart."
- Persistent reminder in the fallback section (§3, extended this revision).
- Contextual copy on Enable/Disable-TOTP forms, shown when the acting session is Discord-authenticated (unchanged).

## 9. Phase 3 — age-encryption for the Discord OAuth Client Secret (separate PR, tracked as #679)

**Unchanged in intent from revision 1 (explicitly deferred, own PR), but no longer vaguely deferred** — filed as **#679**, with the Cloud Security hat's findings folded directly into that issue rather than left implicit:

- **Trust boundary problem (HIGH, Cloud Security):** the proposed write side requires the age decryption identity to become reachable from inside the console container, which runs `network_mode: host`, root by default, with Docker-socket access — converting a compromise of that process into master-KEK-adjacent capability, cutting against `docs/security/age-secrets.md`'s own explicit instruction to keep the identity file outside any container.
- **Missing dependencies (HIGH, Cloud Security):** the console image has neither `age` nor `python3`/`cryptography` today.
- **No existing precedent for boot-time decrypt in this specific container (MEDIUM, Cloud Security):** the two existing secrets are decrypted host-side into the *game-server* container; the console container has no analogous wrapper — revision 1's "zero changes, matches existing pattern" claim overstated what's actually established.
- **Sequencing dependency on §6 (HIGH-adjacent, Cloud Security + DBA convergent):** §6's "Forget" handler must be revisited once this ships, to also clear whatever artifact this produces — tracked explicitly in #679's body as a required follow-up against #676's already-shipped code, not left to be silently rediscovered a third time.
- **Upstream-scoping precedent (unchanged from revision 1):** the existing Stage 2 tool's own comments state its narrow scope reflects Red-Blink's explicit prior instruction — #679 should be raised with them directly before implementation, not assumed pre-approved.

## 10. Testing and required documentation updates

**Substantially rewritten in this revision** — the QA hat found revision 1's test plan vague enough to permit a passing-but-tautological implementation throughout. Each item below now names the concrete assertion required, not just the topic:

- **Tri-state split:** tests must assert actual rendered DOM state (which section is expanded/collapsed, matching this codebase's existing convention in `SettingsPanel.credentials.test.tsx` of asserting concrete `aria-label`/placeholder/element presence) for all three states — never a prop-level or mock-level assertion standing in for rendered state.
- **`DISCORD_OAUTH_DISABLED` end-to-end gating:** a real integration test mirroring `oauthRoutes.integration.test.js`'s existing `"Discord OAuth start returns 404 when OAuth is not configured"` test, asserting `GET /api/auth/discord/start` (and the setup-mode variant, per §6.2's fix) returns 404 *after* a real disable-and-restart cycle — not just that the new route writes the flag in isolation.
- **Shared rate-limiter bucket:** an explicit cross-route test — exhaust `credentialProofRateLimiter` via repeated failed `/disable` attempts, confirm password rotation and recovery-code regeneration are now also blocked (and vice versa) — given this exact bucket-sharing was the site of a previously-fixed real DoS bug in this same file.
- **`sessionStorage` marker round-trip:** a genuine two-phase test (write-then-navigate in one render pass, a second independent render that reads and consumes it), mirroring the existing pattern in `App.activeTab.test.tsx` — not merely asserting `sessionStorage.setItem` was called, which proves nothing about consumption.
- **Skip-restart path:** an explicit test that clicking "Back to sign in" (skipping `restartNow()`) never sets the marker and the offer correctly never fires.
- **`enable`'s auth requirement:** an explicit test that `/enable` still requires a valid session + CSRF (matching this codebase's existing `"moderator must not write oauth config"`-style authorization tests) — "no fresh Tier-3 proof required" must not be implemented as "no auth required."
- **Documentation updates required in the same implementation PR** (GRC HIGH finding — revision 1 had no plan for this at all): `docs/console/authentication-upgrade-guide.md` (its Step 3 instruction to reach Two-Factor directly from Settings breaks once that control moves under the fallback disclosure) and `docs/console/two-factor-recovery.md`, both currently Status: Current. RFC `docs/rfc-console-auth.md` §3.4 gets a cross-reference to (or absorbs) this doc's §5 table, per §5's own note above.
- **Session-wipe side effect documented** (GRC MEDIUM): the operator-facing documentation update above must state plainly that disable/enable/forget each force a restart that logs out every currently-active session, of every type, not just the acting one.

Per this project's Requirement 20, this document plus §13 below together constitute the Layer 1 audit. Layer 2 (per-feature) and Layer 3 (integration) Eight Hats passes are still required before anything ships.

## 11. Explicitly out of scope

- Multi-owner support.
- Tier 2 (passkey).
- #679 (age-encryption) implementation — design pointers only here; ships as its own PR after that issue's trust-boundary questions are resolved and Red-Blink has weighed in on the scope expansion.
- ~~#678 (`.env` write-race fix) — acknowledged and linked (§6.5), not fixed as part of this PR~~ **Revision 3: pulled into scope, see §6.5.**
- Any bypass of `requireFreshTier3Proof` — considered and rejected (§8), independently reconfirmed by the audit (§13).
- A password-reveal endpoint — considered and rejected for the same reasoning.

## 12. Decisions log

1. Settings visibility once Discord OAuth is configured: hidden behind an explicit fallback toggle (renamed from "Advanced" in revision 2 — see §3 — because "Advanced" tested as discouraging exactly the break-glass use this section exists for).
2. Tier 4 → 1 migration mechanism: a real guided offer flow, not just passive cross-links — implemented in revision 2 as a standalone post-login screen (§7), not a wizard step, after the audit found the wizard-step framing was structurally impossible.
3. Tier 1 → 3 removal: soft-disable/preserve as the default, hard-forget as a secondary action — revision 2 adds a typed confirmation for forget specifically (§6.4), given ordinary confirmation friction was judged insufficient for an action this irreversible.
4. Multi-owner support: explicitly not supported.
5. #679 scope: designed here, implementation deferred to a separate issue/PR — revision 2 makes this concrete (filed, not just recommended) after the audit found real trust-boundary questions that need resolving first.
6. Revision 2 addition: the zero-2FA guard (§7) is enforced at every path that can reach TOTP-disable, not only inside the guided offer flow, after two independent audit hats converged on the same gap from different angles (security-boundary vs. UX-flow).
7. Revision 2 addition: `/disable` and `/forget` restart immediately and non-skippably, unlike the wizard's existing optional-restart pattern for benign credential rotation — because presenting "disabled" as fait accompli before the restart actually happens is misleading specifically during the scenario (suspected compromise) this action exists for.
8. Revision 3 addition: #678's `.env` write-race fix is pulled into this implementation rather than left deferred, since this design was about to add three more unsynchronized writers on top of a known, twice-found race — fixing the shared helper once is less risk than shipping on top of it a third time.

## 13. Layer 1 Eight Hats audit — findings register

Eight independent dispatches, each reading this document's revision 1 plus the real source it describes, instructed to verify every factual claim rather than trust the doc's prose. Full detail per finding is in the dispatch transcripts; this table is the durable record.

| # | Hat | Severity | Finding | Resolution |
|---|---|---|---|---|
| 1 | Software Architect | **CRITICAL** | The `offer` step cannot be "appended to the wizard" — a hard navigation unmounts it before the post-restart Discord login (a separate code path) could ever reach it. | **Fixed — §7.** Offer is now a standalone `App.tsx` post-login screen, same pattern as `TotpSetupScreen`. |
| 2 | GRC | **CRITICAL** | Zero audit-log design for three new state-changing routes; the destructive "Forget" isn't distinguishable from soft-disable in any log. | **Fixed — §6.3.** Three new named audit events. |
| 3 | DBA | **CRITICAL** | "Forget this configuration entirely" never clears the Client Secret — it's a separate file, not an `.env` key, and revision 1's clear-list only described `.env` keys. | **Fixed — §6.1.** Field list now derived from `config.js` programmatically; secret file explicitly deleted. |
| 4 | Software Architect | HIGH | `discordOAuthAppConfigured` is a second, uncovered gating boolean — setup-mode OAuth routes stay reachable after "disable." | **Fixed — §6.2.** Both booleans now gated. |
| 5 | Software Architect | HIGH | Resulting state collision: a soft-disabled install is indistinguishable, client-side, from "first-time setup, not yet finished." | **Fixed — §6.2.** `discordOAuthDisabled` exposed to and checked first by the wizard's step derivation. |
| 6 | GRC | HIGH | This design silently breaks two Status: Current operator docs with no update plan. | **Fixed — §10.** Named explicitly as required in the same implementation PR. |
| 7 | DBA | HIGH | "Seven keys" undercounts the real `.env` field list. | **Fixed — §6.1** (same fix as #3, by construction). |
| 8 | DBA | HIGH | No rollback path for hard-forget; the doc's reversibility claim only covers the secret, not role/guild config. | **Fixed — §6.4.** Pre-wipe fields logged to the audit entry; confirmation upgraded to typed. |
| 9 | Security Architect | HIGH | Zero-2FA guard is UI-only — the pre-existing Advanced/fallback Disable-TOTP control bypasses it entirely. | **Fixed — §7.** Guard now enforced at every reachable path, not only the guided flow. |
| 10 | UI/UX | HIGH | Same underlying gap as #9, found independently from a flow/discoverability angle — the "turn on Discord MFA first" branch stranded the operator with no way back. | **Fixed — §7** (same fix as #9 resolves both). |
| 11 | Cloud Security | HIGH | §9's write-side design needs the age identity reachable inside the internet-facing, root/Docker-socket-adjacent console container — a real trust-boundary problem. | **Tracked, not fixed here** — #679, explicitly out of scope for this PR (§11). |
| 12 | Cloud Security | HIGH | Console image is missing `age`/`python3`/`cryptography` entirely. | **Tracked** — #679. |
| 13 | QA | HIGH | Test plan vague enough to permit a tautological tri-state-split implementation. | **Fixed — §10.** Concrete DOM-state assertion required. |
| 14 | QA | HIGH | No end-to-end test that `DISCORD_OAUTH_DISABLED` actually gates the live route (only the new route tested in isolation) — same failure class as a prior real incident in this org (a scanner reporting success while never running). | **Fixed — §10.** |
| 15 | QA | HIGH | No cross-route rate-limiter test, despite that exact shared-bucket pattern being a previously-fixed DoS bug in this file. | **Fixed — §10.** |
| 16 | Security Architect | MEDIUM | §7's "restart is always forced" claim is factually wrong — a "Back to sign in" button skips it. | **Fixed — §2, §7.** Doc corrected; marker now set only when restart actually fires. |
| 17 | Security Architect | MEDIUM | Soft-disable's restart is skippable, leaving Discord sign-in live after the UI shows "disabled." | **Fixed — §6.3.** `/disable`/`/forget` restart immediately, non-skippably. |
| 18 | Security Architect | MEDIUM | "Forget"'s fresh-proof gating was left ambiguous. | **Fixed — §6.3.** Explicitly at least as strict as disable. |
| 19 | Cloud Security | MEDIUM | Neither disable nor forget rotates the credential at Discord's side; re-enable has no reminder. | **Fixed — §6.6.** |
| 20 | Cloud Security | MEDIUM | §9's "zero changes, matches existing pattern" claim overstates precedent — no boot-decrypt wiring exists for the console container today. | **Tracked** — #679. |
| 21 | GRC | MEDIUM | §9's deferral had no tracking issue or owner. | **Fixed.** Filed as #679. |
| 22 | GRC | MEDIUM | RFC §3.4 not cross-referenced with this design's own §5 credential-loss table. | **Fixed — §5, §10.** Cross-reference required in the implementation PR. |
| 23 | GRC | MEDIUM | Session-wipe side effect of disable/enable/forget isn't flagged for operator docs. | **Fixed — §10.** |
| 24 | DBA / Cloud Security (convergent) | MEDIUM | `.env` write race is real, pre-existing, and was already found once and lost (a deleted #643-era design doc). | **Fixed for real.** Filed as #678 (§6.5), then pulled into this implementation's scope in revision 3 rather than deferred a third time — a single serialized-write helper wraps every `envFile.js` writer. |
| 25 | QA | MEDIUM | `sessionStorage` round-trip test as specified doesn't prove an actual round trip. | **Fixed — §10.** |
| 26 | QA | MEDIUM | Offer's "first-time, not a re-edit" trigger condition had no specified mechanism to test against. | **Fixed — §7.** Tied to the marker being set only at actual restart invocation. |
| 27 | UI/UX | MEDIUM | Tab-close limitation has no compensating signpost elsewhere in the UI. | **Fixed — §3, §7.** |
| 28 | UI/UX | MEDIUM | Temporal/visual gap between wizard completion and the offer risks it reading as disconnected. | **Fixed — §7.** Explicit tie-back copy. |
| 29 | UI/UX | MEDIUM | "(Advanced)" label may discourage break-glass use mid-incident. | **Fixed — §3.** Renamed to "(fallback)." |
| 30 | UI/UX | MEDIUM | The fallback-section reminder is a passive, easy-to-never-revisit channel. | **Accepted, partially mitigated** by the label rename and extended reminder (§3) — not fully solved; no further mechanism added, to avoid overengineering a low-severity gap. |
| 31 | Network | LOW | Restart-completion copy ("10-20 seconds") understates the real, code-tolerated window (up to 180s). | **Filed as a Layer 2 note** — copy fix, not a design change. |
| 32 | Network | LOW | `enable`'s proof-free restart trigger is a marginal, same-privilege-tier DoS note. | **Accepted as-is** — requires existing owner access, negligible practical severity. |
| 33 | Security Architect | LOW | §7's cited #643 marker precedent doesn't exist yet in this branch. | **Fixed — §2.** Citation corrected to note #643 hasn't landed; underlying pattern choice unaffected. |
| 34 | Security Architect | LOW | The marker is client-writable/replayable; only discussed for the tab-close direction, not tampering. | **Fixed — §7.** Explicitly scoped: at most affects UI display, never the credential-proof gate. |
| 35 | Software Architect | LOW | §7's cited precedent doesn't exist; a real one (`databaseRestartState.ts`) does and wasn't cited. | **Filed as a Layer 2 note** — citation accuracy only. |
| 36 | DBA | LOW | Backup/restore of the new persisted state is unaddressed. | **Filed as a Layer 2 note**, given `docs/console/authentication-upgrade-guide.md` already has a precedent section (TOTP state) to extend. |
| 37 | DBA | LOW | §9 doesn't address legacy-plaintext-file cleanup at migration time (only at forget time). | **Tracked** — #679. |
| 38 | UI/UX | LOW | Wizard checkbox copy (§8) lacks the "or ask whoever manages the server" fallback present in the Enable/Disable contextual copy. | **Filed as a Layer 2 note** — copy consistency only. |
| 39 | QA | LOW | `/enable`'s "no proof required" is easy to misread as "no auth required." | **Fixed — §10.** Explicit test named. |

**Severity totals:** 3 CRITICAL (all fixed), 12 HIGH (10 fixed in this revision, 2 tracked in #679 as out-of-scope-for-this-PR), 13 MEDIUM (10 fixed, 2 tracked in #678/#679, 1 accepted-as-is), 8 LOW (3 fixed, 4 filed as Layer 2 notes, 1 accepted-as-is), plus multiple findings independently confirming existing design elements as sound (`requireFreshTier3Proof`'s no-bypass property, the three-state model's compatibility with existing binary consumers, the audit-trail-worthy nature of the disable/enable asymmetry) — not tabulated above since they produced no action item.

### STRIDE report

| Category | Findings | Highest severity | Status |
|---|---|---|---|
| Spoofing | 9, 10, 17, 34 | HIGH | Resolved (§7, §6.3) |
| Tampering | 3, 18, 24, 34 | CRITICAL | Resolved (§6.1, §6.3, filed #678) |
| Repudiation | 2 | CRITICAL | Resolved (§6.3) |
| Information Disclosure | 3, 11 | CRITICAL | Resolved (§6.1); #679 portion tracked, not resolved in this PR |
| Denial of Service | 15, 32 | HIGH | Resolved (§10); LOW item accepted as-is |
| Elevation of Privilege | 4, 5, 9, 10, 14 | HIGH | Resolved (§6.2, §7, §10) |

No finding from this audit was left STRIDE-unmapped where a mapping genuinely applied; GRC, Network (except 15/32), and most DBA findings are marked N/A per-finding in the dispatch transcripts, consistent with this project's established pattern that not every finding maps to a STRIDE category.
