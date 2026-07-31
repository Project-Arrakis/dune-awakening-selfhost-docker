# Incident Case Study: Fill-Item Rows Invisible In-Game Until Server Restart

**Incident ID:** INC-2026-07-31-001

**Date:** 2026-07-31

**Status:** Resolved (behavior proven; console action + documentation shipped).

**Scope:** A behavioral finding confirmed on this host's live game server. The mechanism is
engine/DB-level (the closed-source game engine claims inventory rows written into the
console's Postgres `dune.items` table only when the server process starts), so it plausibly
applies to every operator using the console's fill-item/give-item row inserts on any fork
that shares this Postgres schema — but it was confirmed only here, and is generalized
elsewhere only as a hypothesis. The associated console UI change ships in this fork only.

## Summary

Fill-item (and give-item-to-storage) rows inserted into `dune.items` for container
inventories were written and persisted correctly, but **never appeared in-game**. The
console reported the fill as successful, the database row existed with correct engine-shaped
stats, and no error was surfaced anywhere — yet the container remained empty for the
operator. Multiple row-shape fixes had already been shipped and verified correct against
real engine-written reference rows (`be5081a`, `65dd632`, `c5c486f`), and post-fix fills
still did not appear.

The investigation instrumented `dune.items` with an audit trigger
(`dune.log_item_audit()`, trigger `trg_item_audit`) and proved that the game engine claims
(rewrites) item rows only at **server startup**: two bulk-claim bursts, both at identical
microsecond timestamps across all touched rows (the signature of a single-statement
engine-side sweep), both coinciding with a survival server process start — and no other
claim activity at any other time, including a live leave-and-return test in which the
operator traveled far from the base (forcing the container actor to unload and respawn)
and returned to open the container. Zero engine activity on the unclaimed rows.

**Conclusion:** the engine reads container inventories from Postgres only when the server
starts. Newly inserted rows become visible only after a server restart. There is no
engine-surface mechanism (RCON, RabbitMQ publish, addon API) that forces an inventory
re-read, and the console's `dune admin grant-item-id` RCON path is player-inventory-only.

The fix shipped with this incident is operational rather than code-level: an
"Apply Fills (Restart Survival)" action in the console Storage tab that restarts the
survival server via the existing, allowlisted, session-authenticated
`POST /api/server/restart-service` endpoint, behind a danger-styled confirmation dialog
that warns all connected players will be disconnected — making the previously-silent
restart requirement an explicit, one-click, documented part of the fill workflow.

## Impact

- **Confirmed:** filled items never appeared in-game until a server restart. The operator
  verified the failure repeatedly across multiple containers and fills, including after
  the row-shape fixes, and confirmed appearance only after a restart.
- **Confirmed:** silent failure — the console reported success, the DB row existed, and
  no error signal existed anywhere. An operator cannot distinguish "grant failed" from
  "granted but not yet visible" without instrumentation.
- **Confirmed:** during the investigation, 7 stale rows were manually deleted by the
  operator (visible in the audit log as DELETEs) — the practical cleanup path for
  "invisible" fills before the restart requirement was understood.
- **Reviewed:** no player-facing impact beyond the fills themselves; players were never
  harmed, only not-served. The mitigation (a restart) has a player-facing cost of its own
  (disconnect for a few minutes), which is why the action is gated behind a confirmation
  dialog.
- **Scope note:** give-item-to-storage shares the same in-game visibility symptom per the
  source comment at `duneDb.js` (give-item grants for plain resources were also invisible
  in-game). It likely shares the same startup-only claim mechanism but was not separately
  burst-proven in this investigation.

## Confirmed observations

- An audit trigger (`dune.log_item_audit()`, trigger `trg_item_audit`) was created on
  `dune.items` on 2026-07-31 for this investigation. It captured every INSERT/UPDATE/DELETE
  on the table thereafter (215 audit rows total).
- **Claim burst 1:** 15 rows updated at identical timestamp `2026-07-31 04:40:52.115589+00`
  — a single-statement bulk sweep. The survival server container had restarted at
  approximately 04:40 (`Up 20 minutes` when observed at 05:00), i.e. this burst coincided
  with a server process start.
- **Claim burst 2:** 10 rows updated at identical timestamp `2026-07-31 05:01:44.231955+00`,
  1m45s after the survival server's own boot log began (`04:59:50.30Z`, full boot sequence,
  `Starting server with argv: ... DuneSandboxServer.sh Survival_1` at `04:59:51.02Z`).
  All 9 freshly-filled rows were claimed in this burst. The operator then interacted with
  a claimed item in-game (a MelangeSpice stack bumped 10→20 at `05:04:57Z` — an engine
  UPDATE), confirming the rows became genuinely visible and usable, not merely marked.
