# Changelog

This is a fork of [Red-Blink/dune-awakening-selfhost-docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker).
Version numbers (`v1.3.65`, etc., see `VERSION`) are owned by upstream,
not this fork — this file tracks this fork's own merged work on top of
whatever upstream version is currently checked out, per the versioning
convention documented in this account's operating docs. Entries are in
Keep a Changelog style, grouped by upstream base version, newest first.

## Unreleased (on top of upstream v1.3.88)

### Changed

- Merged `upstream/main` into this fork's `main` (issue #279), resolving 198
  commits of divergence and 23 real file conflicts (auth/policy/RBAC/Discord
  adapter surface). Notable outcomes:
  - Adopted upstream's opaque session-cookie design (`auth.js`) in place of
    this fork's own cookie-embedded-tier design. The fork's design allowed a
    signature-valid cookie whose session had no matching in-memory entry to
    be "resurrected" with the tier/identity embedded in the cookie itself --
    confirmed exploitable (anyone holding `sessionSecret` could forge an
    arbitrary-tier, including owner, session for an id that was never issued)
    and confirmed to defeat session revocation entirely (a tier downgrade or
    password rotation had no effect, since any Map eviction re-synthesized
    the original tier from the cookie). See CRITICAL issue #309.
  - Adopted upstream's `policy.js` (validated policy documents, atomic
    persistence to `runtime/generated/iam-policies.json`, an explicit
    owner-lockout guard on `settings:write`) in place of this fork's version,
    which had none of the three and could not actually persist a policy
    change across a restart.
  - Adopted upstream's path-traversal fix in `httpSafety.js`'s
    `safeStaticTarget()` (real `path.relative()` containment check; the
    fork's own string-prefix check silently broke static asset serving on
    Windows and could be tricked by a sibling directory sharing a prefix).
  - Found and fixed 4 Discord adapter routes (`ANNOUNCEMENTS`, `MAINTENANCE`,
    `LOGS`, `MAP_STATE`) that had no authorization capability check at all in
    this fork -- upstream's independent implementation of the same routes
    correctly gates all four. See issue #315.
  - Kept this fork's own `duneDb.js` container-health implementation
    (`addonOpsContainerHealth()`) over upstream's `services/containerHealth.js`
    -- confirmed via live testing (issue #246) that `docker stats` has no
    `--filter` flag; upstream's version passes one anyway and does not work.
  - Kept this fork's own self-scoped-capability design
    (`SELF_SCOPED_CAPABILITIES`/`requireSelfScopedCapability()` in
    `integrations/discord/policy.js`, FINDING-LINK-2) -- upstream has no
    equivalent fix and still tier-gates `PLAYER_LINK_WRITE`.
  - Corrected a merge-introduced bug where `OPS_*` Discord capabilities were
    initially added to the `moderator` tier following the surrounding
    `*_READ` pattern, before upstream's own test
    (`discordPolicy.test.js`, "OPS capabilities are granted only to admin and
    owner tiers") caught that this is deliberately admin/owner only.
  - All 23 conflicts resolved with real test verification at each step
    (1312/1313 `console/api` tests passing -- the 1 failure is a
    known-good local-`HEAD`-vs-working-tree artifact of the merge being
    uncommitted at test time, not a real regression; full `console/web`
    TypeScript build + Vite bundle succeeds).

### Added

- Two new addon-bridge test suites closing a real, previously-untested gap
  (#308): `console/api/test/bridgeActionContract.test.js` asserts every
  `ops.*` addon-bridge action's real handler function (called directly, no
  HTTP) returns a response shape carrying its own unique discriminator field
  and none of the other actions' — the exact class of dispatcher-wiring bug
  (e.g. an `if`-chain reordering) that could silently route one action's real
  call to a different action's response shape without a hard crash.
  `console/api/test/bridgeActionDispatch.test.js` spawns the real
  `src/server.js` and asserts every documented `ops.*` action responds 200
  over the actual HTTP bridge route individually — this is the test that
  would have caught the real 2026-08-10 `containerHealth` incident (a missing
  `if (` causing a hard `SyntaxError` at module-import time), confirmed by
  directly reproducing that exact syntax error against current code and
  observing this new test fail with a clear, isolated signal instead of the
  original incident's opaque, unrelated-looking timeout. Both tests are
  complementary, not redundant — verified each independently by intentionally
  breaking the corresponding defect class and confirming a real failure, then
  restoring.
- Two new addon-bridge actions, `ops.health.postgres` and `ops.health.rabbitmq`
  (`addonOpsPostgresHealth()`/`addonOpsRabbitmqHealth()` in `duneDb.js`), for
  the `dune-ops-observability` addon's per-container metrics grid rebuild
  (addon repo issue #133). Both are pure PromQL reads against the
  already-deployed, already-scraped `dune-postgres-exporter`/
  `rabbitmq_prometheus`-plugin metrics (part of the existing opt-in
  `dune metrics start` stack — no new container, exporter, port, or secret).
  Queries are lifted directly from `runtime/metrics/rules/postgres.yml`'s and
  `rabbitmq.yml`'s own alert expressions, not invented separately, so a UI
  number and an Alertmanager warning always describe the identical
  underlying query. `promScalar()` gained an injectable `fetchImpl` parameter
  (defaults to the real `fetch`) and a new sibling `promVector()` for
  naturally per-instance queries (RabbitMQ's two brokers) — both exported
  for direct unit testing without a live Prometheus instance.
- Discord OAuth as primary sign-in method on the login page. Password login is
  available as a secondary, collapsible option when OAuth is configured.
- Local static file mount (`runtime/local-static` → `/app/web-dist/atrium`)
  so operators can serve custom pages from the console domain. Directory
  is gitignored — content is per-deployment and never pushed upstream.
- Atrium page access control: the `/atrium/` path requires a valid session
  and checks `ATRIUM_ALLOWED_USER_ID` against the session's Discord user ID.
  Unauthorized users see a friendly access-denied page.
- `POST /api/auth/discord/exchange` endpoint — accepts a Discord Bearer
  access token, validates it, and returns a console session cookie + CSRF.
  Used by the Atrium page for single-auth flow. Optional user-ID gate via
  `ATRIUM_ALLOWED_DISCORD_USER_ID` env var.
- Static file server now resolves directory paths to `index.html`
  (`/atrium/` → `/atrium/index.html`).
- RBAC Phase 3 — signed handoff tier resolution (Mechanism B, #135). The console
  can now resolve a Discord user's effective tier for the configured home guild
  by calling the ACP bot's `resolve-console-tier` endpoint and verifying the
  HMAC-signed response. No unsigned tier claim can produce a tiered session.
  New module: `console/api/src/integrations/discord/handoff.js`. New config keys
  in `.env.example`: `DISCORD_BOT_HANDOFF_SECRET`, `DISCORD_BOT_HANDOFF_URL`.
- When the handoff is not configured (no secret, no URL, or no home guild), the
  OAuth callback falls back to Phase 2's owner-bootstrap gates — zero new
  required config, no operator breakage (Strict Requirement 0).
- RBAC Phase 4 — route & panel capability gating. Server-side `rbac.js` enforces
  tier-based access on every API route (160+ entries, exact + regex patterns);
  `/api/auth/me` returns per-tier capabilities. Client-side `App.tsx` filters
  navGroup tabs by capability (UX only — server remains authoritative). 40
  unit tests covering tier ladder, capability sets, fail-closed session
  resolution, route pattern matching, and tier-appropriate gating.
- `GET /api/integrations/discord/catalog` — Discord command catalog endpoint,
  Phase 1 of the automated command-discovery design
  (`docs/rfc-command-discovery.md`, issue #337). Returns a machine-readable
  catalog (names, descriptions, capabilities, minimum role tier, param shape)
  for every live Discord adapter route, composed from the existing
  `DISCORD_LIVE_ADAPTER_ROUTES`/`DISCORD_CAPABILITIES` tables rather than a
  second hand-maintained copy. `buildCommandCatalog()` asserts full,
  bidirectional coverage against the live-route list and throws on drift —
  intended to replace the bot repo's (`arrakis-control-panel`) manually
  reconciled route classification, which has required five separate
  corrections to date. Bearer-token auth only, matching `/health` (read-only
  route metadata, not game or player data). `/health` also gains a new
  `protocolVersion` field for future version-negotiation. New
  `policy.js` export: `minTierForCapability()`, so this and any future
  consumer can derive a capability's minimum tier from the real
  `CAPABILITY_BY_TIER` table instead of hand-maintaining a parallel one.
  Phases 2-4 (bot-side generator, bot runtime consumption, dynamic
  refresh/autocomplete) are separate, future work — not included here.

### Security

- Cherry-picked upstream `3ca8c4c` ("fix(backups): preserve env ownership during scheduled
  tasks", upstream v1.3.67) — `.env` is no longer silently rewritten as root-owned when
  a systemd timer triggers Compose project-name resolution. Existing non-root-owned `.env`
  files now have their ownership preserved (`chown --reference`) before the atomic `mv`
  replacement, and when the project name is already correct the function is a no-op
  (no file write at all). Documented as INC-2026-07-27-001.
- Session cookies now carry the user's tier and ID in the HMAC-signed payload. When
  the console restarts and in-memory sessions are lost, the synthesized session
  preserves the original tier instead of defaulting to owner (#157). Legacy cookies
  (pre-RBAC or plain session-id format) continue to synthesize as owner — backward
  compatible per Requirement 0.
- Session cookies (`asc_session`) and OAuth state cookies (`discord_oauth_state`) always
  include the `Secure` flag by default. Operators running the console locally over plain
  HTTP can set `ADMIN_SECURE_COOKIES=0` in `.env` to opt out.
- **Grafana admin password is now auto-generated on first `dune metrics start`/`restart`, replacing the static, checked-in `admin`/`admin` default** (#307). `GF_SECURITY_ADMIN_PASSWORD` previously had no generation mechanism at all, unlike every other cross-process secret in this repo (RMQ, alert-relay token, FLS API key all use `openssl rand -hex`). New `ensure_grafana_password()` in `runtime/scripts/metrics-stack.sh` mirrors the existing `ensure_alert_relay_token()` pattern exactly: `openssl rand -hex 16` on first use, written to `runtime/secrets/grafana-admin-password.txt` with `chmod 600`, exported as `METRICS_GRAFANA_PASSWORD` so Docker Compose's existing `${METRICS_GRAFANA_PASSWORD:-admin}` fallback picks up the real value transparently — no `docker-compose.metrics.yml` change needed. Idempotent (`[ ! -s "$password_file" ]` guard): an existing deployment's next `dune metrics start`/`restart` gets a real password generated silently, with zero risk of locking out an operator who already changed it manually (their existing `.env`-set `METRICS_GRAFANA_PASSWORD`, if any, still wins per Docker Compose's own env-var precedence). 5 new tests in `tests/metrics-stack-unit.sh`, mirroring the existing alert-relay-token test block exactly (auto-provision, mode 600, correct byte length, not the literal string `"admin"`, and idempotency across a second `start`).

### Fixed
- **Every raw `docker run`-managed container now carries an explicit `com.docker.compose.project` label** (#246). `dune-postgres`, `dune-rmq-admin`, `dune-rmq-game`, `dune-director`, `dune-text-router`, and every `dune-server-*` game instance are started by this repo's own orchestration scripts (`start-postgres.sh`, `start-rabbitmq.sh`, `start-director.sh`, `start-text-router.sh`, `start-server-gateway.sh`, `start-server-overmap.sh`, `start-server-survival-1.sh`, `spawn-server.sh`), not `docker-compose.*.yml` — so they previously had no Compose project label at all (`dune-postgres` had the *wrong* one, `postgres`, inherited from an unrelated Compose invocation on the same host). This made them invisible to any bridge action scoped by that label, including `ops.health.containers` (#240/#244) — an operator or addon querying per-container health would see only the Compose-managed side-services (console, metrics stack), never the actual game server, database, or message broker containers, with no indication anything was missing. Every affected script now passes `--label "com.docker.compose.project=${DUNE_COMPOSE_PROJECT_NAME}"` (already resolved and exported by `runtime-env.sh`, which every one of these scripts already sources). Zero-risk on upgrade: every script already `docker rm -f`s and recreates its container on every start, so the label takes effect the next time each container naturally restarts — no separate migration step, no change to any running container until then. New static test `runtime/tests/test-container-compose-labels.sh`, wired into CI, verifies every raw-`docker run` container's invocation carries this label.
- **Broadcast enabled via env var** (#214). `discordWritesEnabled()` now checks `DUNE_DISCORD_WRITES_ENABLED=1` instead of hardcoding `false`.
- **LOGS / MAP_STATE / MAINTENANCE routes now have real handlers** (#211, #213). Three adapter routes caused 8 bot slash commands to 404. LOGS tails container logs; MAP_STATE returns per-map status; MAINTENANCE runs `dune ready`.
- **Backups + Announcements wired to real data** (#212). `/dune data backups` now runs `dune db list`. `/dune ops announcements` reads from `services/playerAnnouncements.js`. Both previously returned empty stub arrays.
- **Backups + Announcements wired to real data** (#212). `/dune data backups` now runs `dune db list`. `/dune ops announcements` reads from `services/playerAnnouncements.js`. Both previously returned empty stub arrays.

- Item display names in `playerInventory`, `playerOwnedStorageQuery`, `guildStorageQuery`,
  `searchItemsInContainers`, and `searchItemsInPlayerInventory` now resolve against the
  `adminItemMetadata()` catalog instead of showing raw `template_id`s. Added shared
  `enrichWithDisplayName()` helper. Fixed `ContainerVehicle` name conflict with
  `admin-vehicle.json` preferring `admin-items.json`'s display name.
- Storage and item-find embeds now match Core's actual response payload shape
  (`{grouped, rows, count}`) instead of the never-implemented `{groups, matches}` contract.
  Added `containersAsGroups()` helper for container rows.
- Building types (Sub-Fief Console, Small Storage Container, Fabricator, etc.) now resolve
  to real display names via `adminBuildingMetadata()`/`resolveBuildingDisplayName()` instead
  of raw `building_type` IDs. Catalog individually verified against `dune.gaming.tools`.
- Non-storage placeables (Water Shipper Door, Blood Purifier) no longer appear in container
  listings — added `EXISTS (select 1 from dune.inventories...)` filter to
  `playerOwnedStorageQuery()` and `guildStorageQuery()`.
- Fixed `verify/characters/unlink` routes: repointed from the never-existent
  `player-links-*` routes to Core's real `players/link/verify`, `players/accounts/list`, and
  `players/accounts/unlink`. Removed broken `playerLinks()`/`playerUnlinkV2()`.
- Phase-one 1:1 linking constraint: `linkPlayerProvider()` and `linkAdditionalAccount()`
  reject linking a second character to the same Discord account with a lore-styled error
  message.
- Same-character re-link short-circuit: re-linking an already-linked character is now an
  immediate no-op (`{ok: true, alreadyLinked: true}`) with no whisper, no Steam OAuth
  round-trip, and no rejection at the end of a pointless flow.
- `players-accounts-list` and `players-accounts-unlink` added to `config.js`'s runtime
  `paths`/`methods` object and `UPSTREAM_CONTRACT` — previously added to
  `DEFAULT_PATHS`/`DEFAULT_METHODS` but never to the runtime object (same class of gap as
  the `players-link-verify` bug).
- `formatLinkEmbed` now checks `payload.alreadyLinked` first, showing an "Already Linked"
  message with Core's verbatim lore text instead of the generic "Character Linked" embed.

### Added

- Engine reverse-engineering deliverable (issue #148, Phases 1-4): `docs/engine/command-catalog.md`
  now maps the full Funcom engine admin-command surface (all 861 compiled-in
  command names, classified by domain; regenerable via
  `docs/engine/generate-command-catalog.py`). Phase 2 verified the FLS
  ServerCommand channel is a narrow allowlist (26 live probes rejected "unknown Server
  Command"; positive-control KickPlayer dispatch proved the probe path) — the 855-command
  `UDuneServerCommandsCheatManager` cheat-exec table is not reachable over FLS, so no
  engine-native container-fill command exists. Phase 3 documents the complete FLS
  transport contract (rabbitmq exchange `heartbeats`/routing `notifications`,
  `fls_backend` identity, two-hop base64 envelope, per-command parameter contracts).
  Phase 4 scoped console features to the verified surface (11 of the 13 FLS-VERIFIED
  commands exposed in the console UI) and filed #149 for the one gap worth a console
  action (engine-native `ServiceBroadcast` restart-warning is CLI-only today;
  `SpecializationXP` is already covered by the console's `specialization-max` DB path).
- Atrium console Storage tab: new "Apply Fills (Restart Survival)" action that restarts the
  survival game server via the existing `POST /api/server/restart-service` endpoint after a
  danger-styled confirmation dialog warning that all connected players will be disconnected.
  Container fill rows inserted into `dune.items` are claimed by the game engine only on
  server startup — proven via the `dune.item_audit_log` audit trigger (bulk claim bursts at
  2026-07-31 04:40:52Z and 05:01:44Z, both startup reads; a live leave-and-return test
  showed no engine claim on actor respawn). Documented as INC-2026-07-31-001.
- `POST /api/storage/{storageId}/fill-item` endpoint: fills a container (placeable storage
  or container vehicle) with refined resources or components, respecting both item-slot
  and volume limits. Restricted to items classified as `refined_resource` or `component`
  in `admin-items.json`. Sets `volume_override` on inserted items. Added `fillItemToStorage()`
  in `duneDb.js`, `resolveFillableCatalogItem()`/`resolveItemVolume()` in `adminCatalog.js`.
- Extended `GET /api/storage` to include container vehicles (from `dune.vehicles` +
  `dune.actors`) alongside placeable storage buildings. Each row now has a `type` field
  (`"placeable"` or `"vehicle"`).
- Added `group` and `volume` fields to 75 items in `runtime/data/admin-items.json`
  (21 refined resources, 54 components) for use by the fill-item endpoint.
- Console RBAC Phase 2 (issue #151): optional Discord OAuth sign-in for the
  Web Console. New `GET /api/auth/discord/start` + `/api/auth/discord/callback`
  routes, `/api/auth/me` identity endpoint, tiered sessions
  (`owner`/`admin`/`moderator`/`player`) on the existing HMAC session cookie,
  and a Discord sign-in button on the login screen when configured. Fully
  opt-in — with no `DISCORD_OAUTH_*`/`DISCORD_HOME_GUILD_ID` env vars set,
  the console behaves exactly as before (password sign-in, single owner
  session). Owner-tier bootstrap is fail-closed: requires
  `DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP=1`, home-guild membership, and the
  user's snowflake in `DISCORD_OAUTH_OWNER_ALLOWLIST`; an empty allowlist
  denies all Discord owner sessions, with the admin password remaining the
  owner fallback. `DISCORD_OAUTH_CLIENT_SECRET` may live in
  `runtime/secrets/discord-oauth-client-secret.txt` (never auto-created).
  Implemented behind the plan in
  `docs/security/console-rbac-implementation-and-testing.md` (Phase 2 of 5);
  role-mapped tiers await Phase 3's signed bot handoff (#135).

### Fixed
- **Broadcast enabled via env var** (#214). `discordWritesEnabled()` now checks `DUNE_DISCORD_WRITES_ENABLED=1` instead of hardcoding `false`.
- **LOGS / MAP_STATE / MAINTENANCE routes now have real handlers** (#211, #213). Three adapter routes caused 8 bot slash commands to 404. LOGS tails container logs; MAP_STATE returns per-map status; MAINTENANCE runs `dune ready`.
- **Backups + Announcements wired to real data** (#212). `/dune data backups` now runs `dune db list`. `/dune ops announcements` reads from `services/playerAnnouncements.js`. Both previously returned empty stub arrays.
- **Backups + Announcements wired to real data** (#212). `/dune data backups` now runs `dune db list`. `/dune ops announcements` reads from `services/playerAnnouncements.js`. Both previously returned empty stub arrays.

- Adopted upstream's revert of a Compose `name:` pin that this fork had
  added and upstream correctly reverted: hardcoding a project name
  would have silently orphaned existing operators' game/database
  volumes on their next update if their install directory wasn't named
  exactly `dune-awakening-selfhost-docker` (#126, adopting upstream
  `443152d`).
- Adopted upstream's fix for a gitleaks configuration regression this
  fork had introduced: pointing `--config` at `.gitleaks.toml` without
  `[extend] useDefault = true` silently replaced gitleaks' entire
  built-in detection ruleset with just this repo's allowlist, disabling
  real secret detection on that CI scan path. Verified first-hand with
  a synthetic AWS-key-format test before and after the fix (#126,
  adopting upstream `1bbc3b6`, which also adds a permanent regression
  test guarding against this exact class of bug recurring).
- Fixed `tests/security-pr-checks.sh`'s gitleaks changed-file scan
  never loading this repo's own `.gitleaks.toml` allowlist at all (it
  was resolving relative to a throwaway staging directory, not the
  real repo root), causing false-positive blocks on legitimate,
  already-allowlisted content (#108).
- Fixed `console/web`'s container-status-line parsing
  (`isHomeStopComplete`, `hasRestartStopSignal`, `hasRestartStartSignal`,
  `isHomeStartComplete`) silently failing to match `docker ps`-style
  output padded with multiple spaces/tabs between the container name
  and its status (#108).

### Documentation

- Added `docs/incidents/INC-2026-07-31-FILL-ITEMS-VISIBLE-ONLY-AFTER-RESTART.md`
  documenting the investigation proving that fill-item rows inserted into `dune.items`
  for container inventories are claimed by the game engine only on server startup
  (audit-trigger burst evidence plus a live leave-and-return test with no engine claim),
  and the "Apply Fills (Restart Survival)" console action that makes the required
  restart explicit. Documented as INC-2026-07-31-001. Relates to the prior row-shape
  fixes (`be5081a`, `65dd632`, `c5c486f`), which were confirmed not to resolve in-game
  visibility on their own.
- Revised `docs/security/audit-2026-07-04.md` following direct,
  detailed technical review from the upstream maintainer. Corrected
  several severity ratings that had conflated verified vulnerabilities
  with privileged architecture, defense-in-depth opportunities, and
  hypothetical post-compromise impact; corrected specific factual
  claims (this codebase does not have a session-fixation
  vulnerability, the Funcom token file is already `0600` not `0644`,
  the self-update helper does not use Docker's `--privileged` flag,
  CSRF-on-GET is not a vulnerability here since no GET route mutates
  state); added exact reviewed commit SHAs and an explicit
  classification (verified / architectural risk / defense-in-depth /
  already remediated) to every finding (#125).
- Corrected `docs/security/generated-command-auth-token.md`, which
  described a generated-token architecture as currently active when
  it was in fact reverted by the upstream maintainer on 2026-07-07 —
  added a prominent status banner stating the actual current state
  and why the generated-token approach was reverted, rather than
  leaving a stale document that could mislead a future contributor
  into reintroducing the same regression (#125).

## v1.3.65 (upstream base, this fork's `main` as of this changelog's creation)

Everything prior to this changelog's creation is upstream `Red-Blink`
history plus this fork's own accumulated feature work (Discord OPS
route wiring, Spice Melange resource-summary rework, Steam-link
character linking on the bot side, the SteamCMD CDN outage incident
report, and others) — not individually itemized here since this file
did not exist yet to capture them as they happened. See `git log` and
the PRs referenced in `docs/security/`, `docs/discord-integration/`,
and `docs/incidents/` for that history.
