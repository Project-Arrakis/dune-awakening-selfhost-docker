# Upstream PR Proposal: Console RBAC, Discord OAuth, and Operator Tools

**Date:** 2026-08-08
**Base:** Red-Blink/dune-awakening-selfhost-docker v1.3.84
**Fork:** yacketrj/dune-awakening-selfhost-docker
**Author:** Ron Yacketta
**Status:** Draft — for upstream review/approval

---

## Executive Summary

This proposal delivers **console IAM (RBAC)**, **Discord OAuth sign-in**, and
**operator tooling** to the upstream self-hosted Docker console. The work has
been running in production on a live game server since July 2026, serving real
players. It is proposed as seven independently-reviewable tranches, each
self-contained with tests, documentation, and a strict "does not break existing
deployments" guarantee.

**Scale:** 140 commits, 89 files, ~18,100 insertions across a tree that has
grown ~200 internal commits on this fork since the base. The seven tranches
factor this history so no single PR exceeds ~400 lines or changes more than
10 files.

**Risk to operators:** Each tranche is additive or guarded by feature flags.
Tranche 1 (IAM engine) has no user-visible effect until Tranche 3 (IAM editor)
is merged. Tranche 2 (Discord OAuth) is opt-in via `DISCORD_OAUTH_CLIENT_ID`
— if the env var is absent, the console behaves identically to the current
upstream build. No migration, no forced config change, no breaking schema
change for any existing operator.

---

## Architecture — Dependency Tree

```
Tranche 1: RBAC Foundation (IAM engine, session tiers, route gating)
  │
  ├── Tranche 2: Discord OAuth Sign-in (depends on session management)
  │     ├── Tranche 4: Player Scoping (depends on Discord identity)
  │     ├── Tranche 5: Discord OPS Providers (depends on Discord routes)
  │     └── Tranche 6: OAuth Setup UI (depends on OAuth endpoints)
  │
  └── Tranche 3: IAM Policy Editor UI (depends on IAM engine)

Tranche 7: Fixes + Security Tooling (independent, can ship anytime)
```

Each arrow means "the downstream PR must not be reviewed before the upstream
PR is accepted." Tranche 7 is independent and can ship first or last.

---

## Tranche 1: RBAC Foundation (blocks all subsequent work)

### Why
The console currently has a single admin password with unrestricted access.
Any operator who shares the password grants full control — no tiered access,
no audit trail of who did what, no way to let moderators manage players
without also giving them server-stop permission. This tranche adds the IAM
engine, tiered sessions, and route-level capability gating that every
subsequent feature depends on.

### What it ships
| Component | Files | Description |
|-----------|-------|-------------|
| IAM policy engine | `policy.js`, `actions.js`, `rbac.js` | AWS IAM-style policy evaluation: allow/deny with action matching, namespace-aware. Route-to-action mapping for every existing console route. |
| Tiered sessions | `auth.js` | HMAC-signed session cookies carrying `{tier, userId, exp, iat}`. Password login defaults to `owner`. `readSession` decodes JSON-bundle payloads with legacy fallback. |
| Route gating | `server.js` | `evaluate(session, action)` gate on every authenticated route. Public routes (health, auth state, login/logout) bypass. |
| Session max age | `auth.js` | 7-day absolute max age via `iat` field. Prevents indefinite session use after a restart. |
| CSRF hardening | `auth.js` | Every POST/PUT/DELETE requires `X-CSRF-Token` matching the session. |
| Secure cookies | `auth.js`, `config.js` | `Secure` flag default-on with opt-out (`ADMIN_SECURE_COOKIES=0`). |
| Login rate limiting | `server.js`, `rateLimit.js` | Token-exchange rate limiting per remote IP. |

### Strict Requirement 0 compliance
- IAM engine is dormant until policies are created. No existing route is
  affected — the default policy set grants `owner` tier everything.
- `auth.js`'s `readSession` has an upgrade path: a signature-valid cookie
  from a pre-RBAC build produces a synthesized `owner` session. An operator
  upgrading mid-session does not get logged out.
