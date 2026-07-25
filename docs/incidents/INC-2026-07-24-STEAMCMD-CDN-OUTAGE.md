# Incident Case Study: SteamCMD Content-Host Failure

**Incident ID:** INC-2026-07-24-001

**Date:** 2026-07-24

**Status:** Resolved

**Scope:** One self-hosted operator; this is not evidence of a project-wide or Steam-wide outage

## Summary

An operator's Dune: Awakening server fell behind the current dedicated-server build after SteamCMD repeatedly selected a content host that could not be resolved. Containers, listeners, the database, and project heartbeats remained healthy, but players reported that they could not find or join the server.

The update eventually completed through a temporary, operator-managed workaround. The stack was rebuilt and cold-started, and a real player connection was then confirmed from application logs and database state. No player, character, or world data loss was found.

The evidence proves the SteamCMD update failure and the later successful player connection. It does **not** prove that the stale build was the sole cause of the server's absence from Funcom's in-game browser: the recovery changed the server build, container images, and process state together, and no Funcom-side browser data was available.

## Impact

- Player-facing availability was impaired until the update and restart completed.
- The earliest retained failed-update evidence was about 2 hours 49 minutes before confirmed recovery. The actual start of player impact is unknown.
- The running processes continued using their previously loaded binaries; the failed update affected the files needed for the next deployment.
- No database or save corruption was detected.
- An unrelated stale systemd path had also prevented the host's automatic update timer from running for more than 48 hours. That did not cause the Steam content-host failure, but it removed an expected retry and detection path.

## Confirmed observations

- SteamCMD repeatedly selected the same content hostname for the required manifest and failed to download it.
- The hostname returned NXDOMAIN through three independently tested DNS resolvers.
- Repeated directory-service queries returned that hostname as the sole source in the highest-priority class observed by the operator.
- During the failure, the local app manifest recorded a failed update with build ID `0`, update result `7`, and no installed depots.
- After remediation, SteamCMD recorded a nonzero current build, update result `0`, and populated depot metadata.
- After the rebuilt stack started, application travel events, database player state, and continuing population declarations agreed that a real player was connected.
- The auto-update systemd unit referenced a repository path that no longer existed and had failed with `203/EXEC` for more than 48 consecutive hourly runs.

## Inferences and limits

- It is reasonable to suspect that the stale server build contributed to the player-facing problem, because the server recovered after updating. This remains an inference because several recovery actions occurred together.
- The evidence does not establish why Steam's directory service continued returning the unreachable hostname, whether the host was intentionally retired, or whether SteamCMD should have selected a lower-priority source.
- A DuneDocker.app heartbeat proves that the server published a heartbeat to the separate DuneDocker public-directory service. It does not prove availability or discoverability in Funcom's official in-game browser.
- The post-recovery connection confirms that the service was joinable by that player. It does not independently prove general public browser visibility at a specific time.

## Timeline

All times are UTC. Operator-specific identifiers and paths are omitted.

| Time | Event |
|---|---|
| 15:21 | Earliest retained evidence of a failed update. SteamCMD selected one content host in the highest observed priority class and could not retrieve the manifest. |
| 15:21 onward | Repeated attempts failed against the same host. |
| During triage | The local app manifest showed a failed update and the installed server was behind the available Steam build. |
| During triage | The separate stale-path failure of the hourly systemd update timer was discovered. |
| 17:47 | A temporary, host-local workaround allowed the manifest request and update to proceed. |
| 17:49 | SteamCMD completed the download and verification; the app manifest recorded a successful current build. |
| 17:56 onward | The stack was rebuilt and cold-started using the updated server files. |
| 18:10 onward | Travel events, database state, and population declarations confirmed a sustained player connection. |

## Response analysis

The initial internal checks were useful but incomplete. They established that local infrastructure was alive; they could not establish that the server was current, visible in Funcom's browser, or joinable from a game client. The player reports therefore remained actionable even while those checks were green.

The investigation ruled out general disk exhaustion, a general DNS outage, and a missing SteamCMD executable. A plain hosts-file redirect to a different CDN address was also rejected by TLS hostname verification, as expected.

The successful emergency workaround used a temporary local TLS-intercepting proxy and temporary local trust changes. This created two TLS sessions and terminated SteamCMD's TLS connection locally; it was not end-to-end TLS from SteamCMD to Valve. The proxy, host override, and local CA trust were removed when the container was recreated, and their absence was verified afterward.

That technique is recorded only as historical incident context. It must not be automated or treated as a supported project recovery procedure: changing a trust store and intercepting TLS weakens the container's trust boundary, is brittle, and could conceal malicious redirection. The safe default is to retry later, retain diagnostic evidence, and escalate persistent content-host failures to Steam/Valve through an appropriate support channel.

## Project follow-up

The report was reviewed against release `v1.3.65`, which includes the update safeguards introduced in commit `7b335c5`.

| Item | Current state |
|---|---|
| Identify Steam DNS/content-host failures separately from install-directory or stale-manifest failures | **Implemented in v1.3.65.** The updater parses only newly added Steam content-log entries and reports the selected hostname, source priority class, and download-interface count when available. |
| Retry transient content-host failures safely | **Implemented in v1.3.65.** Content-host failures expand the attempt limit to six by default and use increasing delays capped at 120 seconds. The updater does not delete the app manifest for this failure class. SteamCMD still controls source selection; the project does not claim or force CDN failover. |
| Diagnose stale systemd project paths | **Implemented in v1.3.65.** `dune update auto status` and `dune doctor` warn about mismatched or missing working directories, an `ExecStart` from another checkout, and an active auto-update timer whose saved preference is disabled. Re-enabling auto updates rewrites the unit for the current checkout. |
| Compare local and remote Steam builds | **Available.** `dune update check` reports local and remote build IDs and whether an update is available. This is an update-status check, not proof of Funcom browser visibility. |
| Detect persistent timer failures without an operator running status or doctor | **Open.** External monitoring or alerting for repeated systemd failures remains deployment-specific. |
| Verify Funcom in-game browser discoverability externally | **Open.** No supported public signal was established during this incident. DuneDocker listing heartbeats must not be used as a substitute. |

Relevant focused regression tests are:

- `tests/steamcmd-signals-test.sh`
- `tests/update-systemd-timer-health-test.sh`

## Operational guidance

For a similar update failure:

1. Preserve the SteamCMD output and the new portion of its content log.
2. Run `dune update check` to compare the installed and available builds.
3. Run `dune update auto status` and `dune doctor` to inspect automation and systemd paths.
4. Retry with the normal updater. The content-host retry path is safe and does not modify player or world data.
5. If failures persist, report the observed hostname, source-priority information, timestamps, and network cell through an appropriate Steam/Valve support channel. Present them as observations, not a confirmed Steam defect.
6. Do not bypass TLS verification, install a replacement CA, or redirect Steam traffic as a routine fix.

## Closure criteria

- SteamCMD completed the server update and recorded a valid installed build.
- Updated images were built and the stack started successfully.
- A real player connection was corroborated by application and database evidence.
- No data loss was identified.
- Temporary interception components and trust changes were absent after recovery.
- Project-side content-host retry and timer-path diagnostics are covered by focused tests.

The operational incident is closed. Attribution of the earlier Funcom-browser behavior remains an inference rather than a confirmed root cause.
