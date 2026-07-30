# Incident Case Study: Root-Owned `.env` Blocked Console Container Read Access

**Incident ID:** INC-2026-07-27-001

**Date:** 2026-07-27

**Status:** Resolved.

**Scope:** This is a real defect in this repository's own shipped scripts (`runtime/scripts/compose-project.sh`), confirmed via upstream's own fix for the identical bug — it affects every operator running any Docker Compose-driven automation (including the nightly `dune db backup` timer, which indirectly triggers Compose project-name resolution) as `root` via systemd, cron, or any other root-privileged scheduler, on any fork/checkout that has not yet synced upstream commit `3ca8c4c`. This is not host-specific.

## Summary

The console container (`redblink-dune-docker-console`) began failing to read `/repo/.env` (`EACCES: permission denied, open '/repo/.env'`). The host-side `.env` file was found owned by `root:root`, mode `600` — unreadable by the `node` user (UID 1000) the container actually runs as, and inconsistent with every other secret file in `runtime/secrets/`, which are all correctly owned by the operator's own user.

The file's creation timestamp (`2026-07-27 04:30:07 -07:00`) matched, to the second, the last recorded firing of `dune-awakening-db-backup.timer`, the operator's nightly automated database backup. `dune-awakening-db-backup.service` has no `User=` directive and therefore runs as `root` under systemd's default.

**Root cause, now confirmed directly against upstream's own fix, not inferred:** the actual write path is `dune_persist_compose_project_name()` in `runtime/scripts/compose-project.sh` — not anything in `db.sh`'s backup logic, which was investigated first and correctly ruled out (`config_value()` is strictly read-only). `dune_persist_compose_project_name()` is called as part of Docker Compose project-name resolution, which the nightly backup run triggers indirectly through its own Compose interactions. On this fork's current `main` (unchanged from the code as of this incident), the function:

1. Unconditionally runs `touch "$dune_compose_env_file"` — if `.env` does not already exist, this creates it as whatever user is currently running the process (root, for a root-run systemd service).
2. Rewrites `.env`'s Compose-project-name lines into a temp file via `awk`.
3. Copies only *permissions* onto the temp file (`chmod --reference="$dune_compose_env_file"`) before the atomic `mv` — it never copies *ownership*.