- **Live leave-and-return test (negative result):** after burst 2, 4 fresh rows were
  inserted into a container inventory (CopperBar x10, Silicone x5, MelangeSpice x3,
  AluminiumBar x7). The operator traveled to a distant settlement and back (sufficient to
  unload and respawn the base's container actors) and opened the container. **Zero engine
  activity** on those rows at any point — no claim, no visibility. The container showed
  only the previously-claimed rows.
- Between the two bursts, the audit log shows only scattered single-row gameplay writes —
  no bulk claims, i.e. no inventory re-read occurred during normal operation, including
  actor respawns.
- The row-shape fixes (`be5081a`, `65dd632`, `c5c486f`) were verified correct against real
  engine-written rows (including the exact `FItemStackAndDurabilityStats` key shape and
  `DecayedMaxDurability` values) and were confirmed **not** to resolve in-game visibility
  on their own: a post-fix fill remained invisible until the next restart. In-place
  `UPDATE` of stale rows' stats after the fact also did not trigger visibility.
- Every other plausible delivery path was investigated and ruled out for containers:
  `dune admin grant-item-id` (RCON → RabbitMQ `heartbeats` exchange → Funcom Live Services)
  is player-inventory-only and has no container target; the community Airdrop Manager
  addon's container spawn feature is broken against this schema (queries a nonexistent
  `account_id` column) and its orchestration buttons are unimplemented; its sidecar daemon
  uses the same player-only delivery pattern.

## Inferences and limits

- The engine reads container inventory rows from Postgres only when the server process
  starts. This is the only mechanism that explains all observations: two claim bursts,
  both at startup; none at any other time, including a live actor-respawn test.
- Burst 1's startup is not independently corroborable from surviving container logs (the
  previous container incarnation's logs were gone by the time of review); the identical-
  microsecond bulk signature and the container uptime evidence are the basis for
  attributing it to a startup. Burst 2 is directly corroborated by the container's own
  boot log timestamps.
- The absence of engine activity during the leave-and-return test does not by itself prove
  the actor did not respawn — it proves that *whatever* happened on respawn, the inventory
  was not re-read. That is the claim that matters: no respawn-triggered re-read exists, or
  if one exists it does not include unclaimed rows.
- The restart requirement is proven for fill-item rows on this host. Give-item-to-storage
  shares the visibility symptom (source comment in `duneDb.js`) and is presumed to share
  the mechanism, but was not separately burst-proven here.
- The mechanism being engine-internal, a fix that makes new rows visible without a restart
  cannot be built from this side of the trust boundary; the shipped resolution is to make
  the restart an explicit, safe, one-click part of the workflow, and to document it.

## Timeline

All DB timestamps are UTC (Postgres `+00`), matching the audit log. Container times are the
container's own `--timestamps` output (UTC).

| Time (UTC) | Event |
|---|---|
| 2026-07-31 03:59 | First fill-item row inserted into `dune.items` (investigation begins). |
| 2026-07-31 04:00–04:35 | Multiple fills into test containers; audit log captures INSERTs and the operator's in-game gameplay writes. Rows invisible in-game. |
| 2026-07-31 04:35–04:50 | 7 stale rows manually deleted by the operator (cleanup of invisible fills). |
| 2026-07-31 04:40 | Survival server restarted (operator hard-reset of test containers). Container uptime evidence: `Up 20 minutes` at 05:00. |
| 2026-07-31 04:40:52.115589 | **Claim burst 1** — 15 rows claimed by the engine at identical microseconds (startup sweep). |
| 2026-07-31 05:00 | Operator-approved controlled restart (`dune restart survival`) for the decisive test. |
| 2026-07-31 04:59:50.30 | Survival server boot log begins. |
| 2026-07-31 05:01:44.231955 | **Claim burst 2** — all 9 filled rows claimed at identical microseconds, 1m45s after boot start. |
| 2026-07-31 05:04:57 | Operator interacts with a claimed MelangeSpice row in-game (10→20): rows genuinely visible and usable. |
| 2026-07-31 05:11–05:40 | 4 fresh rows inserted into a container (CopperBar x10, Silicone x5, MelangeSpice x3, AluminiumBar x7) — the leave-and-return test subjects. |
| 2026-07-31 05:40–05:55 | Operator travels to a distant settlement and back, opens the container: **rows not visible; zero engine activity on them in the audit log.** Leave-and-return disproven as a trigger. |
| Same session | All prior "live" reconciles re-explained as startup reads (container uptime evidence); restart confirmed as the only trigger. |
| Same session | "Apply Fills (Restart Survival)" console action implemented and tested (web suite 96/96, API suite 836/836); incident documented; CHANGELOG updated. |

