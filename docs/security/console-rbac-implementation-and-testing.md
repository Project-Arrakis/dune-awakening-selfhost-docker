# Console RBAC — Unified Tier Model Implementation & Testing Plan

**Status:** Design/implementation-and-testing plan. **Not yet implemented.**
**Authorized:** 2026-08-06 (user-directed workstream: implement across all repos
except this one; for this repo, produce this document first).
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
    (issue #135) is enabled. Raising the stakes of role gating (console access)
    makes flipping this to mandatory a Phase-4 prerequisite.
- Tests: `console/api` uses `node --test` (`npm test` in `console/api`);
  `console/web` uses Vitest (`npm test` in `console/web`).

## 3. Target architecture

### 3.1 Identity & login

- **"Sign in with Discord"** becomes the primary console login, reusing the
  bot's `setupServer.js` OAuth pattern (authorization-code flow, state
  validation, token exchange, `identify guilds` scopes).
- The resulting console session carries an identity:
  `{ id, userId, username, guildId, tier, csrf, expiresAt }`.
- **The existing `ADMIN_PASSWORD` login is preserved as the owner-tier
  bootstrap credential** (Strict Requirement 0 — see §6). When Discord OAuth
  is not configured, the console must behave exactly as it does today.
- Non-Discord bootstrap/recovery beyond the admin password (break-glass code,
  TOTP, etc.) is an open design item (§10) — carried over from the operator's
  "every RBAC decision needs a non-Discord path" requirement.

### 3.2 Home guild link

- A **designated home guild** is configured during setup (one Discord guild
  whose role assignments govern console RBAC).
- New optional config: `discord.homeGuildId`. **Unset ⇒ console unchanged**
  (password login, owner-tier everything) — no operator breakage, no new
  required env vars.

### 3.3 Role resolution — explicit decision point

Discord OAuth `identify guilds` proves *who* the user is but does **not**
reveal their guild roles. Deriving tiers from home-guild roles requires one of:

| Mechanism | Standalone (no ACP bot)? | Scope/verification cost | Notes |
|---|---|---|---|
| A. Console-side minimal Discord gateway (GuildMembers intent) | Yes | Needs `SERVER MEMBERS INTENT` enabled on the console's own Discord app (fine for <100-guild self-hosted apps) | Closest to "home guild's roles govern"; new long-running connection in console |
| B. Bot relay (bot resolves tier, hands it to console via signed adapter call) | No — requires the ACP bot deployed | None new (reuses actor signature) | Only works for operators who run the bot; contradicts standalone-op priority |
| C. `guilds.members.read` OAuth scope | Yes | **Restricted scope — requires Discord app verification**, unrealistic for most self-hosters | Non-starter for the general operator base |
| D. Manual user-ID → tier table in console settings | Yes | None (OAuth `identify` only proves identity; admin assigns tiers) | Simplest standalone path; no automatic role sync; tier changes are manual |

**Recommendation for v1:** mechanism **D** (identity = Discord OAuth; tier =
operator-configured user→tier table seeded by the owner) with mechanism **A**
as a documented enhancement for automatic guild-role sync. **This contradicts
the operator's stated "home guild roles govern" preference only on the
mechanism, not the outcome** — flag for design review before Phase 2
implementation (§10, open question 1).

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
   resolves tier per §3.3, creates session).
4. New `/api/auth/me`: `{ user: {id, username, tier}, capabilities: [...] }`
   for the UI.
5. Config: optional `discord.oauth.*`, `discord.homeGuildId`, and the
   role-resolution config for the chosen mechanism (§3.3 decision).
6. Migration path: no required new env vars; password login always available
   (owner tier) — Strict Requirement 0.

### Phase 3 — Route & panel gating

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

### Phase 4 — Trust hardening

1. Make actor-signature verification (issue #135) **mandatory by default**
   for Discord-adapter actor claims (console RBAC raises the blast radius of
   forged actors).
2. Home-guild config integrity: HMAC-signed/locally-owned config field;
   reject role claims for guilds other than the configured home guild.
3. Login rate limiting on `/api/auth/login` and the OAuth callback (extend
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
  produces tiered sessions; `/api/auth/me` returns tier+capabilities;
  all §8.1/§8.2/§8.5 tests green.
- Phase 3: parity test enforces full 161-route coverage; authorization
  matrix test green; UI gating matches server truth (bypass test green).
- Phase 4: actor signature mandatory; rate limits + CSRF verified;
  §8.4 green.
- Final: full `console/api` + `console/web` suites green; changelog +
  docs current; no operator-facing behavior change without Discord OAuth.

## 10. Open questions (design review items)

1. **Role-resolution mechanism** (§3.3): D (manual user→tier table) vs A
   (console gateway, home-guild auto-sync). Operator preference was
   home-guild-role governance; D is the only scope-free standalone path —
   needs explicit sign-off.
2. Player login: do players get console accounts (read-only tabs) at all,
   or is the player tier bot-side only for v1?
3. Non-Discord bootstrap beyond admin password (break-glass code / TOTP).
4. Persisted vs in-memory sessions if multi-user scale emerges.

## 11. References

- `console/api/src/auth.js`, `console/api/src/server.js`,
  `console/web/src/App.tsx` (current state, §2).
- `console/api/src/integrations/discord/policy.js` (tier/capability pattern).
- `arrakis-control-panel/src/rbac.js` (bot-side unified tier model, landed
  in `4a2993d`).
- `docs/security/login-rate-limit-defense.md`, `docs/security/audit-2026-07-04.md`
  (existing security baselines to extend).
- Issue #135 (actor signature — Phase 4 prerequisite).
