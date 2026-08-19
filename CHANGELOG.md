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

- Base Inventory tab (Bases panel, Storage group only) gains full container
  management: Give Item, Give Multiple Items (batched into one server-side
  transaction), Fill Container, Delete Selected (multi-select), and Delete
  All (issue #347). Backed by three new `duneDb.js` functions
  (`giveMultipleItemsToStorage`, `deleteMultipleBaseContainerItems`,
  `deleteAllBaseContainerItems`) plus a parity fix: `giveItemToStorage` now
  enforces the same volume cap `fillItemToStorage` already did (previously
  give-item checked only slot count, never volume). Three new, narrow RBAC
  actions — `bases:give-item`, `bases:fill-item`, `bases:bulk-delete-items`
  (renamed from `bases:delete-items`, issue #351 — see the follow-up entry
  below) — follow the existing `bases:delete-item` precedent (own action,
  not folded into `bases:mutate`, so an operator's existing policy grant is
  never silently widened); default access is unchanged (owner `*`, admin
  `bases:*`). Scoped to Storage-group containers only — Refining/Crafting
  remain read-only, and the two new bulk-delete functions re-verify
  ownership through the same claim-CTE `deleteBaseContainerItem` already
  uses (not the unscoped `actor_id`-only lookup `giveItemToStorage`/
  `fillItemToStorage` use), so neither can reach a Refining/Crafting
  inventory. `Developer_StorageContainer_Placeable` is deliberately not
  special-cased — it was already in the Storage group's allowlist and is
  already grantable to a player via Players → Building Sets → "Show
  Experimental" → `Developer_Storage_Container_Patent`; a dedicated test
  locks in that no future change silently carves it out. UI carries the
  same "not visible in-game until the Survival server restarts" warning
  the standalone Storage tab's own note already gives (INC-2026-07-31-001) —
  the engine only claims new `dune.items` rows at server startup. The
  Vehicles → Inventory side of this feature is tracked separately as issue
  #348 (net-new UI surface, no existing tab to extend, split out to keep
  this PR reviewable as one coherent increment).
