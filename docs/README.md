# Documentation Index

This folder mirrors the repo's own structure: component docs live under a folder
named for the component they document (`console/`, `runtime/`, `addons/`), while
docs that span the whole product or are pure assets stay at this root
(`screenshots.md`). Cross-cutting concerns (`security/`, `incidents/`) get their
own top-level folders.

Docs marked **Historical record** describe a point-in-time state (a branch, a PR,
an issue) and are not kept up to date — read them for context, not as current
reference. Everything else is marked **Current** and is expected to stay accurate.

## Adding a new doc

1. **Pick the folder by what the doc documents, not what kind of doc it is.**
   If it explains a piece of `console/api` or `console/web`, it goes in
   `docs/console/`. If it explains something under `runtime/`, it goes in
   `docs/runtime/`. Addon-platform behavior goes in `docs/addons/`. Only use
   `docs/security/` or `docs/incidents/` for concerns that cut across
   components (a vulnerability class, a post-incident review) rather than a
   single feature. Don't add a new top-level folder for one document — put it
   in the closest existing one.
2. **Decide Current vs Historical up front**, and put the line right after the
   H1, matching the existing docs:
   - Living reference that should be kept accurate as code changes:
     `**Status:** Current | **Last Updated:** <Month Year>`
   - A frozen snapshot of a PR, branch, or issue — a test report, a change
     summary, implementation notes — goes in `docs/archive/` with:
     `**Status:** Historical record — describes the state at <PR/branch/issue>. Not maintained.`
     Add a pointer to the current doc that superseded it, if one exists.
3. **Add one line to this index**, in the matching section above: a link, one
   sentence of purpose, and the status word. A doc with no line here is
   effectively invisible — this file is the only thing every other doc is
   guaranteed to be reachable from.
4. **Cross-link the doc's nearest relatives** (the feature doc it complements,
   the security review of the same code path, the API reference section that
   covers its endpoints) directly in the doc body, not just in this index.

## Architecture

- [architecture/SYSTEM-OVERVIEW.md](architecture/SYSTEM-OVERVIEW.md) — Current. Whole-system engineering architecture reference: component map, the console's API/web/data layers, the `dune` CLI and Compose-project-name resolution, runtime state directories, and the Discord-integration split. Start here for a code-level overview before diving into a single component's docs.
- [architecture/SPECIALIZATION-READINESS-TOOL.md](architecture/SPECIALIZATION-READINESS-TOOL.md) — Design (not yet implemented), issue #153. Architecture for a tool to check/complete the game's 8-step Specialization unlock chain before granting specialization rows via the console.

## Console (`console/api`, `console/web`)

- [API-REFERENCE.md](console/API-REFERENCE.md) — Current. Full HTTP API reference for every console endpoint.
- [blueprints.md](console/blueprints.md) — Current. Blueprint import/export developer documentation.
- [PRE-AUGMENTED-GEAR.md](console/PRE-AUGMENTED-GEAR.md) — Current. API reference for granting gear with augments pre-applied.
- [generator-fuel-burn-rates.md](console/generator-fuel-burn-rates.md) — Current. Per-generator fuel burn constants and where they live in code.
- [generator-refill-caps.md](console/generator-refill-caps.md) — Current. Refill-generators endpoint behavior and per-type fuel caps.
- [base-permissions.md](console/base-permissions.md) — Current. Editing base ownership and sharing: ranks, the config-driven roster cap, and why the change needs no map restart.
- [base-inventory.md](console/base-inventory.md) — Current. The base Inventory tab: which placeables count as storage, the two inventories every refinery carries, per-slot container contents, and the stopped-map safety boundary for deleting stored items.
- [base-deletion.md](console/base-deletion.md) — Current. Permanently deleting a base: what "the base" means for enumeration, the pending-delete queue for a live map, the mandatory pre-delete safety backup, and why a pending delete freezes every other mutation on that base.
- [base-backups.md](console/base-backups.md) — Current. What the game's own "pick up base" tool actually does in the database, why the Bases panel excludes a picked-up base, and why every mutation route rejects one too.
- [database-backups.md](console/database-backups.md) — Current. Safe database restore behavior when the backup and current deployment use different Battlegroup IDs.
- [restart-queue.md](console/restart-queue.md) — Current. The Restart Queue toggle: player-aware countdowns with in-game warnings, the two broadcast variants, concurrency rules, crash recovery, the "Restart later" deferred-restart option, and the join-lock limitation.
- [exchange.md](console/exchange.md) — Current. The read-only Market Board: aggregated-by-item CHOAM exchange listings, seller resolution, how bot listings are identified, and the bot/blacklist filter config.
- [console-iam.md](console-iam.md) — Current. The four-step per-request authorization pipeline (session → action mapping → policy evaluation → default-deny), the five-tier policy model, and the anti-lockout guard. Root-level file despite the name pattern below — see [architecture/SYSTEM-OVERVIEW.md](architecture/SYSTEM-OVERVIEW.md) §2.3 for a shorter summary that links back here.

