# Changelog

This is a fork of [Red-Blink/dune-awakening-selfhost-docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker).
Version numbers (`v1.3.65`, etc., see `VERSION`) are owned by upstream,
not this fork — this file tracks this fork's own merged work on top of
whatever upstream version is currently checked out, per the versioning
convention documented in this account's operating docs. Entries are in
Keep a Changelog style, grouped by upstream base version, newest first.

## Unreleased (on top of upstream v1.3.95)

### Added

- **Suppressed two unfixed `libsqlite3-0` CVEs blocking `trivy-image-scan`**
  (issue #498). `CVE-2026-11822` and `CVE-2026-11824` were published between
  `main`'s last green run and the next PR, failing the required `Release gate`
  on every open and future PR. Debian has published no fix for either, so
  `.trivyignore`'s own "a real version bump beats a suppression" precondition
  is satisfied. Exposure is nil — `libsqlite3-0` ships in the `node:24-trixie-slim`
  base image (verified by running it directly, so this is not a consequence of
  #490's python3 addition), the console's database is Postgres, neither
  `console/api` nor `console/web` declares a sqlite dependency, and both CVEs
  require parsing attacker-influenced SQLite/FTS5 data the console never
  touches. Time-boxed: re-check on the next base-image bump.
- **Restored `.github/dependabot.yml`, switching Dependabot version updates
  back on after five weeks off** (issue #496, audit #491). The file was added
  by #93 on 2026-07-19 and destroyed on 2026-07-22 when `main`'s history was
  replaced by upstream's rather than merged with it — not deleted by any
  commit, which is why nothing flagged it. Since then only the org-wide
  *security*-update channel has run; the scheduled weekly version sweep across
  `docker` (`/runtime/public-probe`, `/orchestrator`, `/console/api`) and
  `github-actions` (`/`) has not run at all. Two different configs were lost in
  the same event, covering **disjoint** ecosystems — `fbac815d` (2026-07-10)
  swept `npm`, and #93 (2026-07-19) replaced that with `docker` — so the
  restored file is the union of both, and neither surface is left unswept
  again. Each entry also carries the `cooldown: default-days: 7` block that
  `fbac815d` originally added to satisfy semgrep's
  `dependabot-missing-cooldown` rule, which is part of this repo's CI gate;
  restoring #93's version alone would have failed that gate. The two `npm`
  entries are grouped (`patch-minor`) to keep the first sweep from opening a
  PR per package. Operators should still expect a burst of version-update PRs
  on the first run after this lands — five weeks of drift across four
  ecosystems.
- **Incident record for the two `main` history resets**
  (`docs/incidents/INC-2026-07-22-MAIN-HISTORY-RESET-TO-UPSTREAM.md`, audit
  #491). Documents both events — 2026-06-30/07-03 and 2026-07-21/07-22 —
  dated to within hours from file presence at historical merge commits, the
  content confirmed lost (console world-partition controls #50, seven docs
  #76, three dependency bumps #58/#60/#97, `compliance/README.md`), the reason
  five weeks passed before anyone noticed, and the three audit methodologies
  that give confidently wrong answers on this repository. Neither event was
  written up at the time, which is why the second had no chance of being
  recognised as a recurrence. No operator deployment or player-facing system
  was affected by either event.

- **Real in-place upgrade coverage for the Tier 3 TOTP second factor**
  (issue #487, RFC `docs/rfc-console-auth.md` §4/§6). Every existing Tier 3
  test booted the console against a *fresh* state directory, which only ever
  exercised the fresh-install path — so the operator-visible behavior change
  that Strict Requirement 0 actually cares about (what happens to someone
  already running this console when they enable the flag) was never tested.
  New `console/api/test/upgradePath.integration.test.js` carries the same
  state directory across a real stop/restart and asserts the upgrade event
  end to end: a pre-upgrade single-factor session does not survive the
  restart, the first post-upgrade password login yields an enrollment-only
  session (and nothing else in the console is reachable from it), enrollment
  issues exactly 10 recovery codes once, and the password alone is rejected
  afterwards. Also closes three RFC §6 upgrade-path gaps that had no
  coverage anywhere: the enrollment session's 10-minute cap, rollback
  (turning the flag back off restores single-factor login and preserves the
  enrolled state byte-for-byte), and an abandoned enrollment regenerating its
  secret so a stale authenticator entry cannot silently linger.
- **`docs/console/two-factor-recovery.md`** — the operator-facing recovery
  and lockout runbook that RFC §3.4's procedures previously lacked. Covers
  recovery-code login, regenerating a lost code sheet, the total-loss host
  reset (verified against this repo's real service name and `dune console`
  commands, not written from the RFC's prose), and how to tell from the audit
  log whether an enrollment you did not perform has happened on your install.
### Fixed

- **Console Home/status panel was dead on any image rebuilt from this fork's
  `main`** (issue #489). Commit `c248780e` (2026-08-20) bumped the console base
  image from `node:20-bookworm` to `node:24-trixie-slim` for Trivy CVE
  remediation (#54). The full bookworm image ships `python3-minimal`; the slim
  variant does not, and `console/api/Dockerfile` had never installed python3
  explicitly because it was always inherited. That matters because the console
  does not shell out to the host — `runner.js` spawns `dune` with a plain local
  spawn (`cwd=/repo`), so `runtime-env.sh`'s python3 calls run inside the
  console container. The result was `dune status` exiting 127 with empty
  stdout, surfacing to operators as only "Server status is unavailable.
  Refresh again or check Services and Logs if it persists." python3 is now
  installed explicitly, with a regression test asserting it stays that way.
  Scope: this fork's `main` only — `c248780e` was never taken upstream, so
  operators on upstream releases were unaffected. Nothing failed at build time
  or in CI, and the break stayed invisible for five days because it only
  surfaces once the image is rebuilt.

### Changed

- **Tier 3 web console login now drives TOTP enrollment, recovery, and the
  authenticator step end-to-end (BETA, behind `CONSOLE_TOTP_ENABLED`)** (RFC
  `docs/rfc-console-auth.md` §4/§6, issue #407 phase 7). The login form now
  branches on the login route's own response: a `totpRequired` reply shows an
  authenticator-code field (with a "Lost access to your authenticator?"
  toggle to a recovery-code field when the server allows it); an
  `enrollmentRequired`/`resetupRequired` reply shows a new setup screen with
  a QR code (rendered server-side via the new `qrcode` dependency, entirely
  local -- no network egress), a manual-entry fallback secret, a code-confirm
  step, and a one-time recovery-code display gated by an explicit "I have
  saved these codes" acknowledgment before continuing. After 3 consecutive
  failed confirm attempts the error message names device clock skew as the
  likely cause (RFC §2.3); the setup screen also has a "Back to sign in"
  escape hatch at every point before confirmation succeeds. Fixed a real,
  pre-existing bug found while building this: the shared API client treated
  *any* 401 response as a stale session, so a wrong password (and, before
  this diff, any Tier 3 401 status) showed a generic "session expired"
  message instead of the real error -- the client now only treats a 401/403
  as session-expiry when the message actually says so. `/api/auth/2fa/setup`
  gained one new response field (`qrCodeDataUri`), additive and
  backward-compatible. Settings-panel wiring (sending `totpCode` on password
  rotation, #407 phase 6) and the operator rotation runbook remain separate,
  already-tracked work.
- **`.env.example`'s `CONSOLE_TOTP_ENABLED` block now states the upgrade
  consequence up front** (issue #487). It previously read as an ordinary
  opt-in beta toggle, with no indication that setting it to `1` on an install
  you already use redirects your very next login into a mandatory enrollment,
  shows the 10 recovery codes exactly once, and has no login-surface recovery
  if both factors are lost. That omission is how the flag came to be enabled
  unattended on a live install, locking its operator out of a working
  console. Now warns explicitly, points at the recovery runbook above, and
  notes that rolling the flag back off is safe and non-destructive.
- **`docs/security/console-rbac-implementation-and-testing.md` §10** no longer
  lists non-Discord break-glass/TOTP as an open design question — it shipped
  as Tier 3 (#407). Marked resolved with pointers to the RFC sections, the
  default-on gate (#424), the recovery runbook, and the upgrade test.

- **Synced upstream's Live Map marker overlay redesign onto this fork**
  (PR #480). Upstream (`Red-Blink/dune-awakening-selfhost-docker`) spent
  several weeks building a substantially more complete Live Map than
  this fork's own in-progress Layer 2 work under #462 (draft PR #478,
  closed unmerged -- see below): real in-game-style marker art (~70 new
  `.webp`/`.png` assets replacing both upstream's placeholders and this
  fork's own #463 `lucide-react`/game-icons.net icons), spice-field size
  tiers (`SPICE_TIER_TYPES`), per-subtype layer filtering
  (`subtypeFilters`, `EXPANDABLE_KEYS`), Coriolis storm seed tracking
  (`coriolisSeed.js`), and a much richer marker overlay (hover/pin
  facts+actions, keyboard-accessible, teleport picker, "Open in
  Bases"/"Open in Vehicles"). Cherry-picked (not merged) the 3 upstream
  commits that are genuinely live-map-scoped -- `e108abaa` (mobile
  Safari marker-shape fix), `7edf6044` (base markers link to base
  details), `2227acc2` (the marker redesign itself, upstream #193) --
  rather than a full `upstream/main` merge, after a first full-merge
  attempt was aborted for silently deleting three of this fork's own
  addon-integration functions (`addonOpsContainerHealth`,
  `addonOpsPostgresHealth`, `addonOpsRabbitmqHealth`, used by
  `dune-ops-observability-addon`) unrelated to live-map entirely.
  `LiveMapMarker.type` (`api/liveMap.ts`) goes from the plain `string`
  #469's fix widened it to back to a real discriminated union (now
  covering every marker/subtype category upstream's redesign
  introduces) -- every call site already treated it as one of a known
  set, so this is a correctness tightening, not a behavior change.
  **Operators upgrading need no action**: no schema migration, no new
  env var, no changed default -- this only changes the Live Map
  feature's own rendering/query surface.

- **Closed PR #478 (this fork's own #462 Layer 2 draft) unmerged, in
  favor of #480.** Its query logic and packed-`field_id` decode
  (`resourceFieldId.js`) are fully duplicated by what #480 brought in
  from upstream (`spiceFieldDecode.js` -- both independently arrived at
  the identical 21-bit two's-complement coordinate-packing scheme). The
  one piece of #478 *not* duplicated -- an isolated, read-only-only
  Postgres role/connection pool for the map-polling read path
  (`createReadOnlyMapPool()`), vs. upstream's `liveMapPoi`/`liveMapSpice`
  reading through the same shared admin pool as every write-capable
  route -- is tracked as its own scoped follow-up in issue #481 rather
  than resurrected against #480's different implementation underneath
  it. `feat/462-live-resource-map` (the closed PR's branch) is
  intentionally not deleted, so #481 can recover that diff.

### Fixed

- **Live Map's marker-type legend/filter list was hardcoded to 4 types** (issue
  #469, a HIGH finding from #462's Layer 1 Eight-Hat audit). `filters` state
  only ever had `player`/`vehicle`/`base`/`storage` keys, and the sidebar
  legend/checkbox list is rendered from `Object.keys(filters)` -- a marker
  type outside that set (e.g. the `poi`/`resource` types #462 proposes)
  would still render as a pin on the canvas (unmapped types default to
  visible), but with no legend entry, no live count, and no way to toggle
  it, making the feature invisible in its own primary UI. `filters` now
  merges in any newly-seen marker type on every poll, defaulted to visible,
  without disturbing an operator's existing toggle choices (new
  `mergeMarkerTypeFilters` helper, `LiveMapPanel.markerFilters.test.ts`).
  `LiveMapMarker.type` (`api/liveMap.ts`) is widened from a fixed 4-value
  union to `string` to match how every call site already treated it
  (`String(marker.type)`, never an exhaustive match) -- no behavior change,
  just makes the type honest.

- **`Release gate` was red on every PR, including `main`'s own last push** (issues
  #465, #466). Two independent causes, both found while unrelated PR #463/#464
  CI runs inherited the same failure:
  - `tests/security-pr-checks.sh`'s changed-file scan diffed against
    `upstream/main` using `git diff "$BASE_REF"...HEAD`. `git merge-base --all
    upstream/main HEAD` now returns 3 valid, ~2-month-stale candidate merge
    bases, so the automatic three-dot resolution picked one ambiguously,
    exploding the "changed files" scope from a PR's real diff to ~630 files
    (nearly the whole repo) and sweeping in an unrelated, already-known finding.
    `.github/workflows/ci.yml`'s routine `security-checks` run now passes
    `BASE_REF=origin/main` explicitly (this fork's own base branch has a
    single, unambiguous, recent merge base with any normal feature branch);
    the script's own default stays `upstream/main` for a contributor manually
    re-running it ahead of an upstream PR to Red-Blink (Requirement 19).
  - `trivy-image-scan` found `CVE-2026-73566` (node-tar DoS) in npm CLI's own
    bundled `tar` (`7.5.16`, fixed in `7.5.21`) inside `node:24-trixie-slim` —
    not this project's dependency tree (`npm audit`/`osv-scanner` both clean).
    Confirmed no published npm release bundles the fix yet (latest, `12.0.2`,
    still ships `tar@7.5.19`). Accepted in `.trivyignore` alongside the two
    other already-accepted `tar` CVEs there under the identical justification.

- **`security-checks` CI job was silently skipping its gitleaks and
  trivy filesystem scans.** `tests/security-pr-checks.sh` fails open
  when either binary is missing (`command -v gitleaks || SKIP`), and
  neither ships preinstalled on `ubuntu-latest` — so the job reported
  `success` on every push/PR to `main` without ever actually running
  two of its three claimed secret scanners. `.github/workflows/ci.yml`
  now installs both tools explicitly (checksum-verified, matching the
  existing `hadolint` job's pattern) before calling the script, and the
  script itself now exits non-zero if either tool is still missing when
  `CI=true` (local/pre-commit runs keep the softer skip message, since
  a contributor's machine not having every scanner installed shouldn't
  block a local commit).

### Added

- **Four new CI security gates: `govulncheck`, `hadolint`, `osv-scanner`,
  `trivy-image-scan`** (all required by `release-gate`). See
  `docs/security/ci-security-tooling.md` for the full tool inventory and
  what each gate has actually caught. `govulncheck` found and this PR
  fixes 26 code-reachable Go standard-library CVEs in
  `runtime/public-probe` (a toolchain-version bump, `go.mod`'s `go`
  directive and the Dockerfile's `golang:` build-stage tag both bumped
  to `1.25.13`; one additional unreachable, no-fix-available transitive
  finding is documented and accepted). `hadolint` found and this PR
  fixes a missing `--no-install-recommends` on
  `orchestrator/Dockerfile`; OS-package version-pinning warnings
  (`DL3008`/`DL3018`) are deliberately ignored project-wide via the new
  `.hadolint.yaml`, with the reasoning documented there. `trivy-image-scan`
  promotes issue #54's one-off manual finding to a standing, recurring
  gate against the real built console image. `osv-scanner` found nothing
  new on introduction; included as defense-in-depth alongside `npm
  audit`/`govulncheck`. Operators upgrading need no action -- these are
  CI-only gates with no runtime behavior change.

- **Live Map markers and legend entries now render a distinct icon per
  type** (players, vehicles, bases, storage), instead of only a colored
  dot -- issue #462. Icons come from `lucide-react` (already a
  dependency), not any third-party map's artwork, sidestepping the
  licensing/provenance question raised while scoping #462. Also wires
  up `poi` and `resource` icon slots and a neutral fallback badge for
  any marker type not yet mapped, so the backend work #462 still needs
  (surfacing POIs and resource fields on the map) renders with a
  reasonable default the moment it ships, with no frontend follow-up
  required.
  **Superseded (2026-08-25, #480):** upstream shipped its own, far more
  complete Live Map marker redesign (real in-game-style `.webp`/`.png`
  art per marker/subtype, cherry-picked into this fork rather than
  rebuilt independently -- see the "Synced upstream's Live Map..." entry
  below). The `lucide-react`-based icon mapping this entry describes
  (`LIVE_MAP_MARKER_ICONS`/`liveMapMarkerIcon()`) no longer exists in
  `LiveMapPanel.tsx` as of #480 -- left here as accurate history of what
  #463 shipped at the time, not as a description of current behavior.

### Fixed

- **`.gitleaks.toml`'s allowlist had zero effect in CI** (issue #458). It used the plural `[[allowlists]]` table at the file's top level, anticipating gitleaks v8.25.0+'s config schema — but every gitleaks invocation in this project is pinned to v8.24.3, whose config parser has no top-level plural `Allowlists` field at all (confirmed directly against that version's source: the field only exists nested under a specific `[[rules]]` entry). Viper silently drops unrecognized top-level keys, so the allowlist was never actually applied — verified directly, even `runtime/scripts/command-auth-token.sh`, the file the allowlist's own description names as the canonical intentional case, was still being flagged whenever gitleaks actually ran (which it hadn't been, until #457's fix). Reverted to the singular `[allowlist]` table, which v8.24.3 does parse and apply. Verified against a real scan: the two docs that previously false-flagged the documented `BUILTIN_COMMAND_AUTH_TOKEN` constant now scan clean, and the repo's own synthetic-secret canary check (guards against the allowlist accidentally disabling default detection rules) still passes.

- **`dune-autoscaler` was burning 80.99% of a core on `dune-dev` (14.81%
  on `dune-prod`)** (issue #453). Root cause: three heal-scan functions in
  `runtime/scripts/autoscaler.sh` — `scan_proactive_hagga_handoffs`,
  `scan_deepdesert_loading_responses`, `scan_named_destination_failures`
  — were not gated behind the existing `director_heal_due` rate-limiter,
  so each re-ran `docker logs` plus a fresh `python3` regex parse on every
  5-second main-loop tick instead of a sane interval; `scan_named_destination_failures`
  was the worst offender, re-decoding a 10-minute log window across 3
  containers roughly 120x more often than needed. Cost scales with how
  chatty the watched containers' logs are, which explains the dev/prod
  split. Fixed by gating all three behind `director_heal_due`, the same
  pattern most other scans in this file already use, via three new
  overridable env vars: `DUNE_AUTOSCALER_PROACTIVE_HAGGA_SCAN_SECONDS`
  (default 15s), `DUNE_AUTOSCALER_DEEPDESERT_LOADING_SCAN_SECONDS`
  (default 15s), `DUNE_AUTOSCALER_NAMED_DESTINATION_SCAN_SECONDS`
  (default 60s) — each safely shorter than the log window the function
  reads, so no detection gap opens. **Correction (post-review): the
  original claim that these were "the only heal scans in the file not
  gated" was wrong** — `scan_travel_demand`, `scan_idle_servers`,
  `scan_reconnect_demand`, and `scan_live_player_partition_alignment`
  remain ungated; see the follow-up entry below for why they're left
  that way deliberately (for now) rather than silently. Two real behavior
  changes worth calling out explicitly: worst-case remediation latency
  for a stuck "named destination not found" travel failure goes from
  ≤5s (previous main-loop cadence) to up to 60s, and DeepDesert loading
  first-detection latency goes from ≤5s to up to 15s; every other case
  is unchanged in practice because a separate always-running follower
  (`follow_director_hagga_handoffs`) or independent refresh gate already
  handled the real-time path. Operators upgrading need no action — all
  three new env vars default to safe, lower-CPU values. New test:
  `tests/autoscaler-heal-scan-rate-limit-test.sh`.

- **Follow-up to the above: fixed a real duplicate-publish bug the initial
  fix's wider scan interval exposed, and closed three gaps a subsequent
  review found.** `scan_deepdesert_loading_responses` had no dedup guard
  before its `publish_rmq_json` call (unlike its sibling scans) and a dead
  if/else after it (both branches identical) — a re-detected flow within
  the scan's own 30s log window caused a genuine duplicate travel-response
  publish to the origin game server. Fixed by adding the same
  `deepdesert_travel_seen ... && continue` guard its siblings already use,
  before any side effect. Also: (1) the three new `*_SCAN_SECONDS` env vars
  now validate numeric input the same way `DUNE_AUTOSCALER_DEMAND_INTERVAL`
  already does — a malformed override (e.g. a duration string like this
  file's own `SINCE`/`NAMED_DESTINATION_SINCE` use) previously silently
  defeated the gate instead of falling back to a safe default; (2) each
  interval is now clamped below its log window at startup instead of only
  being asserted safe in prose, so a misconfigured override can't open a
  permanent detection gap; (3) `tests/autoscaler-heal-scan-rate-limit-test.sh`
  was never wired into `ci.yml`'s test list, so it never actually ran in
  CI — fixed, plus a new `tests/autoscaler-scan-gating-inventory-test.sh`
  that enumerates every `scan_*` function and fails CI if a future one is
  added without either the gate or a deliberate, documented exception
  (closing the structural gap that let the original oversight happen
  three times over). `scan_named_destination_failures` also now calls
  `docker ps` once per invocation instead of once per source map (3x
  fewer calls). Operators upgrading need no action.

- **Corrected a systematic wrong `volume` value affecting live container
  capacity math for 70 of the 99 `raw_resource`/`refined_resource`/`component`
  catalog items** (issue #440). Every `refined_resource`/`component` item
  whose in-repo `volume` was exactly `1.0` was wrong — a placeholder that
  was apparently never replaced with a real measurement — except one
  (`T6RefinedResourceA`, genuinely 1.0). `raw_resource` items were
  unaffected (individually measured from the start; those values matched
  the same external verification source exactly, which is what made
  trusting that source for the volume correction, not just the earlier
  `stackSize` one, reasonable). Real values range from 0.1 (most
  components — a 10x understatement at the old placeholder) to 5 (large
  fuel canisters). This directly affects give/fill's live volume-clamp
  math (`quantityThatFitsByVolume`) — the old placeholder let more into a
  volume-capped container than the game's real per-unit accounting
  expects. Operators upgrading need no migration; no schema/env change.
  See `docs/console/base-inventory.md`'s curation note. Also bulk-curated
  `stackSize` for all 91 remaining `raw_resource`/`refined_resource`/
  `component` items using the same source (issue #431) — every item in
  those three groups now has a curated stack size except two that don't
  exist in the external source and weren't pursued further (issue #441,
  closed).

- **Corrected two wrong `stackSize` values shipped in the #430 give/fill
  stack-limit work: `Oil` and `SpicedFuelCell` are 500, not 499** (issue
  #430 follow-up). Both were seeded from `GENERATOR_TYPES`' refill table,
  which turned out to be a refill *policy* value, not the engine's real
  per-item cap. An operator challenge to validate against an external
  source (dune.gaming.tools's own item data feed) found the true limit is
  500 for both, matching `addonSeedJob.js`'s pre-existing value (issue #432
  had already flagged this exact contradiction). `MelangeSpice` 500 and
  both lubricants at 100 were independently confirmed correct against the
  same source. The generator-refill table's own 499 is left unchanged —
  it's a separate, already-live system; whether it should be raised to 500
  is its own live-verified decision. See
  `docs/console/base-inventory.md`'s curation note.

### Changed

- **Give/Fill item paths now adhere to the game's per-item stack limits**
  (issue #430). The game engine enforces a per-item max stack size (Spice
  Melange, Fuel Cell, and Spice-infused Fuel Cell all 500, lubricants 100 —
  externally verified against dune.gaming.tools, see the Fixed entry above
  for the correction of an initial wrong value), but every console give/fill
  path previously wrote the full requested quantity — up to 1,000,000
  units — into a single `dune.items` row, bypassing the engine's own stack
  validation. Stack limits are now curated in `runtime/data/admin-items.json`'s
  new optional `stackSize` field (exactly like `volume`; see
  `docs/console/base-inventory.md`'s curation note before adding more) and
  enforced everywhere the console inserts item rows, case-insensitively:
  Storage/Base-container Give and Fill and player Give **split** an
  oversized quantity across full stacks plus one final remainder stack,
  completing in one action bounded by the container's real capacity
  (remaining slots/volume; a 1,000-row runaway backstop shared by the
  whole operation, including across a Give Multiple batch, exists only to
  stop pathological million-row transactions), while the
  slot-grid Add Item path **clamps** to one full stack, matching its
  deliberate one-row-one-slot placement. Responses report the outcome
  honestly: `requested`/`given`/`clamped` plus new `stacks`,
  `insertedStacks`, `clampReason` (`volume`/`slots` = real capacity, final;
  `stack-rows` = only the per-operation cap, repeat the action to add more)
  and a human-readable `message`; the player-give path, care packages, and
  the batch stop reason all state a shortfall instead of implying full
  delivery, and fill-to-capacity claims "as much as fit" only when real
  capacity — not the row cap — was the boundary. Split rows on slot-capped
  inventories claim in-range free slots (Fill and player Give previously
  used `max(position_index)+1`, which after any high-end Give would have
  landed rows beyond `max_item_count`, outside the engine's slot grid).
  Items without catalogued stack data keep the previous single-row behavior
  unchanged. Operators upgrading need no migration; pre-existing over-limit
  stacks are not rewritten.

- **Tier 3 recovery-code login (BETA, behind `CONSOLE_TOTP_ENABLED`)** (RFC
  `docs/rfc-console-auth.md` §2.3). An operator who has lost their authenticator
  signs in with their password plus one unused recovery code (the code
  substitutes for the TOTP factor only, never the password). A successful
  recovery login does not grant a normal session -- it forces a restricted
  re-setup that enrolls a fresh TOTP secret and issues a fresh 10-code recovery
  set, invalidating all remaining old codes (§2.3). Recovery codes are
  single-use; a wrong password never consumes one. New audit events
  `auth.recovery-code-consumed` and `settings.totp-regenerated`. Inert while the
  flag is off (default). Credential rotation with scoped session invalidation
  is covered by the entry below.

- **Tier 3 credential rotation now revokes other password/TOTP sessions and
  requires fresh proof-of-possession (BETA, behind `CONSOLE_TOTP_ENABLED`)**
  (RFC `docs/rfc-console-auth.md` §2.3/§5, issue #407 phase 6).
  `POST /api/settings/admin-password` now requires a fresh TOTP code (in
  addition to the current password) before rotating the password whenever a
  second factor is enrolled -- the existing session cookie is no longer
  sufficient proof on its own. On success, every other password/TOTP-
  authenticated session is revoked (scoped invalidation: Discord- and future
  passkey-authenticated sessions are untouched); the acting session survives.
  Rejected attempts (wrong password, missing/wrong TOTP code) revoke nothing.
  This endpoint is now rate-limited the same way the login route already is
  (8 attempts/key, 32 global, 15-minute block), closing a gap where a stolen
  session cookie could otherwise be used to brute-force the TOTP factor with
  no throttling. New audit event `auth.password-changed.sessions-revoked`.
  Inert while `CONSOLE_TOTP_ENABLED` is off (default) or no second factor is
  configured. The settings-panel UI does not yet send a TOTP code with this
  request -- rotating the password via the UI while TOTP is enrolled will
  correctly fail with `totpRequired` until the frontend (phase 7) ships; the
  route itself already accepts a `totpCode` field. Frontend wiring and the
  documented rotation runbook (RFC §2.3) are later phases.

- **Tier 3 console auth (BETA, behind `CONSOLE_TOTP_ENABLED`, default OFF):
  password + mandatory TOTP with authenticator enrollment** (RFC
  `docs/rfc-console-auth.md` §2.3/§4). Adds the backend flow: a first password
  login with no second factor set up issues a short-lived, restricted enrollment
  session and returns `enrollmentRequired`; `POST /api/auth/2fa/setup` returns a
  TOTP secret + `otpauth://` URI; `POST /api/auth/2fa/confirm` verifies a code,
  commits the factor, and shows 10 one-time recovery codes once. Once enrolled,
  password login also requires a 6-digit code, verified with per-step replay
  prevention. **With the flag unset (default), password login is byte-identical
  to today (single factor)** -- the flag is off during incremental rollout until
  the console UI that drives enrollment lands (a later phase), and becomes the
  default then. Enrollment sessions are confined by an allowlist gate to the
  `/api/auth/2fa/*`, `/me`, and `/logout` endpoints only. New audit events:
  `auth.2fa.setup`, `auth.2fa.confirm`, `settings.totp-setup`, and `auth.login`
  now carries an outcome/reason. Recovery-code login and credential rotation are
  later phases.

- **Discord OAuth tier resolution is now fail-closed when the bot handoff is
  configured** (issue #401, RFC `docs/rfc-console-auth.md` §2.1). Three
  operator-visible behavior changes for handoff-configured installs:
  (1) a handoff failure of any kind (bot down, bad signature, stale payload)
  now denies the sign-in instead of silently falling through to the static
  `DISCORD_OAUTH_OWNER_ALLOWLIST` -- the fail-open privilege escalation the
  RFC's §1.1 describes; denials are recorded as `auth.handoff-denied` with a
  reason code and the denied user's id in the audit log.
  (2) `DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP` is no longer required to complete
  Discord sign-in when the handoff is configured -- the bot is the tier
  source; prune stale allowlist entries (see `.env.example`).
  (3) a half-configured handoff (some but not all of secret/URL/guild set,
  or a non-http(s) URL) disables Discord sign-in with a boot warning naming
  the problem, instead of silently behaving as if no handoff existed.
  Password sign-in and installs without any handoff config are unaffected.
  OAuth callback failures now render an HTML error page with a link back to
  the sign-in screen instead of raw JSON.
- **Security (CRITICAL, issue #403): `POST /api/auth/discord/exchange` no longer
  mints an owner session for any valid Discord token.** The endpoint (the
  fork-only Atrium single-auth flow) previously granted a full **owner** console
  session to anyone who could complete a Discord OAuth whenever the optional
  `ATRIUM_ALLOWED_DISCORD_USER_ID` gate was unset -- an unauthenticated-to-owner
  privilege escalation. It now (1) **fails closed** when that gate is unset
  (denies rather than granting a session) and (2) mints a read-only **observer**
  session instead of owner, even for the configured user -- the Atrium page gate
  authorizes on user id, not tier, so observer suffices. Operators using the
  Atrium flow must set `ATRIUM_ALLOWED_DISCORD_USER_ID`; console administration
  uses the password or Discord sign-in flows, not this endpoint. See
  `.env.example`.

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