- Base Inventory tab (Storage-group containers and their contents overlay)
  now shows a real-time **Volume Used** figure alongside Slots Used, at the
  tab-wide totals level, on each container's own card, in the contents
  overlay summary, and per-inventory when a container backs more than one
  (issue #356). Column-probed the same way `positionIndex`/`qualityLevel`
  already are: a schema without `dune.inventories.max_item_volume` or
  `dune.items.volume_override` degrades to `0`/`0` and the row is withheld
  entirely (card/overlay) or shown as "—" (tab totals) rather than a
  misleading `0%`. `currentVolume` sums `volume_override` per inventory,
  which already stores each stack's TOTAL volume (per-unit × quantity),
  matching exactly what `giveItemToStorage`/`fillItemToStorage`'s own
  capacity checks enforce -- so the displayed total always agrees with what
  the next give/fill against that container will actually allow. This was
  the chosen fix for a real accuracy gap found during PR #349's own Layer 3
  audit: items given via the storage give-item route before it started
  recording `volume_override` (or given directly by the game engine)
  permanently carry a `NULL` there, which every `sum(volume_override)` query
  already treats as `0` -- so a pre-existing container's real volume usage
  was silently invisible. A one-time backfill script that would `UPDATE`
  every operator's live `dune.items` rows on their next pull was considered
  and rejected as disproportionate risk (Strict Requirement 0/26) for a
  LOW-MEDIUM accuracy gap in a capacity message, not a data-integrity or
  security issue; surfacing the real, current total directly was judged the
  lower-risk fix.
- Base container **Delete Selected**/**Delete All** (issue #347) now resolve
  and verify a whole batch with a fixed, small number of set-based
  round-trips instead of one pair of round-trips per item -- found during
  PR #349's own Layer 3 audit (issue #352, HIGH severity, DBA + Security
  hats independently): the original version's per-item loop (a
  `select ... for update`, the irreducible `dune.delete_item(bigint)` call,
  an `exists` check, a conditional fallback `delete`) cost ~4 round-trips
  per item -- worst case ~800 sequential statements for a 200-item batch,
  all while the container's inventory row lock was held for the entire
  duration, blocking any concurrent give/fill/delete against the *same*
  container for that whole window. A new shared helper,
  `finishDeletingLockedItems()`, now verifies and cleans up the whole batch
  in one set-based pair of statements after the `dune.delete_item` loop
  (itself irreducible, since it is a shipped, single-argument procedure) --
  round-trips drop from ~4N to ~N+2. Each `removed[]` entry from both bulk
  functions now also carries the same audit-detail fields
  `deleteBaseContainerItem`'s own `destroyedState` does --
  `positionIndex`/`qualityLevel`/`currentDurability`/`maxDurability`, via a
  new shared `auditDetailSelectFragment()` helper -- so a bulk-destroyed
  pristine legendary no longer logs identically to a bulk-destroyed broken
  common of the same template in the admin audit trail (issue #350).
- **`bases:delete-items` renamed to `bases:bulk-delete-items`** (issue #351,
  security-labeled, found during PR #349's own Layer 3 audit, Architect
  hat). `policy.js`'s `matchAction()` supports a `"prefix-*"` wildcard style
  where `"bases:delete-item*"` matches any action starting with that
  string -- including the old `bases:delete-items`, since it shared that
  exact string prefix with `bases:delete-item`. A hand-authored policy using
  that wildcard style near `bases:delete-item` (e.g. intending "just
  delete-item, with room to grow") would have silently and non-obviously
  also granted bulk/delete-all destruction, defeating the whole point of
  keeping the two as separate actions. STRIDE: Elevation of Privilege
  (latent -- no shipped default policy used this wildcard style against
  this action pair, so this was never exploitable against any policy this
  project ships; the rename closes the gap before any operator's
  hand-authored policy could hit it). `bases:bulk-delete-items` shares no
  string prefix with `bases:delete-item`, so no `-*` wildcard pattern can
  match both. This action was still unreleased when the rename happened, so
  it is a zero-migration-impact rename, not a breaking change for any
  operator's existing policy.
- Raw resources are now a fillable/giveable item category. `FILLABLE_GROUPS`
  in `adminCatalog.js` gains `raw_resource` alongside the existing
  `refined_resource`/`component`. 19 items in `runtime/data/admin-items.json`
  tagged with `group: "raw_resource"` and real volumes verified item-by-item
  against `dune.gaming.tools` (not category-guessed): `AzuriteOre`,
  `BauxiteOre`, `Basalt`, `DolomiteRock`, `ErythriteCrystal`, `FlourSand`,
  `JasmiumCrystal`, `MagnetiteOre`, `PlantFiber`, `SaguaroResourceRaw`,
  `ScrapMetal`, `SpiceResidue`, `SpiceSand`, `Stone`, `T6ResourceA`,
  `T6ResourceB`, `Corpse`, `Oil`, `Mouse_Corpse`. Same catalog review also
  found and corrected 5 previously-untagged items that are actually
  **components**, not raw resources — `T6ArmorPlating`, `T6RangeFinder`,
  `T6RayAmplifier`, `T6PowerRegulator`, `T6HydraulicPiston` — confirmed
  against each item's real in-game crafting recipe (all five are crafted at
  an Advanced Survival Fabricator, none are gathered). `WormTooth`,
  `WeldingMaterial3`, and `WeldingMaterial5` were investigated but
  deliberately left untagged: no volume data exists for any of the three
  on the reference source used, and issue #145 (pre-existing, separate)
  already documents this repo's policy against tagging a volume
  speculatively.
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

### Fixed

- **`resolveOwnedStorageContainer()` (the shared ownership/lock query behind
  Base Inventory's Delete Selected, Delete All, Give, Give Multiple, and
  Fill) was completely broken against a real PostgreSQL database from the
  moment it was introduced (issue #347, fixed as issue #353).** It combined
  `SELECT DISTINCT` with `FOR UPDATE OF inv` in the same query, which
  Postgres flatly rejects (`FOR UPDATE is not allowed with DISTINCT
  clause`) — every real call to any of those five actions would have 500'd
  in production. This was invisible to every mocked unit test in
  `db.test.js`, since the fake `db.query()` those tests use pattern-matches
  query *text* and never actually parses or executes SQL — a syntactically
  invalid query and a valid one sharing the same substrings are
  indistinguishable to that style of test. It was found only once a real
  HTTP-level integration test exercised these routes against a real,
  isolated PostgreSQL database instead of a mock (`baseContainerMutationRoutes.
  integration.test.js`, added for issue #353, which itself was filed during
  PR #349's own Layer 3 audit specifically because this class of gap — no
  real end-to-end test of these 5 routes — was recognized as a real risk
  before this exact bug was known to exist). Fixed by resolving the
  `DISTINCT` candidate set in its own CTE first, then joining back to the
  real `dune.inventories` row purely to take the lock — `FOR UPDATE` only
  ever applies to that final, non-`DISTINCT` join, which Postgres allows.
  10 new real-HTTP integration tests (spawning the actual `server.js`
  against an isolated database, following `bridgeActionDispatch.test.js`'s
  existing precedent) now cover all 5 routes end-to-end; confirmed each
  fails against the pre-fix query and passes against the fix by reverting
  and re-running directly. This was never released -- issue #347/#349's
  entire feature was unreleased and unmerged when this was found and fixed
  in the same branch, so there is no affected shipped version and no
  upgrade/migration concern.
- `fakeBulkContainerDeleteDb`'s ownership-query mock matcher in `db.test.js`
  (issue #354, MEDIUM severity, found during PR #349's own Layer 3 audit,
  QA hat) was anchored on the bare substrings `"requested_claims"` and
  `"for update of inv"` -- both shared with other queries/comments
  elsewhere in `duneDb.js`, so a future addition containing both fragments
  together could have silently been treated as `resolveOwnedStorageContainer`'s
  own query by this mock, producing an incorrect-but-passing green test for
  an unrelated code path. Never actually produced a false positive, but
  re-anchored on the query's real, structurally unique final `SELECT`
  column list (`"select c.placeable_id::text as placeable_id, c.inventory_id"`)
  to close the latent fragility, consistent with how the sibling single-item-
  lookup matcher in the same file already anchors on a full column-list
  string rather than a short clause fragment.
- Added frontend test coverage for a partial-batch Give Multiple Items
  failure (issue #355, LOW severity, found during PR #349's own Layer 3
  audit, QA hat). The existing "batches several distinct items into one
  give-items call" test in `BaseInventoryTab.test.tsx` only ever mocked
  `basesApi.giveContainerItems` to resolve successfully, so there was no
  coverage for what the UI does when the backend batch call fails partway
  through -- the exact scenario `giveMultipleItemsToStorage` is designed to
  produce (an error like `"...stopped before giving item N; N-1 of M items
  were already given"`). The error already propagated correctly through
  the same `onError`/`deleteError` wiring proven for a different mutation
  (bulk-delete) elsewhere in this same file -- this was a coverage gap, not
  a functional bug -- but the new test locks in that the backend's real
  partial-success count reaches the operator verbatim, in both the
  `onError` side channel and the modal's own inline error text, and that a
  failed batch is not silently cleared (so the operator does not have to
  re-enter every item to retry).
- **Base Inventory tab's Give/Fill actions never reject a request just
  because it would exceed the container's remaining volume** (issue #347,
  found and specified during manual UI review, per explicit operator
  direction). `giveItemToStorage`, `fillItemToStorage`, and
  `giveMultipleItemsToStorage` previously threw `"Storage is full by
  volume"` and inserted nothing at all when a requested quantity did not
  fully fit -- forcing an operator to guess a smaller number and retry. All
  three now **clamp the requested quantity down to whatever actually
  fits** and insert that instead: asking for 500 of an item with room for
  only 375 gives 375, not 0. Every response reports `requested`/`given`/
  `clamped` so the UI can say exactly what happened
  (`"Only 375 of the requested 500 x X fit and was given to the
  container."`) rather than silently implying the full request succeeded.
  Slot count is the one capacity axis this does not apply to -- a single
  give/fill always consumes exactly one slot regardless of quantity, so
  "no slots left" genuinely cannot be partially satisfied and remains a
  hard rejection; volume itself is still a hard rejection only in the one
  case clamping cannot help, truly zero room left. `giveMultipleItemsToStorage`'s
  batch behavior changed the same way, but stops the batch (left-to-right,
  not best-effort) once one item does not fully fit rather than skipping
  ahead to try later, possibly-smaller items -- and, like the single-item
  functions, no longer throws on hitting a capacity limit at all: it
  returns `ok: true` with a `results` array, one entry per requested item
  (`requested`/`given`/`clamped`/`attempted`/`reason`), including items
  never reached because an earlier one already stopped the batch
  (`attempted: false`). This is a real backend contract change -- an
  earlier version relied on the whole transaction rolling back to prove no
  partial inserts happened on a thrown error; the current version has no
  rollback to reason about, because hitting a capacity limit is no longer
  an error condition.
- **Fill now offers two distinct, explicitly labeled actions -- "Fill
  Amount" and "Fill to Capacity" -- instead of one quantity field with a
  hidden meaning** (issue #347, found during manual UI review).
  `fillItemToStorage`'s `quantity: 0` sentinel ("insert as much as fits in
  whatever volume remains, in one call") already existed and was already
  used internally, but was unreachable from any UI: both this tab's own
  quantity field and the standalone Storage tab's clamp to a minimum of 1,
  so the sentinel could never actually be sent. "Fill to Capacity" sends
  it explicitly and reports the real inserted count
  (`"4,200 x SteelBar was filled into the container (as much as fit)."`);
  "Fill Amount" sends whatever the operator typed (subject to the same
  clamp-and-inform behavior described above).
- **Give/Fill now use a compact type-to-search item picker
  (`ItemCatalogCombobox`, `console/web/src/components/common/ItemCatalog.tsx`)
  instead of a raw "item name or ID" text field** (issue #347, found during
  manual UI review). The original plain text input required already
  knowing the exact template id or exact in-game name, offered no way to
  discover what is actually in the catalog, and did not filter anything as
  the operator typed. The new combobox is a lighter, single-input sibling
  to the existing `ItemCatalogSelector` (the full-page category/grid
  browser used by Player Give Items, too heavy to stack two-of inside the
  already-dense Base Inventory contents modal) -- same underlying catalog
  data, same real in-game display name (e.g. "Fuel Cell" for template id
  "Oil"). Search and the results list are name-only: the catalog id is a
  backend concept the operator never needs to see or type, and Give/Fill
  both submit the selected item's real `itemId` under the hood regardless.
  The Fill combobox additionally filters its results to `FILLABLE_GROUPS`
  client-side, matching the server's own `resolveFillableCatalogItem()`
  check, so the picker never even offers an item the server would reject.
- **An empty Storage container's "View Contents" button in the Containers
  card view is now always present and clickable** (issue #347, found
  during manual UI review). The button previously did not render at all
  when a container had zero items -- rendering bare "Empty" text with no
  click target instead -- making an empty container permanently
  unreachable through that card, which is exactly the container an
  operator most needs to open (to Give/Fill something into it in the first
  place). Only the trailing label now switches between the distinct-item
  count and "Empty"; the button itself is unconditional.

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