- No new required env vars. `ADMIN_SECURE_COOKIES` defaults to `1` (matches
  current behavior — the console already expects HTTPS via reverse proxy).

### Test coverage
- `rbac.test.js`: policy evaluation (allow/deny, wildcards, precedence)
- `rbacParity.test.js`: static analysis — every route in `handleApi` has an
  IAM action or a documented public-route exemption
- `auth.test.js`: session creation, validation, expiry, legacy fallback
- `rateLimit.test.js`: rate limiter behavior

### Risk: Low
Blast radius: confined to the console API. No game-server, Postgres, or
Docker daemon impact. Feature-gated: no IAM policy → no behavioral change.

---

## Tranche 2: Discord OAuth Sign-in (depends on T1)

### Why
Password-based auth works for a single operator but does not scale to
multi-admin teams. Discord OAuth lets operators sign in with their existing
Discord account. Tier resolution (owner/admin/moderator/player) comes from
Discord guild roles, enabling tiered access without sharing a password.

### What it ships
| Component | Files | Description |
|-----------|-------|-------------|
| OAuth flow | `oauth.js`, `server.js`, `config.js` | Authorization-code flow with PKCE (S256). Single-use, cookie-bound, short-lived pending state. `/api/auth/discord/start` → `/api/auth/discord/callback` → `/api/auth/discord/exchange`. |
| Tier resolution | `oauth.js`, `handoff.js` | `resolveBootstrapTier`: guild membership + explicit allowlist → `owner`. `createHandoff`: signed HMAC payload from external bot for dynamic tier assignment (disabled by default). |
| Session creation | `auth.js`, `oauth.js` | OAuth callback creates a tiered session with `{userId, username, guildId}`. |
| Opt-in gate | `config.js` | `discordOAuthConfigured` is `false` unless `DISCORD_OAUTH_CLIENT_ID`, `DISCORD_OAUTH_CLIENT_SECRET`, and `DISCORD_OAUTH_REDIRECT_URI` are all set. Without these, the console behaves identically to the current upstream build. |

### Strict Requirement 0 compliance
- **Feature gate**: `discordOAuthConfigured` is `false` by default. No env
  vars set → no Discord sign-in button, no OAuth routes exposed, zero
  behavioral change for existing operators.
- **`secureCookies` backwards compat**: `config.js` reads
  `ADMIN_SECURE_COOKIES !== "0"` (opt-out, default `true`). Matches upstream
  behavior (console expects HTTPS via reverse proxy).
- **Legacy session upgrade**: pre-RBAC cookies with valid HMAC are upgraded
  to `owner`-tier sessions on read. No operator is logged out mid-upgrade.

### Test coverage
- `oauth.test.js`: PKCE state machine, tier resolution, Discord HTTP stubs
- `oauthRoutes.integration.test.js`: full OAuth flow with mocked Discord API
- `auth.test.js`: session tier propagation from OAuth callback
- `config.test.js`: `discordOAuthConfigured` gating

### Risk: Low
Opt-in, feature-gated, no default behavioral change. Client secret stored in
`runtime/secrets/` at `0o600`, never in `.env`.

---

## Tranche 3: IAM Policy Editor UI (depends on T1)

### Why
The IAM engine from Tranche 1 needs a UI for operators to create, edit, and
assign policies. Without this, the RBAC system is API-only and unusable by
non-technical operators.

### What it ships
| Component | Files | Description |
|-----------|-------|-------------|
| Policy editor | `IamPolicyEditor.tsx`, `styles.css` | Searchable permission grid grouped by namespace. Green checkboxes for granted actions, row dividers, accessible contrast. |
| API endpoints | `server.js` | `GET /api/settings/iam/policies`, `PUT /api/settings/iam/policy`, `POST /api/settings/iam/policy/test`. |
| Sidebar integration | `App.tsx` | IAM policy editor as a dedicated Settings tab. |
| Bugfixes | `IamPolicyEditor.tsx`, `styles.css` | HTTP-path→IAM-action resolution, infinite-render fix, duplicate Access Control removal, empty-namespace filtering. |

### Strict Requirement 0 compliance
- IAM editor is only accessible to `owner`-tier sessions. Other tiers see a
  "permission denied" message.
