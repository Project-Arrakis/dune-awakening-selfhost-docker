# Console RBAC — Unified Tier Model Implementation & Testing Plan

**Status:** Design/implementation-and-testing plan. **Mechanism decision made
(2026-08-06): B — bot relay via signed handoff.** Phase 2-4 shipped 2026-08-06/07.
**IAM migration shipped 2026-08-07** — 18 coarse capabilities replaced with
~130 fine-grained actions in an AWS IAM-style policy engine (`policy.js`,
`actions.js`). In-console policy editor UI (`IamPolicyEditor.tsx`) under
Access Control in the Server Control tab. See implementation files:
`console/api/src/actions.js`, `console/api/src/policy.js`,
`console/web/src/features/settings/IamPolicyEditor.tsx`.
**Cross-repo companion work already landed:** `arrakis-control-panel` commit
`4a2993d` (unified-RBAC Phase 1: multi-tenant `isCommandAllowed()`/`isAdminActor()`
now honor owner/moderator tiers; `canWrite()` resolves tiers from `guild_roles`;
setup wizard enrolls all four tiers; `player` is the user-facing label for the
DB `observer` tier).

---

## 1. Context

The console web UI (`console/web`) and its API (`console/api`) currently have
**no role model at all**: a single shared admin password (`ADMIN_PASSWORD`)
authenticates every request, and every authenticated session has identical
capabilities. Discord-role tiers exist *only* inside the Discord adapter
(`console/api/src/integrations/discord/policy.js`), which governs bot-originated
adapter requests, not console users.

The unified four-tier model agreed with the operator:

```
player (== "observer" internally)  <  moderator  <  admin  <  owner
```

must gate **areas of the console** (tabs/routes) and, on the bot side, **Discord
slash commands** (bot-side gating landed in Phase 1, see above). This document is
the implementation and testing contract for the Core-side work (Phases 2-4).

## 2. Verified current state (2026-08-06, checked against the repo)

- `console/api/src/auth.js`
  - In-memory `Map` sessions (line 3) — single-process, lost on restart.
  - `createSession()` (line 35) stores `{ id, csrf, expiresAt }` — **no user
    identity, no role**.
  - Cookie `asc_session` is HMAC-signed (base64url, `sessionSecret`) — lines
    26-28; `HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` (lines 79-84).
  - `requireAuth()` (lines 61-73): 401 on missing/expired session, 403 on CSRF
    mismatch; slides expiry to +12h (line 50).
- `console/api/src/server.js`
  - One flat request dispatcher: **161 route-branch conditions**
    (`path === "/api/…"` / `path.startsWith("/api/…")`) starting at line 263.
  - The single global auth gate wraps `/api/` (line 96): `requireAuth` +
    CSRF for all state-changing requests. No per-route differentiation.
  - Public (unauthenticated) routes: `/api/health`, `/api/auth/state`,
    `/api/auth/login`, `/api/auth/logout`, `/api/setup/*`,
    `/api/public-directory/status` (+ static web assets).
- `console/web/src/App.tsx`
  - `navGroups` (line 101): **16 tabs** across 3 groups (Server Operations:
    Home, Server Control, Backups, Database, Updates, Logs, Settings;
    Arrakis Management: Maps, Players, Guilds, Bases, Live Map, Landsraad,
    Admin Tools, Care Package; Community: Addons).
  - No per-tab authorization; tab visibility is static.
- `console/api/src/integrations/discord/policy.js`
  - `DISCORD_ROLE_TIERS = ["public","observer","moderator","admin","owner"]`
    (line 1), `CAPABILITY_BY_TIER` (line 58), `discordActorTier`/
    `discordActorCan`/`requireDiscordCapability` (lines 119-137) — the proven
    shape to mirror for console capability sets.
   - Trust gap (known, documented): actor identity/roles from the bot are an
     unauthenticated request-body claim unless the opt-in HMAC actor signature
     (issue #135) is enabled. **Under the operator-approved mechanism B, this
     signature stops being optional for console tier claims — it becomes the
     transport for them (Phase 3).**
- Tests: `console/api` uses `node --test` (`npm test` in `console/api`);
  `console/web` uses Vitest (`npm test` in `console/web`).

## 3. Target architecture

### 3.1 Identity & login

- **"Sign in with Discord"** becomes the primary console login, reusing the
  bot's `setupServer.js` OAuth pattern (authorization-code flow, state
  validation, token exchange, `identify guilds` scope).
