# Embed the guided Discord setup wizard into Settings — L1 Design

**Status:** Draft (revision 1)
**Tracking issue:** dune-awakening-selfhost-docker#643
**Related:** #641 (guided wizard, already shipped to `tier1-upstream`/`feat/634-iam-visual-editor`), #634 (IAM Visual Editor, same branch)
**Scope note:** the wizard's own OAuth/HTTPS-gate mechanics were already
design-audited for #641. This pass is scoped to the *composition* question —
is it safe and correct to mount the same component from a second location
(Settings, post-login) — not a re-audit of OAuth internals.

## 1. Problem

Live-testing question from the operator: "is it possible to setup discord
once logged in? maybe under settings?"

Answer found by reading the code (not assumed): partially, yes, today.
`console/web/src/features/settings/SettingsPanel.tsx` has its own,
independent "Discord OAuth" accordion (~80 lines: `discordOAuthOpen` state
and 8 sibling field states, `saveDiscordOAuth()`, and the JSX block around
line 535) that predates the guided wizard. It posts to the same
`write-oauth-config`/`save-oauth-secret` endpoints, but has none of #641's
improvements — no HTTPS gate, no have-app/need-app branch with a Developer
Portal link and checklist, and confirmed live this session: after saving, it
only prints "Discord OAuth config saved. Restart the console for changes to
take effect." as plain text, with no restart button. An operator saved
config, logged out (not restarted), and was still asked for TOTP because the
running process had not reloaded `.env` — exactly the failure mode #641's own
connect-step fix (this session, `e0ccbfca`) already solved for the wizard.

Decision (put to the operator directly, they chose it): embed
`DiscordSetupWizard` into Settings, **replacing** the manual accordion,
rather than maintaining two divergent implementations of the same flow.

## 2. Verified evidence: this is a UI-composition question, not a new access-control surface

Checked directly against the actual deployed branch
(`feat/634-iam-visual-editor`, not fork `main` — fork `main` is ~1,100
commits behind and an earlier pass of this investigation was misled by
reading stale code there before catching the mistake):

- **Every route the wizard calls is owner-gated at the action layer, not the
  login-state layer.** `actions.js` maps `write-oauth-config`,
  `save-oauth-secret`, `discord-finalize`, and `discord-restart` all to
  `settings:write` — deliberately, per an existing comment
  (`actions.js:68-70`): "these routes rewrite the console's own
  authentication trust anchor... gating them on setup:write [would] let an
  admin-tier Discord session escalate to owner." `settings:*` is on
  `policy.js`'s `CROWN_JEWEL_DENY_ACTIONS` list, permanently denied to any
  non-owner tier and mechanically enforced by `setPolicies()`'s crown-jewel
  guard (the same code path this session fixed a wildcard-bypass in for
  #634, `de0ed64b`) — an owner cannot grant this away even via the new IAM
  Visual Editor.
- **`GET /api/auth/discord/start?setup=1` (the "Continue with Discord"
  link's target) is session/tier-based, not login-state-based.** Read the
  actual handler (`server.js`, the `setup=1` branch): it calls
  `auth.requireAuth(req, res)` and checks `ownerSession.tier === "owner"` and
  `!SETUP_SCOPES.has(ownerSession.scope)` (`SETUP_SCOPES` = `enroll`/
  `resetup`, unrelated restricted sessions). Nothing here distinguishes "a
  session that was just created by entering the admin password, mid the
  pre-login wizard" from "a session that has been open for an hour while the
  operator uses the console normally, now opening Settings" — both are
  plain owner sessions and pass identically.
- **`discordSetupFinalize` (the map/role-mapping step) is likewise
  session-based only**: CSRF token match, `session.pendingDiscordSetup`
  captured during this session's own OAuth round-trip, and
  `guild.owner === true`. No special-casing for when in the login lifecycle
  it runs. Re-running it from Settings to remap roles or reconnect a
  different guild is therefore already a legitimate, supported
  reconfiguration action for an owner, not a new capability this change
  introduces.

**Conclusion**: the backend imposes no login-state assumption anywhere in
this path. The only real open questions are UI composition and the two
divergent implementations' behavioral differences (below) — not new attack
surface.

## 3. Proposed approach

- Add an `embedded?: boolean` prop (default `false`) to `DiscordSetupWizard`.
  When `true`, skip the `<main className="login-screen">` wrapper (a second,
  nested `<main>` inside the app shell is invalid HTML and the fixed
  full-viewport `.login-screen`/`.login-panel` styling would break Settings'
  layout) and render the same step content inside a plain `<div
  className="discord-setup-embedded">` instead. No change to any of the
  step logic, `probe()`, `saveApp()`, `restartNow()`, or the HTTPS gate —
  only the outermost wrapper differs.
- In `SettingsPanel.tsx`, replace the entire "Discord OAuth" accordion body
  (state: `discordOAuthOpen`, `discordOAuthSaving`, `discordOAuthResult`,
  `discordClientId`, `discordRedirectUri`, `discordClientSecret`,
  `discordSecretSaved`, `discordHomeGuildId`, `discordAdminRoleIds`,
  `discordModeratorRoleIds`, `discordPlayerRoleIds`,
  `discordRequireMfaTiers`; function: `saveDiscordOAuth()`; the JSX block)
  with `{discordOAuthOpen && <DiscordSetupWizard embedded onDone={...}
  onCancel={() => setDiscordOAuthOpen(false)} />}` — no dual
  implementation.
- `onCancel`: collapse the accordion (`setDiscordOAuthOpen(false)`).
- `onDone`: in the login-flow context this ends the wizard and completes
  sign-in; in Settings there is no sign-in to complete. Collapse the
  accordion and re-run Settings' own config probe (`load()`/whatever
  SettingsPanel's existing refresh function is called) so the panel reflects
  the newly-saved state immediately, matching the pattern
  `saveDiscordOAuth()` already uses today.
- Re-running the wizard from Settings when Discord is already fully
  configured naturally lands on `step === "map"` (identity not yet
  captured this session) or `step === "authorize"` — both already handle
  "reconfigure an existing setup," so no special "edit mode" is needed.

## 4. Explicitly out of scope for this change

- Any change to the wizard's own OAuth/HTTPS-gate/restart logic — already
  shipped and audited for #641.
- Any change to server-side route gating — verified unnecessary (§2).
- A "back to the old manual per-field form" fallback — the decision was to
  fully replace it, not keep both.