## Runtime (`runtime/`)

- [CONTAINER-HARDENING.md](runtime/CONTAINER-HARDENING.md) — Current. Summary of container hardening changes.
- [E2E-METRICS-TESTING.md](runtime/E2E-METRICS-TESTING.md) — Current. End-to-end validation procedure for the metrics stack (`runtime/metrics`).
- [MULTI-SERVER-SINGLE-PUBLIC-IP.md](runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md) — Current. Executive overview and detailed SOP for running multiple isolated battlegroups behind one public IPv4, including full per-instance port profiles, NAT/hairpin requirements, UserEngine configuration, validation, rollback, and the `multi-server-config.py` automation helper.
- [METRICS-ALERTMANAGER-DISCORD-RELAY.md](runtime/METRICS-ALERTMANAGER-DISCORD-RELAY.md) — Current. Bearer-token authentication for the Alertmanager-to-Discord relay endpoint; why the relay fails closed if the token file is missing.

## Addons

- [addon-item-grants.md](addons/addon-item-grants.md) — Current. The `admin:grant-items` permissioned addon item grant flow.
- [addon-scheduled-jobs.md](addons/addon-scheduled-jobs.md) — Current. Market Bot scheduler and EDA retirement compatibility.
- [hardware-status.md](addons/hardware-status.md) — Current. Permissioned, core-owned host telemetry for addon dashboards.

## Discord Integrations

Two overlapping doc sets — start with whichever matches your role:

- [discord-integration/README.md](integrations/discord-integration/README.md) — Current, **operator-facing**. Adapter overview, setup, routes, and RBAC.
  - [admin-guide.md](integrations/discord-integration/admin-guide.md) — Walkthrough for getting the bot running on your server.
  - [faq.md](integrations/discord-integration/faq.md) — Frequently asked questions.
  - [troubleshooting.md](integrations/discord-integration/troubleshooting.md) — Common problems and fixes.
  - [TIER-TRACKING.md](integrations/discord-integration/TIER-TRACKING.md) — Pointer file. Core-repo items in the cross-repo Discord/OPS tier tracker; the authoritative tracker lives in `dune-ops-observability-addon`.
- [discord-control-bot/admin-guide.md](integrations/discord-control-bot/admin-guide.md) — Current, **internal**. Admin guide for the experimental read-only companion bot.
  - [setup-guide.md](integrations/discord-control-bot/setup-guide.md) — Validating the command layer and adapter without a live Discord connection.
  - [user-guide.md](integrations/discord-control-bot/user-guide.md) — Command reference for end users.
  - [api-adapter-contract.md](integrations/discord-control-bot/api-adapter-contract.md) — The protected server-side adapter contract.
