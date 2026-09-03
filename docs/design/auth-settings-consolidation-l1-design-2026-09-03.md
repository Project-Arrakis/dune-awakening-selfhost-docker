# Consolidate Settings' Password/2FA and Discord OAuth sections — L1 Design

**Status:** L1 design, revision 1
**Tracking issue:** dune-awakening-selfhost-docker#676
**Related:** #641 (guided Discord app-creation wizard, shipped to `tier1-upstream`), #643 (embed that wizard into Settings — this design treats #643 as a given, building the page structure around the embedded wizard, not the manual accordion it replaces), #665/#666 (the originating live-testing feedback thread this design continues), #634 (IAM Visual Editor, same branch)

## 1. Problem

Live operator testing (feedback relayed from Red-Blink) found Settings' authentication area confusing once Discord OAuth is configured:

- The "Two-Factor Authentication" section gives no indication it governs the *password* credential (Tier 3) specifically — it has zero relationship to Discord OAuth sign-in (Tier 1), but nothing on the page says so.
- There is no guided path between the two credentials in either direction — an operator wanting to move from one to the other has to intuit it (e.g. "disable 2FA, then separately go find the Discord wizard").
- No tier-loss scenario has a designed answer beyond what already exists piecemeal in the RFC's credential-loss table (§3.4) and various error-page strings.

This design covers the full space: page structure, every tier-to-tier transition, and every break-glass path — verified against the real code, not assumed.

## 2. Terminology and verified current state

Using operator shorthand for this document: **Tier 3** = password only. **"Tier 4"** = Tier 3 with TOTP enabled (not a separate credential store — Tier 3's optional second factor). **Tier 1** = Discord OAuth. **Tier 2** = passkey/WebAuthn — **does not exist in code**, RFC §2.2 only; every Tier 2 cell below is explicitly out of scope until it's built.

Verified directly against `tier1-upstream`@`e602dbd6`:

- `requireFreshTier3Proof()` (`server.js`) requires the literal current password, "regardless of how the acting session authenticated" (RFC §2.2) — deliberate, to stop a Discord OAuth session from taking over or degrading the password credential's own second factor. **This design does not weaken that rule anywhere.**
- No route exists to remove/unconfigure Discord OAuth once set — only rotate-in-place (`write-oauth-config`, `save-oauth-secret`).
- `/api/settings/admin-password` only ever *sets* a new password; there is no route that reveals the current one.
- Console TOTP has zero connection to the Discord OAuth login path — confirmed via a code comment on the login screen itself: "never a second factor on top of Discord." Discord's own 2FA is a separate, already-wired mechanism (`discordOAuthRequireMfaTiers` / `mfaGateReason()`, checking Discord's own `mfa_enabled` flag).
- Every Discord OAuth failure path in the code (bot handoff misconfigured, unsound role mapping) points to the same fallback string: "Sign in with the admin password in the meantime." Tier 1's break-glass *is* Tier 3.
- The wizard's `done` step triggers a real container restart (`docker rm -f` + `up -d`), which unconditionally wipes the in-memory session store — every session type is invalidated by any Discord OAuth config change requiring a restart, not just the acting one.
- The Settings nav item and every `settings:*` action (which includes both new TOTP routes) are already owner-only, both in the sidebar filter (`hasSettingsAccess`) and mechanically via `CROWN_JEWEL_DENY_ACTIONS`. No change needed here.
- Multi-owner support is explicitly out of scope (operator decision) — this design assumes exactly one Owner identity per install, however they authenticate.

## 3. Settings page structure

Restructure the authentication area into a primary/secondary split, driven by `discordOAuthConfigured`:

