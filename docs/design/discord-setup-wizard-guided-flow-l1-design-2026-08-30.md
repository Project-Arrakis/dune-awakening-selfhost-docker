# Discord Sign-In Setup Wizard: Guided App Creation + Hard HTTPS Gate — L1 Design

**Date:** 2026-08-30
**Status:** L1 design, revision 1, submitted for Eight Hats Layer 1 audit before implementation.
**Tracking issue:** `dune-awakening-selfhost-docker#641`.
**Originated from:** live-testing feedback during PROMPT 2 validation of the layered-auth upstream PRs. Distinct, separate feature from #634 (the IAM Visual Editor) — this document only concerns the Discord OAuth **setup** wizard (`DiscordSetupWizard.tsx`'s "connect" step), not Access Control.

---

## 1. Why

Live operator testing of the guided Discord sign-in setup wizard surfaced two real gaps in its very first "connect" step (reached before any Discord OAuth configuration exists at all):

1. **The step tells the operator to SSH into the host and hand-edit `.env`**, even though the wizard's own *later* step (role mapping) already automates `.env` writes and a full restart-and-reconnect cycle, and a *separate* part of the console (`SettingsPanel.tsx`, reachable only after this initial setup is already done) already has a working form for the exact same Client ID/Secret values, calling the exact same backend routes. The automation already exists; it's just not present at the one point in the flow where an operator most needs it (first-time setup, before Discord is configured, when leaving the console to SSH in and back is the most disruptive).
2. **The HTTPS requirement is a small warning paragraph, not a hard gate.** An operator can click "Continue with Discord" over plain HTTP and get a confusing, unrelated-looking downstream failure ("invalid or expired") with no obvious link back to the real cause — the browser silently drops the callback. The wizard's own text already asserts HTTPS as an absolute requirement with no stated exception; letting the operator proceed anyway just delays and obscures the failure rather than preventing it.

Two clarifications surfaced during the same discussion, verified directly, that shape this design's scope (§3):
- **Discord OAuth does not require the console to be reachable by Discord's own servers** — the flow is entirely browser-redirect-based (browser → Discord → browser → console), never server-to-server from Discord's side. The only reachability requirement is that the *signing-in person's own browser* can reach the console (LAN, VPN, or public internet all work), plus HTTPS on the redirect URI.
- **TOTP (Tier 3) has no network dependency at all** — irrelevant to this design, noted only because the same live-testing conversation raised it; confirms this design's HTTPS requirement is specific to the Discord OAuth path, not the console generally.

## 2. Verified current state — two baselines (2026-08-30)

**On `main`@`c4b248ad`:**
- `console/api/src/server.js` already has `POST /api/setup/write-oauth-config` and `POST /api/setup/save-oauth-secret` (confirmed at lines 993-994, handlers `writeOAuthConfig`/`saveOAuthClientSecret`), and both already redact the secret in their audit log entries.
- `console/web/src/features/settings/SettingsPanel.tsx` already has a working `saveDiscordOAuth()` function calling both routes, with real Client ID/Secret input fields.
- **`DiscordSetupWizard.tsx` does not exist on `main` at all** — the guided setup wizard is `tier1-upstream`-only.