- Default policies grant `owner` everything. An operator who never opens the
  IAM editor sees no change.

### Test coverage
- `rbacParity.test.js`: static route coverage
- `rbac.test.js`: policy CRUD

### Risk: Medium
UI change — affects what operators see. Blast radius: one settings tab. No
backend behavioral change for non-IAM routes.

---

## Tranche 4: Player Scoping (depends on T2)

### Why
When a player-tier user signs in via Discord OAuth, they should only see
their own characters and data — not every player on the server. This tranche
adds row-level scoping to the players endpoint and Discord-to-character
linking infrastructure.

### What it ships
| Component | Files | Description |
|-----------|-------|-------------|
| Player character linking | `duneDb.js`, `server.js` | `getAllLinkedPlayers` (with legacy table UNION), `GET /api/auth/characters`, link/unlink handlers. |
| Player endpoint scoping | `duneDb.js`, `server.js` | `resolvePlayerScopedIds` helper, `controllerIds` SQL-level filter on `listPlayers`. |
| PlayerLinkPrompt | `PlayerLinkPrompt.tsx` | Home-tab prompt for unlinked player-tier users. |
| Expression indexes | `duneDb.js` | `text→bigint` JOIN indexes. |
| Stale link cleanup | `duneDb.js` | Startup cleanup of links to deleted characters. |
| Audit logging | `server.js`, `duneDb.js` | Dedicated audit entries for link/unlink operations. |
| Tier restriction | `rbac.js` | Moderator tier restricted (no `players:mutate` or `bases:mutate`). |

### Strict Requirement 0 compliance
- Player linking tables in a new `console` schema — no migration on the
  existing `dune` schema.
- `getAllLinkedPlayers` UNION includes the legacy `discord_player_links` table
  for operators who already had the adapter running.
- Player scoping only applies when `session.tier === "player"` and
  `session.userId` is set. Admin/mod/owner tiers see all players (unchanged).

### Test coverage
- `db.test.js`: getAllLinkedPlayers (3 test cases), expression indexes
- `server.js` (integration): scoped player list

### Risk: Medium
Schema addition (new `console` schema). No migration on existing data.

---

## Tranche 5: Discord OPS Providers (depends on T2)

### Why
The console's Discord integration (adapter) currently has placeholder OPS
routes that return stub data. This tranche wires them to real duneDb queries
so the Discord bot can report live server state.

### What it ships
| Component | Files | Description |
|-----------|-------|-------------|
| opsProvider wiring | `opsProvider.js`, `routes.js` | activity/combat/resources/economy providers wired to real `addonOps*` duneDb queries. |
| `totalValueRemaining` | `opsProvider.js` | Computed from `resourcefield_state` for bot statsPusher. |
| ops.inventory/soc/activity | `inventoryProvider.js`, `routes.js` | Real aggregate queries for inventory, SOC, and activity stats. |

### Strict Requirement 0 compliance
- OPS routes are only called by the Discord adapter. If the adapter is
  disabled (`DUNE_DISCORD_ADAPTER_ENABLED=false`, the default), these code
  paths are never reached.
- No new env vars beyond what the adapter already requires.

### Test coverage
- `opsProvider.test.js`: shape contracts for all providers
- `inventoryProvider.test.js`: aggregate query shapes
- `bridgeIntegration.test.js`: end-to-end route responses

### Risk: Low
Opt-in behind `DUNE_DISCORD_ADAPTER_ENABLED`. No default behavioral change.

---

## Tranche 6: OAuth Setup UI (depends on T2)

### Why
Operators currently must edit `.env` by hand to configure Discord OAuth —
error-prone, undocumented, and causes silent failures (missing env vars
produce misleading "not authorized" errors). This tranche adds a setup wizard
step and settings panel section for OAuth configuration.