## Response analysis

- The decisive tool was instrumentation, not inference: an audit trigger made the engine's
  row-claim timing directly observable, and the identical-microsecond burst signature
  made startup sweeps unambiguous.
- The 04:40:52 burst was initially misread as a live actor-respawn reconcile (a player
  returning to the base had coincided with it). The container uptime evidence corrected
  that reading: it was a startup sweep from the operator's own hard-reset restart. This
  correction is why the leave-and-return test was run properly instead of being accepted
  as already-answered — and why it returned a clean negative.
- The row-shape fixes were not wasted work: they were necessary (the engine refuses rows
  lacking the durability-key shape) but not sufficient. The incident writeup must state
  this relationship explicitly, or a future reader will treat the row-shape work and this
  restart finding as contradictory.
- The resolution deliberately reuses the existing, tested, allowlisted
  `POST /api/server/restart-service` endpoint rather than creating new backend surface:
  the same session-authenticated, CSRF-protected, audit-logged path the Server tab
  already uses for service restarts. The Storage tab action is a workflow completion, not
  new capability.

## Project follow-up

| Item | Current state |
|---|---|
| Prove the visibility mechanism with direct evidence (audit trigger, burst timing) | **Resolved.** INC-2026-07-31-001 evidence above. |
| Provide an explicit, safe "apply fills via restart" workflow in the console | **Resolved.** "Apply Fills (Restart Survival)" button in the Storage tab (danger-styled confirmation, players-disconnect warning, task result surfaced; succeeds/fails/still-running all distinguished). |
| Document the restart requirement for operators | **Resolved.** This incident doc + CHANGELOG entry + in-UI note. |
| Confirm whether give-item-to-storage shares the restart requirement | **Open.** Shares the visibility symptom (source comment in `duneDb.js`); presumed to share the mechanism; not burst-proven separately. Tracked as a follow-up issue. |
| Player-facing restart should warn players first (precedent: scheduled-restart and IP-change flows broadcast a warning via `dune admin broadcast-restart-warning`; the console button does not) | **Open.** Tracked as a follow-up issue (warning-first restart flow for console-triggered restarts). |
| Pre-existing API test flake in `sietchRestartScript.test.js` (fixture mock race on the postgres check; intermittently fails the otherwise-green suite) | **Open.** Unrelated to this incident but surfaced during verification; tracked as a follow-up issue. |

## Closure criteria (all met 2026-07-31)

- ~~The visibility mechanism is proven with direct, reproducible evidence, not inference~~ — **Done.** Audit-trigger bursts + leave-and-return negative result + container-log corroboration.
- ~~The restart requirement is documented where operators will find it~~ — **Done.** Incident doc, CHANGELOG, and Storage-tab UI note.
- ~~A one-click, confirmed, safe apply-restart path exists in the console~~ — **Done.** Storage tab action, tested (web suite 96/96 incl. 6 new tests; API suite green on clean runs — an unrelated pre-existing flake in `sietchRestartScript.test.js` intermittently fails one test and is tracked as a follow-up item; `tsc -b` clean).
- ~~All tests green and CI-clean before the change is considered shipped~~ — **Done** for this fork's checked-in code (see follow-up items for the two open, unrelated issues).

Investigation complete, mitigation shipped, documentation written. **This incident is
resolved for the fill-item path; the two open follow-up items above are tracked as issues.**