- **Not configured:** Password Sign-In (password change + the Two-Factor toggle) stays primary/visible, unchanged from today. A prominent call-to-action for the embedded Discord wizard (#643) sits alongside it.
- **Configured and active:** the embedded Discord wizard becomes primary, open by default. Password Sign-In moves under a collapsed **"Password Sign-In (Advanced)"** disclosure, closed by default — same controls, just demoted in prominence. A persistent one-line reminder lives in this collapsed section: *"This password is Discord sign-in's break-glass fallback if it's ever unavailable — make sure whoever manages Discord access also knows it."*
- **Configured but disabled** (new third state, §6): a compact banner — "Discord Sign-In (disabled)" — with a one-click "Re-enable," Password Sign-In reverts to primary in this state, plus a secondary "Forget this configuration entirely" action.

## 4. Full tier-transition matrix

| From → To | Mechanism | Settings panel: visible/functional | Interrupted mid-way? |
|---|---|---|---|
| **3 → 4** | Settings → Two-Factor → Enable: password only → `POST /api/auth/2fa/enable` mints a 10-min enrollment session → full-screen QR (`TotpSetupScreen`) → confirm → recovery codes shown once, acknowledged → forced logout → real re-login with password + TOTP. | Before: "Two-Factor (off)," open, primary. During: full-screen takeover, Settings unreachable. After: "Two-Factor" shows enrolled (Regenerate/Disable). | Safe — enrollment only commits on `/2fa/confirm`; an abandoned session just expires (existing "abandoned enrollment" test coverage). |
| **4 → 3** | Settings → Two-Factor → Disable (password + current code). | Both states already fully built. | Safe — single atomic request. |
| **3 → 1** | Discord setup wizard (#641, embedded per #643) from a password session. | Discord OAuth section becomes primary once configured; password collapses under Advanced per §3. | Resilient — wizard re-derives its step from live server state on every mount, no frozen client state. |
| **4 → 1** | Same wizard, plus a new conditional `offer` step (§7). | Same as 3→1, plus a one-time full-screen offer after first-time completion. | New, designed risk — see §7's marker-durability note. |
| **1 → 3** (full removal) | New: soft-disable (§6), reversible. Secondary: hard "forget" (§6). | Discord section shows the disabled banner; Password Sign-In returns to primary. | N/A — single request either way. |
| **1 → 4** | No new backend mechanism — resolved via operator awareness, not a new bypass (§8). | Enable/Disable forms remain visible; now carry contextual copy explaining where the password lives when the acting session is Discord-authenticated. | N/A |

## 5. Break-glass per tier

Happens at the **login screen**, not Settings — you cannot reach Settings without already being authenticated by some means.

| Tier broken | Recovery path today | Depends on |
|---|---|---|
| 3 (forgot password) | None in-browser, by explicit RFC design. Host filesystem access: `runtime/secrets/admin-web-password.txt`, or set `ADMIN_PASSWORD` env + restart. | Physical/host access |
| 4, TOTP device lost, codes held | Recovery-code login at the login screen → forced re-enrollment | Having saved the codes |
| 4, TOTP *and* codes lost | Host-filesystem reset: delete `runtime/generated/console-second-factor.json`, restart → falls back to Tier 3 | Physical/host access |
| 1 broken (bot down, app revoked, unsound role mapping, Discord API outage) | Every error path points to the same line: "Sign in with the admin password in the meantime." | **Knowing the Tier 3 password** |
| 2 | N/A — not built | — |

**Central finding:** Tier 1 → 4 being blocked (§8) and Tier 1's own break-glass fail for the identical reason — an Owner who has only ever used Discord OAuth, never told the password, is one Discord outage away from total lockout with no in-browser recovery. §8 is this design's answer to that.

## 6. Tier 1 → 3, complete removal

New capability — no removal path exists today, only rotate-in-place.

- **Default: soft-disable**, not a hard wipe. New route `POST /api/settings/discord-oauth/disable`, gated by `requireFreshTier3Proof` (reused for a **different reason** than its other callers — not Tier 3 credential integrity, but a self-lockout guard: since Tier 3 can never be removed, the one real risk is the *acting session* not actually knowing the password it's about to become solely dependent on). Sets a single new flag (`DISCORD_OAUTH_DISABLED=1`) checked first by `discordOAuthConfigured`/`discordSignInAvailable`, short-circuiting both to false — every other Discord OAuth `.env` key (client ID, secret, guild ID, roles, MFA list) stays untouched on disk.
  - Rationale for preserving config over clearing it: (a) the Client Secret is never displayed back to the operator by this UI even today, so a hard wipe *always* forces a Discord Developer Portal "Reset Secret" round-trip regardless of what we keep, while soft-disable makes "changed their mind" a single click with zero Discord-side work; (b) no meaningful security difference — the secret already sits in `runtime/secrets/` at the same permissions while active, so keeping it dormant adds no real exposure; (c) touches one key instead of seven, avoiding the exact "write empty string instead of omitting the key" bug class this codebase has already hit twice.
  - `POST /api/settings/discord-oauth/enable` (symmetric) requires no fresh proof — re-enabling only adds back an existing option, it cannot strand anyone.
- **Secondary: "Forget this configuration entirely"** — a clearly separated danger action for an operator who wants the credential genuinely gone (handing off the box, suspects compromise). Clears all seven keys and any age-encrypted artifact (§9), same restart mechanism.
- Both actions trigger the existing restart pattern; afterward `discordOAuthConfigured`/`discordSignInAvailable` reflect the new state and Settings/the login screen both revert to password-primary automatically per §3 — no new logic needed there.

## 7. Guided Tier 4 → 1 flow (the "Switch to Discord Sign-In" journey)

No new standalone wizard — one appended conditional step, **`offer`**, on the existing 4-step Discord wizard (`connect → authorize → map → done`), shown only when both hold at the moment `done`'s restart-and-reconnect completes:

- This was a first-time configuration (unconfigured → configured transition), not an edit of existing settings — re-running "Change application credentials" later never re-triggers it.
- `secondFactorEnrolled: true` at the time setup began.

**Why the restart makes this genuine verification, not simulated:** the wizard's `done` step always forces a full container restart, which unconditionally wipes the session store — the operator is *always* dropped to a real login screen afterward. Clicking "Sign in with Discord" there and landing back in as Owner is live, end-to-end proof it actually works, not an assumption.

**Data flow across the restart:** a `sessionStorage` marker (`dune-console:discord-oauth-just-configured`, same pattern as #643's own `discord-setup-return` marker), set immediately before the restart, consumed once after the fresh Discord login succeeds. **Known limitation:** `sessionStorage` is cleared if the tab closes — if the operator closes the tab during the restart wait and returns in a new tab, the offer silently never appears. Accepted as low-severity (a missed convenience, not a safety issue) rather than switching to `localStorage`, to stay consistent with #643's existing precedent for this exact pattern; revisit only if this turns out to bite operators in practice.

**The zero-2FA guard (why this isn't just "offer to turn TOTP off"):** naively encouraging TOTP-off once Discord is configured risks leaving the operator with no 2FA anywhere, if `discordOAuthRequireMfaTiers` was never turned on. The `offer` step branches:

- **Discord 2FA already required for this tier:** *"Discord sign-in already requires Discord's own two-factor for your role. Turn off the separate password-based two-factor?"* → reuses the existing Disable-TOTP form verbatim (still requires the current password + a live authenticator code).
- **Not required:** *"Discord sign-in doesn't require Discord's own two-factor yet — turn that on first"* with a link into the (now-primary) Discord OAuth section's existing MFA field. **No option to disable password TOTP is shown in this branch at all.**

Declining/skipping either branch drops the operator into the normal dashboard; the collapsed Advanced section remains available for later, at their own pace.

## 8. Tier 1 → 4 (enable TOTP from a Discord-only session)

**No bypass of `requireFreshTier3Proof` anywhere in this design.** Letting a Discord OAuth session prove itself sufficiently to touch the password credential would recreate the exact escalation risk that rule exists to prevent — that security boundary is unchanged.

Instead, this is an awareness fix:

- **New required step in the Discord wizard's `map`/`done` step**, first-time configuration only (the acting session is always password-tier at that point, since Discord OAuth can't exist yet — the checkbox is trivially satisfiable, not a proof-gate): *"This console also has a separate admin password — a break-glass fallback if Discord sign-in is ever unavailable. Confirm you (or your server operator) know it before continuing: it's in `runtime/secrets/admin-web-password.txt` on the host."* Required before "Finish and Restart."
- Same one-line reminder, persistently, in the collapsed Advanced section (§3) — covers installs that configured Discord OAuth before this existed.
- **Contextual copy on the Enable/Disable-TOTP and password-rotation forms**, shown specifically when the acting session is Discord-authenticated (same distinction `invalidatePasswordSessions` already makes — non-empty `userId`): *"This protects the console's separate password login. Don't know it? Check `runtime/secrets/admin-web-password.txt` on the host, or ask whoever manages the server."*

This directly resolves the original complaint ("why does this ask for a password with no explanation") and, combined with §6's soft-disable default, closes the central finding from §5 operationally — without opening any new privilege-escalation path.

## 9. Phase 3 — age-encryption for the Discord OAuth Client Secret (separate PR)

**Flagged explicitly as its own follow-on, not part of this design's implementation PR.**

`runtime/scripts/secrets-cli.sh`/`lib/secrets_aead.py` is a real, working age-based KEK/DEK secrets library — but its own code comments state it is "Stage 2," hardcoded to exactly 2 secrets (`server-login-password-secret`, `username-server-login-secret`), and that this narrow scope reflects **"the upstream maintainer's explicit instruction to keep [PostgreSQL/Funcom/RabbitMQ] out of this first integration."** Discord OAuth secrets aren't named either way, but given that history, extending this tool is a visible decision worth surfacing to Red-Blink directly, not something to fold in silently.

There is also a real architectural gap, not just an allow-list edit: the two existing secrets are provisioned by an operator running `dune secrets migrate` by hand on the host, outside any live process — pure decrypt-once-at-boot, shell/Python only, Node never involved. The Discord Client Secret is different: it's submitted live, through the running console, whenever an Owner pastes it into the wizard. Protecting it with this same tooling means:

- **Read side (simple, matches existing pattern):** decrypt once at container start into the same plaintext location `config.js` already reads (env var or `runtime/secrets/`-style file) — zero changes to how the API reads the value.
- **Write side (new):** when `DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` are configured, the console's `save-oauth-secret` route needs to shell out to the same `secrets_aead.py`/age primitives *at save time* to encrypt-and-write the new value as a migrated artifact — a genuinely new integration pattern (Node invoking the shell/Python tooling live, from the request path), not something this library has done before. When those env vars are absent (the default), behavior is unchanged — matches the existing tool's own "strictly opt-in, zero behavior change" philosophy.

Recommended scope for the follow-up: extend the Stage 2 allow-list to a Stage 3 entry (`discord-oauth-client-secret`), add the encrypt-on-save code path to `save-oauth-secret`, decrypt-at-boot for the read side, and (per §6) ensure "Forget this configuration entirely" also runs the equivalent of `dune secrets cleanup-legacy` for this artifact. Out of scope for that follow-up: the bot handoff secret, and any other secret beyond this one, unless separately decided.

## 10. Testing

- Structural tests for the primary/Advanced/disabled tri-state split in Settings.
- Wizard test for the `offer` step's two trigger conditions (first-time only, TOTP-enrolled only) and both zero-2FA-guard branches.
- Regression test for the `sessionStorage` marker surviving the restart round-trip (mirrors #643's own required test for its return-routing marker), plus a test confirming the accepted tab-close limitation behaves as documented (offer silently doesn't appear, nothing else breaks).
- New backend tests for `/api/settings/discord-oauth/disable` (requires fresh proof, sets the one flag, doesn't touch other keys) and `/enable` (no proof required).
- No new backend test surface for §8 — pure copy/UX, no new routes.

Per this project's Requirement 20, this document is the Layer 1 audit. Implementation still requires Layer 2 (per-feature) and Layer 3 (integration) Eight Hats passes before anything ships, matching #643's own precedent.

## 11. Explicitly out of scope

- Multi-owner support (operator decision, §2).
- Tier 2 (passkey) — not built; nothing here depends on it.
- §9 (age-encryption) implementation itself — design only, ships as a separate issue/PR after this one, and after raising the scope-expansion question with Red-Blink.
- Any bypass of `requireFreshTier3Proof` — considered and explicitly rejected in §8.
- A password-reveal endpoint — considered and rejected for the same escalation reasoning as the `requireFreshTier3Proof` bypass; awareness (§8) was chosen instead.

## 12. Decisions log

For audit trail, since several of these were live either/or calls made during this design's brainstorming session rather than derived from precedent:

1. Settings visibility once Discord OAuth is configured: hidden behind an explicit Advanced toggle (not just relabeled, not a separate hidden tab).
2. Tier 4 → 1 migration mechanism: a real guided offer step (§7), not just passive cross-links.
3. Tier 1 → 3 removal: soft-disable/preserve as the default, hard-forget as a secondary action — not a forced full wizard re-entry.
4. Multi-owner support: explicitly not supported, simplifying §5's break-glass reasoning to a single Owner identity.
5. §9 scope: designed here, but implementation deliberately deferred to a separate PR/issue given the upstream-maintainer-scoping precedent.