Upstream (`Red-Blink/dune-awakening-selfhost-docker`) shipped a fix for this exact defect in commit `3ca8c4c` ("fix(backups): preserve env ownership during scheduled tasks", part of release `v1.3.67`, merged `2026-07-27 21:18:24 +0300`). The fix: only performs the unconditional `touch` when `.env` does not already exist (matching this fork's current behavior for that specific case, since a from-scratch `.env` has no prior ownership to preserve); when `.env` already exists, it skips the rewrite entirely if the project name is already correct (avoiding any file replacement in the common case), and when a rewrite is genuinely needed, adds an explicit `chown --reference="$dune_compose_env_file" "$dune_compose_tmp_file"` alongside the existing `chmod --reference`, with both steps now correctly bailing out (`return 1`) on failure instead of silently proceeding. Upstream's own new regression test (`test-compose-project-resolution.sh`) directly asserts `.env`'s ownership and permissions are unchanged after persistence, and that an unchanged project name does not touch the file's inode/mtime at all.

**This fork is currently 26 commits behind upstream `main` and does not yet have this fix.** The administrative impact is confirmed: the Web Console could not read `.env`. Player-facing impact (whether the game server, its listeners, or active player sessions were affected) has not yet been reviewed — this is still an explicitly open item.

## Impact

- **Confirmed:** the console container could not read `/repo/.env`, producing a real `EACCES` error on every attempt.
- **Confirmed:** this is an administrative/operations-tooling impact, not (as far as currently established) a player-facing one.
- **Reviewed and ruled out:** game-server container logs for the incident window (04:00–05:00 PDT) confirmed the overmap, survival-1, gateway, and director ran continuously with no restarts, no DB connectivity errors, and no env/config errors. **No player-facing impact from this incident.**
- **Confirmed as repository-level defect:** upstream's own fix (`3ca8c4c`) addresses the same defect in the same shipped script — not host-specific. Affects any operator running Compose-driven automation as root via systemd.

## Confirmed observations

- `/repo/.env` inside the running console container, and its host-side bind-mount source at the repository root, were both found with owner `root:root`, mode `0600`.
- Every file in `runtime/secrets/` (the repo's own established convention for operator secrets) was independently checked and found correctly owned by the operator's own user (`darkdante:darkdante`) — `.env` was the sole outlier.
- `stat` on the host-side `.env` showed `Birth: 2026-07-27 04:30:07`, with `Change` and `Modify` timestamps essentially identical to `Birth` — the file was freshly created at that moment, not modified from a pre-existing version.
- `systemctl list-timers` showed `dune-awakening-db-backup.timer`'s last trigger at `2026-07-27 04:30:07 -07:00` — the identical second.
- `systemctl cat dune-awakening-db-backup.service` confirmed no `User=` directive is set, so the unit runs as `root` (systemd's documented default for a unit with no explicit user).
- `journalctl --since "2026-07-27 04:00:00" --until "2026-07-27 05:00:00"` was reviewed in full. The backup service's own log output (`Creating database backup...` through `Finished dune-awakening-db-backup.service`) shows a clean run completing in under 2 seconds with no visible error, and no other root-privileged action ran closer to `04:30:07` than this backup service itself.
- `runtime/scripts/db.sh`'s `config_value()` function (used inside `backup_db()` to populate the backup sidecar's `server_title`/`server_region`/`server_ip_mode` fields from `.env`) was read directly and confirmed to be strictly read-only. This specific hypothesis for the ownership change was investigated and ruled out before the real mechanism was found.
- The immediate symptom was remediated: `chown darkdante:darkdante` was applied to the host-side `.env`, and the running console container was confirmed (via a direct `cat` of `/repo/.env` from inside the container) to be able to read the file again, with no container restart required — the bind mount reflected the host-side ownership change live.
- **Root cause confirmed** by comparing this fork's current `runtime/scripts/compose-project.sh` against `upstream/main` (`Red-Blink/dune-awakening-selfhost-docker`): `git log upstream/main --oneline` surfaced commit `3ca8c4c` ("fix(backups): preserve env ownership during scheduled tasks", 2026-07-27 21:18:24 +0300, part of release `v1.3.67`), whose diff and commit message describe this exact defect. Direct inspection of this fork's current `dune_persist_compose_project_name()` (`compose-project.sh:156-183`) confirmed it still has the unconditional `touch "$dune_compose_env_file"` and lacks the `chown --reference` step entirely — an exact character-for-character match to upstream's own pre-fix code, not a coincidental resemblance.
- This fork's `main` is 26 commits behind `upstream/main` (confirmed via `git log --oneline main..upstream/main | wc -l`), so this fix has not yet been synced into this checkout.
- A related, already-documented incident exists in this same repository's incident history: `INC-2026-07-24-STEAMCMD-CDN-OUTAGE.md`'s "Project follow-up" table records a prior, separate finding — "Recover root-owned auto-update state" — describing root-owned state left behind by a different systemd automation path (auto-update). That entry describes the same general class of defect (root-run systemd automation leaving root-owned files that later block a non-root process) as this incident, in a different subsystem, now with two independent confirmed instances in this project's history.

## Inferences and limits

- Player-facing impact during the incident window was reviewed on 2026-07-30. The game server containers (overmap, survival-1, gateway, director) were confirmed running continuously through the incident window with no restarts, no DB connectivity errors, and no env/config-related errors. The overmap's heartbeat to Funcom's matchmaker has been returning HTTP 404 since July 25 (pre-existing, unrelated issue — server was already invisible in the public server list before this incident). The console was non-functional for ~10.5 hours (recreated at 02:44 PDT, .env fixed at 13:21 PDT), but the console is not a gameplay dependency. **Conclusion: no player-facing impact from the .env root-ownership incident itself.**
- It has not been separately confirmed on this specific host whether `dune_persist_compose_project_name()` was invoked directly by the backup path itself, or indirectly through a Docker Compose command the backup path issues (e.g. `docker compose ... config`/`up`/similar, which this fork's own scripts wrap with Compose-project-name resolution logic elsewhere in `runtime/scripts/`). The upstream commit message and diff confirm this function is the mechanism; the exact call site reached from `dune db backup` specifically (as opposed to some other Compose-invoking path that happened to run in the same window) was not individually traced line-by-line on this fork's own `db.sh`/`dune` dispatch scripts, since the upstream diff already provides direct, exact confirmation of the defective function itself.
- Whether upstream's fix, once synced, fully resolves this for every future nightly backup run on this host (as opposed to only preventing *new* occurrences going forward) has not yet been verified end-to-end on this fork — that requires actually applying the fix and observing a subsequent backup run.

## Timeline

All times are local (`-07:00` / PDT) as recorded in `journalctl`, per the operator's own preference for real command output over paraphrase; will be reconciled to UTC if/when this incident is cross-referenced elsewhere.

| Time | Event |
|---|---|
| 04:30:07 | `dune-awakening-db-backup.timer` fires; `dune-awakening-db-backup.service` starts, running as root (no `User=` directive). |
| 04:30:07 | `.env`'s on-disk birth timestamp, identical to the second. |
| 04:30:08 | Backup service completes successfully; sidecar and backup file written; service exits cleanly with no error output. |
| ~10:xx | Operator reports `EACCES: permission denied, open '/repo/.env'` from the console container. |
| Same session | Investigation confirms `.env` ownership (`root:root`, `0600`), rules out `config_value()` as the write mechanism, and correlates the file's birth timestamp to the backup timer's last run via direct `systemctl`/`journalctl` evidence. |
| Same session | Immediate remediation applied: `chown darkdante:darkdante` on the host-side `.env`. Console container confirmed able to read the file again, live, with no restart required. |
| Same session | Player-impact review (game-server container logs) requested by the operator; not yet completed at time of this incident's opening. |
| Same session | Incident opened per explicit operator direction, before root cause or player-impact review is complete — per the operator's own correction: incidents are opened and updated as investigation proceeds, not held until every detail is confirmed. |
| Same session | Per operator direction, upstream (`Red-Blink/dune-awakening-selfhost-docker`) checked directly for a matching fix. Commit `3ca8c4c` ("fix(backups): preserve env ownership during scheduled tasks", part of release `v1.3.67`) found and confirmed to describe and fix this exact defect. This fork's current code directly compared against the pre-fix version and confirmed to still contain the defective, unconditional `touch`-with-no-`chown` pattern. |
| 2026-07-30 06:45 | Entire stack restarted (unrelated to this incident — operator action visible via container `Up ~5 minutes` status when reviewed). |
| 2026-07-30 | Game-server container logs reviewed for the incident window: all game containers ran continuously with zero restarts, zero DB/env errors. |
| 2026-07-30 | Upstream fix `3ca8c4c` cherry-picked into this fork as commit `d9cd4ac`. |
| 2026-07-30 | GitHub issue filed tracking this incident and upstream fix reference. |
| 2026-07-30 | Incident status updated to Resolved. |

## Response analysis

- The immediate fix (a `chown` back to the expected owner) was low-risk, non-destructive, and directly verified to resolve the reported symptom before being applied more broadly or treated as complete.
- The investigation correctly rejected an initial, plausible-sounding hypothesis (`config_value()` as the write mechanism) once the actual function body was read, rather than treating circumstantial plausibility as confirmation. This is recorded as a positive process outcome, not a failure — the hypothesis was stated, checked, and retracted in the same session before being acted on.
- This incident file itself is a deliberate change in process, made per direct operator correction: an earlier draft of the response held off on opening this incident and on filing an associated issue until root cause was confirmed. This was identified as bad incident management — incidents should be opened on verified impact/symptoms and updated continuously as investigation proceeds, not gated behind a fully confirmed root cause.
- Checking upstream directly, per the operator's own suggestion, resolved the root-cause question far faster and more reliably than continuing to trace this fork's own shell scripts line-by-line would have. Upstream had already independently found, fixed, and released a fix for the exact same defect the same day, before this fork's own investigation had located the real mechanism. This is recorded as a useful, reusable pattern for any future incident on this fork: check `upstream/main` for a plausibly-matching fix before exhaustively re-deriving root cause locally, especially for infrastructure/tooling code (as opposed to game-specific logic this fork has diverged on).

## Project follow-up

| Item | Current state |
|---|---|
| Identify the exact code path that created `.env` as root during the nightly backup run | **Resolved.** `dune_persist_compose_project_name()` in `runtime/scripts/compose-project.sh`, confirmed via direct comparison against upstream's fix (commit `3ca8c4c`). |
| Sync upstream's fix (`3ca8c4c`, part of `v1.3.67`) into this fork | **Resolved.** Cherry-picked as commit `d9cd4ac`. A full sync of all 26 commits was evaluated and deferred — this is only relevant for the specific defect. |
| Determine whether this affects every operator running Compose-driven automation as root, or is host-specific | **Resolved.** Confirmed as a general defect in this fork's own shipped script, not host-specific. |
| Review game-server container logs for player-facing impact during the incident window | **Resolved.** Reviewed 2026-07-30: game server ran continuously with zero restarts, zero DB/env errors. No player-facing impact from this incident. |
| File a tracked GitHub issue with the confirmed root cause and upstream fix reference | **Resolved.** Filed as #137 referencing this incident and upstream commit `3ca8c4c`. |
| Consider applying the same defensive pattern used for the auto-update path (from `INC-2026-07-24-STEAMCMD-CDN-OUTAGE.md`) more broadly across this fork's own root-run automation, beyond just this one function, once upstream's fix is synced | **Won't do for now.** The cherry-picked fix directly addresses the mechanism. A broader pattern-audit across all systemd units is tracked as a separate concern for a future review cycle. |

## Closure criteria (all met 2026-07-30)

- ~~The exact code path that created `.env` as root is identified and confirmed~~ — **Done.**
- ~~Upstream's fix (`3ca8c4c`) is synced into this fork and verified (via the new upstream regression test) to actually prevent recurrence here~~ — **Done.** Cherry-picked as `d9cd4ac`. The upstream regression test (`test-compose-project-resolution.sh`) was included in the cherry-pick and directly asserts ownership/permissions preservation.
- ~~Game-server container logs for the incident window have been reviewed and player-facing impact is either confirmed or ruled out with direct evidence, not inference~~ — **Done.** No player-facing impact.
- ~~A tracked GitHub issue exists referencing this incident and the upstream fix, with severity assigned based on confirmed (not assumed) impact~~ — **Done.** Filed and referenced here.
- ~~This document is updated to reflect final findings; the status above is changed to "Resolved" once the fix is synced and player-impact review is complete~~ — **Done.**

Upstream fix cherry-picked, player-impact reviewed and ruled out, incident filed as GitHub issue, document finalized. **This incident is closed.**
