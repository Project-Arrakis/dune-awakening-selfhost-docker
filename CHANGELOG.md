# Changelog

This is a fork of [Red-Blink/dune-awakening-selfhost-docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker).
Version numbers (`v1.3.65`, etc., see `VERSION`) are owned by upstream,
not this fork — this file tracks this fork's own merged work on top of
whatever upstream version is currently checked out, per the versioning
convention documented in this account's operating docs. Entries are in
Keep a Changelog style, grouped by upstream base version, newest first.

## Unreleased (on top of upstream v1.3.79+)

### Added

- `dune db backup-system` (#269) — one-command, encrypted system backup
  covering `.env`, `runtime/generated/`, `runtime/secrets/`, and a fresh
  database dump, bundled into a single `dune-system-*.tar.gz.enc` archive
  (with a `.yaml` sidecar that itself contains no secrets, safe to read on
  its own). Every credential is retained verbatim — the Funcom Self-Host
  Service Token, admin console password, RMQ admin credentials, and the
  sietch join password are all included, not redacted or excluded — the
  archive's only protection is the passphrase supplied when it's created,
  encrypted with AES-256-CBC + PBKDF2 (600,000 iterations). Prompts for a
  passphrase interactively (entered twice, to catch typos); set
  `DUNE_SYSTEM_BACKUP_PASSPHRASE` for non-interactive/cron use. There is no
  way to recover an archive without its passphrase. `dune db list-system`
  lists written archives. No automated restore yet — decrypt with
  `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in <archive> -pass
  pass:YOUR_PASSPHRASE | gunzip | tar -xf -`, restore
  `.env`/`runtime/generated/`/`runtime/secrets/` manually, then
  `dune db restore` for the `db/` dump inside.
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

### Fixed
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