### What it ships
| Component | Files | Description |
|-----------|-------|-------------|
| save-oauth-secret endpoint | `server.js` | Writes client secret to `runtime/secrets/discord-oauth-client-secret.txt` at `0o600`. Follows the existing `saveToken` pattern. |
| write-oauth-config endpoint | `server.js` | Writes non-secret OAuth keys to `.env` with server-side snowflake/URL/bootstrap validation. `DISCORD_OAUTH_BASE_URL` deliberately excluded (SSRF vector). |
| Setup wizard step | `SetupWizard.tsx` | Optional "Discord Auth" step with 5 fields + secret + skip button. Does not block progression. |
| Settings panel section | `SettingsPanel.tsx` | Collapsible Discord OAuth section for post-setup editing. |
| Self-validation | `config.js` | `discordOAuthConfigured` requires `homeGuildId`. Missing → OAuth shows as disabled, no broken sign-in flow. |
| Missing compose vars | `docker-compose.web.yml` | Added `DISCORD_HOME_GUILD_ID` and `DISCORD_OAUTH_OWNER_ALLOWLIST` passthrough. |

### Strict Requirement 0 compliance
- `discordOAuthConfigured` is `false` by default. Missing env vars → OAuth
  shows as "not configured" — the password login works normally.
- Client secret never touches `.env` (stored in `runtime/secrets/` at `0o600`).
- Setup wizard step is optional — operators can skip it entirely.

### Test coverage
- E2E validation: snowflake/URL/bootstrap input rejection verified via curl
  (test file pending per #192's QA hat requirements).
- Parity test: both new routes have `setup:write` IAM actions.

### Risk: Medium
Writing to `.env` from the web UI. Mitigation: strict server-side validation,
audit logging, and secret isolation to `runtime/secrets/`.

---

## Tranche 7: Fixes + Security Tooling (independent)

### Why
Security scanning, operational fixes, and documentation that apply across
all tranches. These can ship independently at any time.

### What it ships
| Component | Files | Description |
|-----------|-------|-------------|
| gitleaks allowlist | `.gitleaks.toml` | Verified placeholder values unblocking pre-push gates. |
| Semgrep CI | `.github/workflows/semgrep.yml`, `.semgrepignore` | Full ruleset + Supply Chain, diff-aware on PRs. |
| ggshield migration | `.gitguardian.yaml` | v2 config format. |
| Dune WAN probe | `.github/workflows/dune-wan-probe.yml` | Optional WAN-probe workflow. |
| Documentation | `CHANGELOG.md`, `docs/security/*`, `docs/incidents/*` | Changelog, security audits, incident reports, data classification. |
| Storage fixes | `StoragePanel.tsx`, `adminCatalog.js` | Storage loading state, error styling, volume/slot limits, fill-item endpoint. |
| Sietch display names | `runtime/data/sietch-config.json` engine | Resolves real sietch names from config. |

### Risk: Low
Security tooling is CI-only. Storage fixes are bugfixes on existing features.
Documentation is additive.

---

## How to Review

1. **Start with Tranche 1** — it is the foundation. Without it, subsequent
   tranches cannot function.
2. **Each PR passes independently**: clone upstream v1.3.84, apply the PR,
   run `docker compose up`, and verify the console works normally.
3. **Feature gates are explicit**: if you don't want Discord OAuth, skip
   Tranches 2, 4, 5, and 6. Tranche 1 (IAM) and Tranche 3 (IAM UI) work
   standalone.
4. **Tests are load-bearing**: the parity test (`rbacParity.test.js`)
   mechanically enforces that every new route has an IAM action. The OAuth
   tests (`oauth.test.js`, `oauthRoutes.integration.test.js`) verify the full
   PKCE flow with mocked Discord APIs.
5. **Evidence is in the fork**: every PR links to its issue tracker entry
   (`yacketrj/dune-awakening-selfhost-docker/issues/NNN`) with eight-hats
   review, risk classification, and test plan.

---

## CI Status on Fork

All tranches currently pass on the fork's `main` branch:
- 872 console API tests (node `--test`)
- TypeScript compilation (console web)
- Semgrep CI (full ruleset, cron-triggered)
- gitleaks / ggshield / trivy pre-push gates

## Contact

Questions, concerns, or design discussions: open an issue on
`yacketrj/dune-awakening-selfhost-docker` or reach out via the
Discord server linked in the fork's README.