- The resulting console session carries an identity:
  `{ id, userId, username, guildId, tier, csrf, expiresAt }`.
- **The existing `ADMIN_PASSWORD` login is preserved as the owner-tier
  bootstrap credential** (Strict Requirement 0 — see §6) — **and as the
  explicit fallback when Discord has not been configured or is unavailable**
  (§3.4).
- Non-Discord bootstrap/recovery beyond the admin password (break-glass code,
  TOTP, etc.) remains an open design item (§10).

### 3.2 Home guild link & initial role setup

- A **designated home guild** is chosen during the console's initial setup.
- During that setup (operator-driven "Sign in with Discord"), the operator
  **picks the Discord roles** that map to **admin**, **moderator**, and
  **player** (owner = the operator/guild owner by their relationship to the
  home guild). Those mappings are **written to the shared `guild_roles`
  registry** the ACP bot already governs (bot-side DB, four `role_type`
  rows: `owner`/`admin`/`moderator`/`observer`), so **the bot's slash-command
  RBAC and the console's console RBAC stay in sync by construction** — there
  is exactly one source of truth, not two.
- The bot's own existing setup wizard keeps operating on that same registry;
  console setup may write it (via the signed adapter handoff, below) to
  backfill/confirm the mapping when the bot is already deployed.
- Config (all optional, see §5): `discord.homeGuildId`,
  `discord.botHandoff.*` (adapter location + secret). **Unset ⇒ console
  behaves exactly as today** — no operator breakage.

### 3.3 Role resolution — explicit decision (2026-08-06, operator-approved)

- **Decision: the ACP bot performs the role check on behalf of the console,
  and the result is delivered as a signed handoff.**
- **Initial setup:** the console OAuth login window lets the operator pick the
  Discord roles for admin/moderator/player of the designated home guild —
  creating/updating the shared `guild_roles` registry in the bot's DB. This
  is the only write path for role mapping; runtime logins never write.
