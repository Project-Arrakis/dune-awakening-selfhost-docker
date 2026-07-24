# Tier Tracking — Remaining Gaps & Feature Work (Discord/OPS integration)

**Created**: 2026-07-24

This is a pointer file. The full, authoritative tier tracker covering both `dune-awakening-selfhost-docker` (Core) and `dune-ops-observability-addon` work lives in the addon repo: [`dune-ops-observability-addon/docs/TIER-TRACKING.md`](https://github.com/yacketrj/dune-ops-observability-addon/blob/main/docs/TIER-TRACKING.md) (kept there since most of the tab-scoped work is addon-side; Core-side items are cross-referenced in it under `repo: core`).

**Core-repo items currently tracked there**:
- Tier 3.1 — issue [#113](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues/113): `server.js`'s `addonBridgeRoute` HTTP route layer has zero test coverage.
- Tier 4.1 — Combat tab PvP/PvE death classification: blocked on a maintainer decision about a `deathPoller.js` schema + write-time change (not a simple wiring fix — see the tracker for why).
- Tier 4.2 — stale issue reconciliation for [#82](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues/82) and [#84](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues/84).

Also tracked there for full history: Core PRs #103, #104, #108–#117 (combat-state resolver, security hardening, OPS route wiring, Spice Melange rework) — all merged, Tier 0.