- [../bot/output-architecture.md](bot/output-architecture.md) — Current (2026-08-10). Companion-repo (`arrakis-control-panel`) Discord bot output-rendering pipeline; documented here because it's a direct consumer of this repo's adapter/routes surface.
- [engine/command-catalog.md](engine/command-catalog.md) — Current, living catalog (Phases 1–4, issue #148). Reverse-engineered inventory of the closed-source dedicated server's native admin/console command surface, extracted from the Funcom-published `seabass-server` image's compiled string tables. Generated in part by [`generate-command-catalog.py`](engine/generate-command-catalog.py).

## Design / RFC (Layer 1, pre-implementation)

Documents in this section describe **proposed or in-progress** designs, not
shipped behavior — cross-check against the linked current doc (if any) or the
actual code before treating a claim here as live in `main`.

- [rfc-console-auth.md](rfc-console-auth.md) — Layer 1 Design / RFC (2026-08-17), submitted upstream as PR #141. Layered console authentication proposal: Discord OAuth (fixed default), optional passkeys (TLS-gated), hardened password+TOTP fallback. Supersedes [design/console-layered-auth-l1-design-2026-08-17.md](design/console-layered-auth-l1-design-2026-08-17.md) (kept for its fuller audit-trail detail).
- [design/console-layered-auth-l1-design-2026-08-17.md](design/console-layered-auth-l1-design-2026-08-17.md) — Superseded 2026-08-17 by [rfc-console-auth.md](rfc-console-auth.md) above; kept for historical audit-trail detail (three-draft findings register).
- [rfc-command-discovery.md](rfc-command-discovery.md) — Layer 1 Design / RFC (2026-08-08). Proposal to eliminate the six independent copies of Discord command metadata across Core and the bot via a single generated catalog.
- [rw-architecture.md](rw-architecture.md) — Layer 1 Design (2026-08-08), Eight-Hat audit complete, issues #215-223 filed and open at time of writing. Two-phase preview/execute write-command architecture for the Discord bot — **not fully shipped**; do not treat as current production behavior.
- [audit/l1-l2-container-health-2026-08-10.md](audit/l1-l2-container-health-2026-08-10.md) — L1/L2 audit record for the `ops.health.containers` bridge (Docker-socket-based container stats/status route).
- [upstream-pr-proposal.md](upstream-pr-proposal.md) — Historical record (v2, 2026-08-08). Superseded planning document scoping which of this fork's changes were proposed for upstream submission; individual upstream PRs (tracked via `upstream-pr/*` branches) are the current source of truth for what was actually submitted.

## Security

Most docs below describe controls that are still in force; they are marked
historical because they read as point-in-time PR records, not because the
control itself is stale. Three (marked below) are living design/analysis
documents, not point-in-time records.

- [addon-provenance.md](security/addon-provenance.md) — Historical record. Community addon discovery and code-signing threat model.
- [generated-command-auth-token.md](security/generated-command-auth-token.md) — Historical record. Command auth token generation hardening.
- [login-rate-limit-defense.md](security/login-rate-limit-defense.md) — Historical record. Login rate limiting defense.
- [pre-augmented-gear-grant.md](security/pre-augmented-gear-grant.md) — Historical record. Security review of the pre-augmented gear grant path — see [PRE-AUGMENTED-GEAR.md](console/PRE-AUGMENTED-GEAR.md) for current reference.
- [audit-2026-07-04.md](security/audit-2026-07-04.md) — Historical record. Original 2026-07-04 security audit; severity of two of its three Critical findings was later revised down to High on independent re-verification (see the root project README's Repo-by-Repo Notes for that correction) — read the linked GitHub issues (#121-123) for current status, not this document alone.
- [command-auth-token-vulnerability-and-failed-remediation.md](security/command-auth-token-vulnerability-and-failed-remediation.md) — Historical record / investigation. Root-cause writeup of the command-auth-token vulnerability and two failed remediation attempts that each caused a real outage. Explicitly labeled "no code change shipped yet" at time of writing.
- [data-classification-and-access-review.md](security/data-classification-and-access-review.md) — Current. Data classification tiers and access-review reference.
- [discord-player-link-hardening.md](security/discord-player-link-hardening.md) — Historical record. Hardening review tracked against upstream issue `Red-Blink#100`.
- [console-rbac-implementation-and-testing.md](security/console-rbac-implementation-and-testing.md) — Historical record (design/implementation plan, phases shipped 2026-08-06/07). Superseded as current reference by [console-iam.md](console-iam.md); kept for the IAM migration's implementation history.
- [player-linking-security-architecture.md](security/player-linking-security-architecture.md) — Current (Active, phase one: 1:1 linking). Security architecture for Discord-to-player-character linking.
- [secrets-management.md](security/secrets-management.md) — Current (Analysis — candidate evaluation before implementation, 2026-08-07). PKI/CMK secrets-management deep dive; see the root project README's Strict Requirement 27 for the rotation-cadence requirement this analysis feeds into.

## Incidents

- [INC-2026-07-24-STEAMCMD-CDN-OUTAGE.md](incidents/INC-2026-07-24-STEAMCMD-CDN-OUTAGE.md) — Historical record. Post-incident case study: SteamCMD content-host failure.
- [INC-2026-07-27-ENV-ROOT-OWNERSHIP.md](incidents/INC-2026-07-27-ENV-ROOT-OWNERSHIP.md) — Historical record. Resolved. Root-owned `.env` blocked the console container's read access.
- [INC-2026-07-31-FILL-ITEMS-VISIBLE-ONLY-AFTER-RESTART.md](incidents/INC-2026-07-31-FILL-ITEMS-VISIBLE-ONLY-AFTER-RESTART.md) — Historical record. Resolved. Fill-item rows were invisible in-game until a server restart; motivated the engine command-catalog investigation above.

## Archive

Frozen PR/issue evidence, kept for history. Not maintained; see the linked
current doc for anything still accurate today.

- [blueprints-report.md](archive/blueprints-report.md) — Historical record. Feature spec and test report for PR #80 — see [blueprints.md](console/blueprints.md).
- [PR-EVIDENCE-ADDON-METRICS-SUPPORT.md](archive/PR-EVIDENCE-ADDON-METRICS-SUPPORT.md) — Historical record. PR evidence for the addon metrics stack — see [E2E-METRICS-TESTING.md](runtime/E2E-METRICS-TESTING.md).
- [R1-METRICS-STACK-IMPLEMENTATION-NOTES.md](archive/R1-METRICS-STACK-IMPLEMENTATION-NOTES.md) — Historical record. Implementation notes for issue #82 — see [E2E-METRICS-TESTING.md](runtime/E2E-METRICS-TESTING.md).

## Other

- [operator-guide.md](operator-guide.md) — Current. End-user/operator guide: Web UI feature tour, bases, backups, updates, community addons (including a stated documentation gap on the addon-install UI flow), the Public Server Directory, Discord integration, and multi-server hosting. Cross-links the feature docs above rather than duplicating them.
- [screenshots.md](screenshots.md) — Current. Whole-product screenshot gallery, linked from the root [README](../README.md).