- **Future console logins:** an OAuth login identity is fetched
  (`/users/@me`); then the console asks the bot to resolve the user's
  effective tier for the home guild using the shared registry. The
  handoff (user-id, guild-id, tier, timestamp.) is **HMAC-signed with the
  shared handoff secret (issue #135 actor-signature pattern)** and verified
  before a tiered session is created. **Unauthenticated identity/tier claims
  are never accepted.**
- **No console DB change:** the console stays `config.json`/env-based. Role
  storage keeps living in the bot's `guild_roles` registry; the console only
  reads it through the signed handoff. Consequence: when RBAC is enabled, a
  tiered login depends on the bot being reachable — which is exactly why the
  fallback (below) is the default until the handoff is configured.
- **Fallback (explicit operator requirement, revised by issue #401 /
  `docs/rfc-console-auth.md` §2.1):** if Discord OAuth has NOT been
  established (no home guild configured, no handoff secret), the console
  **falls back to today's behavior: a single full-access user authenticated
  by `ADMIN_PASSWORD` (+ the owner tier), no RBAC tiers, everything
  permitted.** The fallback is the *default*; RBAC only activates once the
  mapping+handoff are standing. **Once the handoff IS configured, its answer
  is authoritative: a bot outage or handoff failure denies new Discord
  sign-ins rather than reverting to any fallback** (already-active sessions
  are unaffected; password sign-in is always available). A half-configured
  handoff (some but not all of secret/URL/guild set, or an unusable URL)
  disables Discord sign-in entirely with a boot warning naming the problem
  -- it does not silently degrade to the owner-bootstrap allowlist.
- Mechanism table (for the record, all were considered):

| Mechanism | Decision | Notes |
|---|---|---|
| A. Console-side Discord gateway (GuildMembers intent) | Rejected for v1 | New long-lived connection into the console; SERVER MEMBERS INTENT — disproportionate complexity vs. reusing the bot |
| **B. Bot relay, signed handoff** | **SELECTED** | The console delegates role resolution to the ACP bot via a signed handoff; one shared `guild_roles` source of truth for both bot slash-commands and console access |
| C. `guilds.members.read` OAuth scope | Rejected | Restricted scope requiring a verified Discord application — unrealistic for self-hosters |
| D. Manual user-ID → tier table | Rejected | Operator wants guild-role-governed access; a manual per-user table diverges from the shared role registry |

Because the signed handoff is the mechanism, actor-signature verification
(issue #135) stops being a "Phase-4 hardening" item and becomes a **Phase-3
prerequisite** for any tiered console login — see §4.

### 3.4 Console capability catalog

New `console/api/src/rbac.js` mirrors `policy.js`:

- `TIER_RANK = { observer: 0, moderator: 1, admin: 2, owner: 3 }`
- `CONSOLE_CAPABILITIES` and `CAPABILITY_BY_TIER` (server-side single source
  of truth; the UI only mirrors it).
- `resolveSessionTier(session)` (fail closed: no session/no tier ⇒ deny),
  `requireConsoleCapability(req, res, capability)`.

Proposed default capability assignments (subject to design review):

| Console area | Capability | Minimum tier |
|---|---|---|
| Home / status | `STATUS_READ` | player |
| Maps / Players / Guilds / Bases / Live Map / Landsraad (read) | `WORLD_READ` | player |
| Logs | `LOGS_READ` | admin |
| Backups (list/download) | `BACKUPS_READ` | admin |
| Backups (create/restore) | `BACKUPS_WRITE` | owner |
| Database (query tool) | `DATABASE_READ` | admin |
| Database (mutation) | `DATABASE_WRITE` | owner |
| Updates (status) | `UPDATES_READ` | admin |
| Updates (trigger) | `UPDATES_WRITE` | owner |
| Server Control (start/stop/restart/config) | `SERVER_CONTROL_WRITE` | owner |
| Settings | `SETTINGS_WRITE` | owner |
| Addons (list/status) | `ADDONS_READ` | admin |
| Addons (install/manage) | `ADDONS_WRITE` | owner |
| Admin Tools | `ADMIN_TOOLS` | owner |
| Care Package (grant) | `CARE_PACKAGE_GRANT` | owner |
| Discord/actor-signed admin endpoints | `ADMIN_READ`/`ADMIN_WRITE` | admin/owner |

Every one of the 161 route branches maps to exactly one capability (or is
explicitly public); a **parity test** (§8.1) mechanically enforces coverage.

## 4. Implementation plan (phases, each independently reviewable)

### Phase 2 — Console identity & sessions

1. `console/api/src/integrations/discord/oauth.js` (new): state storage,
   authorize-URL builder, token exchange, `/users/@me` fetch, user-ID claim.
2. `auth.js`: session object gains `userId/username/guildId/tier`; keep the
   HMAC cookie format (backward compatible — old cookies remain valid and
   default to the password login's owner tier).
3. Login routes: `/api/auth/login` keeps password path (→ owner tier);
   new `/api/auth/discord/start|callback` (OAuth; callback validates state,
   exchanges token, fetches identity, and — once Phase 3 ships — resolves
   tier via the signed handoff; **until then the callback may only produce
   an owner-tier session if the operator explicitly permits it**).
   Owner-tier gating is fail-closed: the user must be a member of
   `discord.homeGuildId` **and** be named in `discord.oauth.ownerAllowlist`,
   with `discord.oauth.allowOwnerBootstrap` set. An **empty allowlist denies
   every Discord owner session** — it never means "any guild member is
   owner" (implemented and pinned in `oauth.js:resolveBootstrapTier`;
   an empty-allowlist grant would hand a Docker-socket admin to any guild
   member, including future joiners).
4. New `/api/auth/me`: `{ user: {id, username, tier, guildId}, capabilities: [...] }`
   for the UI. The Web Console login screen shows a Discord sign-in link
   only when `discord.oauth.configured` is true; the OAuth `/callback`
   success response is a small HTML autoredirect page (`window.location.replace("/")`)
   because a real browser lands on that URL after the Discord round-trip
   (returning JSON would show the user a data blob).
5. Config: optional `discord.oauth.*`, `discord.homeGuildId`,
   `discord.botHandoff.*`. All optional — unset ⇒ console unchanged (§5).
6. Migration path: no required new env vars; password login always available
   (owner tier) — Strict Requirement 0.

### Phase 3 — Signed role handoff (mechanism B Cohort; issue #135 prerequisite)

1. **Actor/role-handoff signature made production**: implement the shared-HMAC
   handoff between the bot and console (issue #135 shape): the bot signs
   `{user-id, guild-id, tier, ts}` with the shared secret; the console
   verifies before trusting any tier claim. **No tiered session may be created
   from an unsigned claim.** (Supersedes the old "hardening" framing — this is
   now the mechanism, not an optional hardening step.)
2. **Bot side (arrakis-control-panel)**: expose two signed adapter endpoints:
   - `resolve-console-tier` (given userId + guildId, return effective
     `role_type` tier from the shared `guild_roles` registry); and
   - `set-role-mapping` (admin-only; writes the admin/moderator/player
     Discord-role → tier rows into `guild_roles`).
3. **Console setup flow**: operator "Sign in with Discord" → picks admin/
   moderator/player roles for the home guild → console writes the mapping to
   the bot via the signed `set-role-mapping` handoff (backfilling the bot's
   registry if not already set). This is the one and only runtime write path
   for role mappings.
4. OAuth callback now resolves tier by calling `resolve-role-tier` and
   verifying the signature before storing a tiered session; fail-closed
   (no verified handoff ⇒ no tiered session; fallback per §3.3).
5. Fallback job: whenever the handoff is **unconfigured** (no home guild or
   no handoff secret/URL set at all), the console serves exactly today's
   single-admin full-access model. **Revised by issue #401: "bot
   unreachable" is no longer a fallback condition** -- with a configured
   handoff, an unreachable bot denies new Discord sign-ins (recorded as
   `auth.handoff-denied` with a reason code in the audit log); the static
   owner-bootstrap allowlist applies only to installs that never configured
   a handoff. Operators who configure the handoff should prune
   `DISCORD_OAUTH_OWNER_ALLOWLIST` down to the minimum intended
   first-owner-bootstrap set: each entry is a standing owner credential
   that becomes live again if the handoff configuration is ever removed.

### Phase 4 — Route & panel gating

1. `console/api/src/rbac.js` + `ROUTE_CAPABILITIES` map (161 entries; public
   route list explicit).
2. Dispatcher change in `server.js`: after the existing global gate, apply
   `requireConsoleCapability(session, routeCapability)` per branch via the
   map (small, mechanical diff; no route behavior change for owner-tier
   sessions).
3. `App.tsx`: `navGroups` entries gain `requiredCapability`; sidebar and
   in-app navigation hide tabs the session lacks; `/api/auth/me` drives it.
   Client gating is UX only — server remains authoritative (tests prove it).
4. No player-facing API design change: the bot's existing adapter surface
   already carries its own tier model via `policy.js`.

### Phase 5 — Trust hardening

1. Home-guild config integrity: HMAC-signed/locally-owned config field;
   reject role claims for guilds other than the configured home guild
   (defense-in-depth on top of the signed handoff).
2. Login rate limiting on `/api/auth/login` and the OAuth callback (extend
   `login-rate-limit-defense.md`'s existing mechanism); CSRF stays for all
   mutations; sessions invalidated on tier downgrade if that capability is
   added.

## 5. Data/config changes

- **No new database.** The console persists operator config via `config.json`/
  env (its current model). Sessions stay in-memory for v1 (documented
  limitation: logout-on-restart, single-process — same as today); persisted
  sessions are an open item only if multi-user scale demands it.
- New optional config keys (§4 Phase 2 step 5); all optional.
- Bot side (already landed): no schema change — `guild_roles.role_type`
  already allowed all four tiers.

## 6. Strict Requirement 0 — upgrade path for existing operators

- Fresh install and upgrade must behave identically until Discord OAuth is
  configured: `ADMIN_PASSWORD` → owner tier, full access, zero config work.
- New config keys are optional; no required env vars added; no removed or
  renamed keys.
- Old `asc_session` cookies remain valid after upgrade (same format; default
  owner tier).
- **Changelog entry per phase** (repo `CHANGELOG.md`, Keep a Changelog
  format) stating exactly what's optional vs. required.

## 7. Security posture & non-Discord fallback

- Threat model (STRIDE) to be formally documented in the design review:
  spoofing (OAuth state, actor signature), tampering (CSRF, signed cookie),
  repudiation (audit log entries get `tier`), information disclosure
  (per-tier read exposure), DoS (login rate limits), elevation of privilege
  (tier mapping is server-side and fail-closed).
- **Fallback mandate:** every RBAC decision the console makes must have a
  non-Discord path — the admin-password owner bootstrap satisfies this for
  v1; break-glass recovery codes are an open item (§10).
- Secrets introduced by OAuth: `discord.clientSecret` — stored with the
  existing `runtime/secrets/` convention, never committed.

## 8. Testing strategy

### 8.1 Unit tests — `console/api` (`node --test`)

- `rbac.test.js`: tier ladder, capability sets, `resolveSessionTier`
  fail-closed cases (missing session, unknown tier, expired), exact
  `CAPABILITY_BY_TIER` mapping vs. the table in §3.4.
- `auth.test.js`: cookie HMAC tamper rejection, expiry, CSRF mismatch,
  legacy cookie → default owner tier (upgrade path).
- `oauth.test.js`: state validation (missing/stale/reused state),
  token-exchange failure paths, `/users/@me` malformed payloads (fixtures).
- **Dispatcher parity test** (the load-bearing gate): statically parse
  `server.js` and assert `ROUTE_CAPABILITIES` + the public-route list cover
  every branch — a new route without a capability assignment fails CI.
  (Same technique as the repo's existing route/help reconciliation tests.)

Phase 2 shipped tests (2026-08-06): `test/oauth.test.js` covers pending
state (missing/stale/reused, cookie-bound, full store), token exchange
(invalid code / upstream error / unreachable host / malformed payload),
identity fetch (fail-closed on malformed user or failed guilds), bootstrap
tier fail-closed gates, allowlist parsing, and the authorize-URL contract.
`test/oauthRoutes.integration.test.js` boots the real `server.js` against
a local fake Discord API on ephemeral ports and exercises the full
browser-shaped flow: `/api/auth/state` advertises `discordOAuthConfigured`,
`/start` 302s to Discord and sets the pending-state cookie, `/callback`
mints a session and returns the HTML autoredirect page, `/api/auth/me`
returns the tiered identity; plus a 403 for a non-home-guild member and a
404 when OAuth is unconfigured.

### 8.2 Integration tests — `console/api`

- Boot the server with a test config; for **every** route branch × session
  type (unauthenticated, player, moderator, admin, owner, expired) assert
  the exact status (401/403/200). This is the authorization matrix that
  proves the parity map is enforced, not just declared.
- Login flows: password→owner; OAuth happy path (mocked Discord HTTP via
  fetch stub) → tier resolution per §3.3 mechanism; OAuth failure paths
  (denied, invalid code, state mismatch).
- CSRF enforcement on all mutating routes for each tier.

### 8.3 UI tests — `console/web` (Vitest)

- `App.test.tsx`: for each `navGroups` entry, mock `/api/auth/me` per tier
  and assert tab visibility (player sees Home/Maps/…; never Server Control).
- **Direct-tab-bypass test:** a player session requesting an owner tab's
  data through the API client still receives 403 (server-side enforcement;
  the UI hiding is not the control).

### 8.4 Security tests

- Direct API calls bypassing the UI: player session → owner-only route
  (e.g. `/api/server/restart`) → 403 — the phase-3 acceptance proof.
- Actor-signature negative tests (Phase 4): forged/absent signature →
  request rejected even when body claims owner.
- Session fixation, expiry, cookie flags, login rate limit.

### 8.5 Upgrade-path tests

- Fresh install (pre-RBAC and post-RBAC states).
- Upgrade from a pre-RBAC build: existing `config.json`, `ADMIN_PASSWORD`
  login, old session cookie → full owner access, no lockout.
- Discord OAuth configured mid-lifecycle: password login still works.

### 8.6 Governance / evidence

- Every phase updates `CHANGELOG.md`; the design review and any security
  findings land as labeled GitHub issues (severity/scanner/STRIDE taxonomy,
  see `docs/security/audit-2026-07-04.md` conventions).
- Doc-currency merge blocker (requirement 14): this document is updated in
  the same PR as any behavior change it describes.

## 9. Definition of done (per phase)

- Phase 2: password login unchanged for existing operators; OAuth login
  produces at least an owner-tier fallback session; `/api/auth/me` returns
  identity + current tier/capabilities; §8.1/§8.2/§8.5 tests green.
- Phase 3: signed handoff verifier + bot `resolve-role-tier`/
  `set-role-mapping` endpoints; OAuth callback only creates tiered sessions
  against verified handoffs; fallback semantics proven (unconfigured bot
  ⇒ password-only single-admin, full access).
- Phase 4: parity test enforces full 161-route coverage; authorization
  matrix test green; UI gating matches server truth (bypass test green).
- Phase 5: rate limits + CSRF verified; home-guild claim check enforced;
  §8.4 green.
- Final: full `console/api` + `console/web` suites green; changelog +
  docs current; no operator-facing behavior change without Discord OAuth
  being configured end-to-end.

## 10. Open questions (design review items)

1. **RESOLVED (2026-08-06):** role-resolution mechanism — **B, bot relay
   via signed handoff**, with one shared `guild_roles` mapping configured
   at console setup and reused by the bot for slash-command RBAC; fallback
   to today's single-admin full-access behavior whenever Discord is
   unavailable at setup or the handoff is unconfigured.
2. Player login: do players get console accounts (read-only tabs) at all,
   or is the player tier bot-side only for v1? (Player tier exists in the
   shared registry either way.)
3. Non-Discord bootstrap beyond admin password (break-glass code / TOTP).
4. Persisted vs in-memory sessions if multi-user scale emerges.
5. Handoff secret distribution: shared secret vs. per-install key
   exchange (issue #135 shaping conversation) — consent deferred to
   Phase 3 design.

## 11. References

- `console/api/src/auth.js`, `console/api/src/server.js`,
  `console/web/src/App.tsx` (current state, §2).
- `console/api/src/integrations/discord/policy.js` (tier/capability pattern).
- `arrakis-control-panel/src/rbac.js` (bot-side unified tier model, landed
  in `4a2993d`).

### IAM Implementation (Phase A, 2026-08-07)
- `console/api/src/actions.js` — action catalog (~160 routes → action mapping, 19 namespaces)
- `console/api/src/policy.js` — IAM policy engine (Deny > Allow > default Deny, wildcard matching)
- `console/web/src/features/settings/IamPolicyEditor.tsx` — in-console policy editor (JSON + visual builder + test panel)
- `runtime/generated/iam-policies.json` — on-disk policy documents (gitignored, auto-created at startup)
- `test/rbacParity.test.js` — static parity test verifying every route has an action

### Secrets Management (Phase 1 designed, 2026-08-07)
- `docs/security/secrets-management.md` — full analysis: PKI, CMK, storage, retrieval, rotation
- Proposed: age-based secret vault replacing plaintext `runtime/secrets/*.txt` files
- Proposed: `console/api/src/secrets.js` — in-memory secret cache with age decryption
- Proposed: `scripts/secrets.sh` — CLI wrapper for age: init, get, set, rotate, list
- Proposed: `SecretsManager.tsx` UI (Phase 2) — in-console editor under Access Control

- `docs/security/login-rate-limit-defense.md`, `docs/security/audit-2026-07-04.md`
  (existing security baselines to extend).
- Issue #135 (actor signature — Phase 4 prerequisite).