**On `tier1-upstream`@`291f71fc`:**
- `DiscordSetupWizard.tsx` (185 lines) implements a 4-step flow (`connect` → `authorize` → `map` → `done`), derived live from server state on every mount/refresh (no frozen client-side step tracking — the component's own header comment explains this is deliberate, so a refresh or a return from the Discord round-trip always resumes at the right place).
- The `connect` step (shown when `!app?.configured`) currently renders **only static instructional text**: a bullet list naming the three required `.env`/`runtime/secrets/` values, a link to Discord's Developer Portal (the bare `https://discord.com/developers/applications` URL, not a deep link to any specific sub-page), and — relevant to this design's §4.2 — a conditional warning paragraph shown only `{!isHttps && ...}`, where `isHttps = window.location.protocol === "https:"`. This is the "fine print" the live-testing session flagged.
- The redirect URI shown in this step (`` `${window.location.origin}/api/auth/discord/callback` `` at line 19) is already computed dynamically from the browser's own current origin — confirmed not hardcoded to any example or specific deployment's address.
- The `map` step already POSTs to `/api/setup/discord-finalize` and the `done` step already has a full restart-and-reconnect flow (`restartNow()`, `POST /api/setup/discord-restart`, then polling `/api/auth/state` for up to 3 minutes until `discordOAuthConfigured` flips true before reloading) — this is the existing automation §3/§4.1 reuses.
- `SettingsPanel.tsx` on this branch has the same `saveDiscordOAuth()`/`write-oauth-config`/`save-oauth-secret` pattern as `main`, with additional fields (role IDs, MFA tiers) added for its role as the *post-setup* reconfiguration surface — this design does not touch `SettingsPanel.tsx`.

**Implementation of this feature depends on `tier1-upstream` (the whole branch, since `DiscordSetupWizard.tsx` itself only exists there), same explicit merge-gate discipline as #634:** do not begin implementation until `tier1-upstream` (or whatever supersedes it) is confirmed merged to `main` — check directly (`git grep DiscordSetupWizard main`), don't assume.

## 3. Scope

**In scope:**
1. Replace the `connect` step's static "have you considered SSH-ing in and hand-editing `.env`" instructions with a guided flow: ask whether the operator already has a Discord application; branch to either a direct form or an assisted app-creation path; either way, land on the same Client ID/Secret form, reusing the existing `write-oauth-config`/`save-oauth-secret` routes `SettingsPanel.tsx` already calls (no new backend routes).
2. For the "I need to create one" branch: open Discord's Developer Portal in a new tab/window, and use a **soft, non-blocking** signal (the operator's own tab regaining focus) to show a "welcome back" nudge pointing at the form — never a hard gate on detecting the other tab closed, and the form is visible and usable from the moment this branch is chosen, independent of whether that signal ever fires.
3. Replace the HTTPS warning paragraph with an **unconditional blocking panel** when `!isHttps`: no path past it, shown before any of the guided-setup content in item 1 (there's no point walking through Discord app setup if the OAuth flow can't work at all yet). Lists free ways to get HTTPS: Cloudflare Tunnel (this project's own existing pattern for every other subdomain it runs), Tailscale Funnel, ngrok — brief description + link each, operator chooses based on their own setup.
4. Keep the "you must also add this exact redirect URI to the application's OAuth2 redirect list in Discord's own portal" instruction visible and prominent throughout item 1's flow, in both branches — this step happens entirely on Discord's site and can never be automated from here.

**Explicitly out of scope:**
- **Automating tunnel provisioning itself** (a "start a Cloudflare Tunnel for me" button). This is a separate, materially larger, security-sensitive feature — spinning up a process that exposes the host to the public internet from a web UI is a new trust boundary (who can trigger it, what stops it being triggered repeatedly/maliciously, how is its lifecycle managed, what happens if the console restarts while it's running) that deserves its own L1 design and audit, not a rider on this one.
- **Verifying the redirect URI is actually registered in Discord's portal.** No API exists for the console to check this from the outside (Discord's OAuth2 app configuration isn't queryable by a client with just a Client ID/Secret) — the operator's own word, and the eventual real OAuth attempt in the `authorize` step, remain the only confirmation.
- **Detecting a self-signed/untrusted certificate specifically.** §4.2's HTTPS check is protocol-only (`window.location.protocol === "https:"`), same as today — a self-signed cert satisfies this check while Discord's redirect would still work fine for a browser that's already accepted the cert warning (Discord itself never validates the console's certificate; only the signing-in person's browser does, at the redirect step). Distinguishing "real HTTPS" from "self-signed HTTPS" is out of scope; noted as an open question (§5).
- **Changing `SettingsPanel.tsx`.** It already works and is unaffected by this design.

## 4. Design

### 4.1 Guided app-creation flow

Replaces the current static instructional block in the `connect` step. New local component state: `appPath: "unset" | "have-app" | "need-app"`.

**Initial sub-step (`appPath === "unset"`):** two buttons, "I already have a Discord application" and "I need to create one" — both set `appPath` accordingly, nothing else.

**`appPath === "have-app"` and `appPath === "need-app"` both render the same Client ID/Secret form** — literal reuse of `SettingsPanel.tsx`'s existing field shape (`discordClientId`, `discordClientSecret` local state, a `SecretInput` for the secret) and its existing save call shape (`POST /api/setup/write-oauth-config` with `DISCORD_OAUTH_CLIENT_ID`/`DISCORD_OAUTH_REDIRECT_URI`, then `POST /api/setup/save-oauth-secret` with `{ secret, overwrite }` when a secret was entered) — no new backend contract. On successful save, re-run `probe()` (the wizard's existing state-refresh function) so the step machine naturally advances once the server reports `discordOAuthAppConfigured` — no new step-tracking state needed, consistent with the component's existing "always derive from live server state" design.

**`appPath === "need-app"` additionally**, on entering this sub-step: `window.open("https://discord.com/developers/applications", "_blank")` (the general applications list — Discord has no documented stable deep-link to pre-open the "create new application" modal, so linking further than the list page would be guessing at an undocumented URL, which is exactly what Requirement 12's "never assert what you haven't verified" discipline warns against; confirm at implementation time whether Discord has since added one). A `visibilitychange`/`focus` listener on `window` (not on the child window handle — cross-origin restrictions mean the child's `.closed` property is the only readable signal from that side, and it only tells us "closed," never "finished") sets a `returnedFromDiscord: boolean` flag the first time the tab regains focus after opening; render a small, dismissible "Welcome back — paste your new application's Client ID and Secret below" note when true, pointing at the already-visible form. This is cosmetic only: the form is fully usable in both sub-steps regardless of whether this listener ever fires (popup blocked, opened in the same tab via a modifier-click, or a second-device workflow where the operator never returns focus to this tab at all).

The existing bullet list explaining what `DISCORD_OAUTH_REDIRECT_URI` must be and that it must *also* be added to the application's own OAuth2 redirect list (current lines 123-125) stays, verbatim in substance, visible in both sub-steps — this is the one manual, un-automatable step regardless of path.

### 4.2 Hard HTTPS gate

Computed identically to today (`isHttps = window.location.protocol === "https:"`), but now checked **before** rendering any step-specific content — including before the `appPath` branch in §4.1. When `!isHttps`, render a dedicated panel (not a small paragraph) with:
- A clear, singular statement: Discord sign-in requires HTTPS, and this page is not currently loaded over HTTPS, so the rest of this setup cannot proceed yet.
- Three free options to get there, each a short paragraph + link: **Cloudflare Tunnel** (recommended — this project's own existing pattern; a "quick tunnel" needs no account and gives an instant `*.trycloudflare.com` HTTPS address, a named one needs a Cloudflare account with a domain in their DNS for a stable address), **Tailscale Funnel** (a good fit if the console is already reached over Tailscale for LAN/VPN access — the same tool can also expose an HTTPS endpoint), **ngrok** (well-known, free tier works, URL changes on restart unless paid).
- No way to dismiss or bypass this panel and reach the rest of the wizard while `!isHttps` — reaching HTTPS is the only way past it (a page reload naturally re-evaluates `isHttps` once the operator has actually set one of the above up and switched to the HTTPS address).

## 5. Open questions for Layer 1 review

1. Does Discord in fact have an undocumented-but-stable deep-link URL to open the "create new application" flow directly, or does §4.1 correctly fall back to the bare applications-list URL? Needs checking at implementation time against Discord's current site, not assumed either way.
2. Is a protocol-only HTTPS check (§4.2, unchanged from today) sufficient, or does the real risk of a self-signed certificate silently "passing" this gate while still not working the way an operator expects warrant a stronger check (e.g., attempting a `fetch` to a well-known HTTPS-only endpoint and inspecting for a certificate warning — not straightforward from client-side JS at all) — or is this genuinely out of reach for a browser-side check and better left as a documented limitation?
3. Should recommending three named third-party services (§4.2) carry a brief disclaimer that this project doesn't operate, endorse, or support them, given none of the three are owned by this project?
4. Is there a risk that showing the "have an app" / "need one" choice (§4.1) to an operator who already started this flow once (e.g., a previous attempt with an app they've forgotten about) causes confusion? Should `probe()`'s existing state be checked for a partially-set `DISCORD_OAUTH_CLIENT_ID` and skip straight to the form pre-filled, rather than asking the branch question at all in that case?
