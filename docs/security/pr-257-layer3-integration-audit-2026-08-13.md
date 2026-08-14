# Requirement 20 Layer 3 (Integration) Audit — PR #257

**Date:** 2026-08-13
**PR:** [#257](https://github.com/yacketrj/dune-awakening-selfhost-docker/pull/257) — `feat/128-age-secrets-management`
**Scope:** Full PR diff (11 files) at the point the audit was dispatched (commit `fff0e857`):
`.github/workflows/ci.yml`, `.gitignore`, `.pre-commit-config.yaml`, `CHANGELOG.md`,
`runtime/scripts/lib/secrets.sh`, `runtime/scripts/lib/secrets_aead.py`,
`runtime/scripts/lib/test_secrets_aead.py`, `runtime/scripts/start-postgres.sh`,
`runtime/tests/test-postgres-secrets-upgrade-path.sh`,
`runtime/tests/test-secrets-aead-cross-language.sh`, `runtime/tests/test-secrets-lib.sh`.

**Method:** all eight hats (Principal Software Architect, Principal Security Architect,
Principal GRC, Principal Network Engineer, Principal Cloud Security Engineer, Principal UI
Design/Architect, Principal DBA, Principal QA/Test) were dispatched as independent workers
against the real diff and real files on disk, each required to verify claims against actual
command output rather than trust a shared summary. This is the Layer 3 (integration) audit
required by this account's operating docs before an upstream PR can be opened or a PR marked
ready — it follows Layer 2 (`docs/security/pr-257-layer2-implementation-audit-2026-08-13.md`,
originally recorded in commit `d37254dc`'s message and later transcribed into that committed
findings register) which already found and fixed SEC-1/SEC-2/SEC-3/ARCH-1/ARCH-2/ARCH-3.

## Findings register

| # | Severity | Hat(s) | Finding | Location | Status |
|---|----------|--------|---------|----------|--------|
| 1 | **CRITICAL** | Security Architect, Software Architect (independent reproduction) | `dune_secrets_sync_postgres_password()` passed the Postgres superuser password via `psql -c "ALTER USER ... '...'"`, embedding it as a literal argv element — confirmed live via `/proc/<pid>/cmdline` on both the host `docker exec` process and the `psql` process *inside* the container, for the process's full lifetime. Reproduces GHSA-fc89-h24v-6j3x in the very fix meant to close issue #260. | `runtime/scripts/lib/secrets.sh` (was ~246-258) | **FIXED** — rewritten to pipe SQL via stdin, matching the discipline already used by `secrets_aead.py`. New deterministic regression test using `strace -f -e trace=execve` (a `/proc`-polling approach was tried first and found too racy — a real `ALTER USER` completes in well under 200ms). Verified: fails against the reintroduced vulnerable version, passes against the fix, confirmed live on the production host with zero argv exposure. |
| 2 | MEDIUM | Software Architect | Function's own docstring claimed "heredoc-style" delivery and "never appears via docker inspect/ps" — false, per Finding 1. | `secrets.sh` docstring | **FIXED** — docstring corrected to describe the actual stdin-based mechanism and explicitly warn against reverting to `-c`. |
| 3 | MEDIUM-HIGH | DBA | `start-postgres.sh` suppressed all stderr (`2>/dev/null`) on decrypt failure, silently regenerating/overwriting the encrypted password store even when the real cause was KEK/identity misconfiguration, not a legitimate first run. | `start-postgres.sh` (was line 88) | **FIXED** — now explicitly distinguishes "no `.enc` file yet" (legitimate first-run/generate path) from "file exists but won't decrypt" (real error — fails loudly with `exit 1` instead of silently regenerating). |
| 4 | CRITICAL (audit-trail) | GRC | Issues #258 and #259 were claimed "fixed and live-verified" in PR comments, but remained open on GitHub with zero comments — evidence lived only in the PR thread, unlike #260's fully self-contained trail. | GitHub issues #258, #259 | **FIXED** — both issues updated with full root-cause, fix, and live-verification evidence matching #260's standard, then closed. |
| 5 | HIGH | GRC | `CHANGELOG.md` claimed an operator opts in via a `dune secrets setup` CLI command; the PR body explicitly states that command does not exist yet. Direct contradiction (Requirement 14 documentation-drift). | `CHANGELOG.md` | **FIXED** — corrected to describe the actual (manual, environment-variable-based) opt-in mechanism and explicitly note `dune secrets setup` is a separate, not-yet-implemented deliverable. |
| 6 | MEDIUM | DBA | No explicit rollback/runbook if `ALTER USER` keeps failing after the encrypted store has already been written with a new value — recovery is implicit. | `start-postgres.sh` | **Not fixed in this pass** — tracked as a documented, accepted gap; the failure is loud (exits non-zero) and the retry path is idempotent-safe (re-running with the same stored value is harmless), but no dedicated runbook exists yet. Candidate for a future issue if this proves to be a real operator pain point. |
| 7 | MEDIUM | UI/Design | The FATAL error messages cited an internal GitHub issue number and gave no remediation step for a real self-hosting operator. | `start-postgres.sh` | **FIXED** — both FATAL messages (decrypt failure, sync failure) rewritten with concrete next steps (re-run, check `docker logs`, take a backup) and issue numbers moved to a "for more context" footer rather than being the primary content. |
| 8 | MEDIUM | Network | The new test's `$$`-based resource naming has a narrow orphaned-resource collision surface under `SIGKILL` + PID reuse on long-lived (non-ephemeral) CI runners. | `runtime/tests/test-postgres-secrets-upgrade-path.sh` | **Not fixed in this pass** — GitHub-hosted runners are ephemeral (this risk doesn't apply to this repo's actual CI), and the names can never collide with real deployment resources (`dune-net`/`dune-postgres`). Deferred as a low-priority test-hygiene item, not a live-system risk. |
| 9 | LOW-MEDIUM | QA | The FATAL exit branch inside `start-postgres.sh` itself (as opposed to the underlying library function's own failure return) may lack direct test coverage. | `start-postgres.sh` | **Not fixed in this pass** — the library function's failure path is directly tested (`test-postgres-secrets-upgrade-path.sh` step 5); the wrapping script's exact FATAL-message/exit-code behavior is not separately asserted. Candidate for a future test addition. |
| 10 | LOW | Multiple hats | No new network exposure, no schema/DDL changes (Requirement 26 compliant), correct subshell exit-code/scoping semantics, correct test cleanup on all catchable exit paths, `.gitignore` coverage of new generated artifacts verified empirically. | — | Confirmed clean, no action needed. |

## Verification performed after remediation

- `shellcheck -x` clean on all modified shell files (only a pre-existing, unrelated `SC2034`
  finding remains in `start-postgres.sh`, predating this PR).
- `bash runtime/tests/test-secrets-lib.sh` — 9/9 pass.
- `bash runtime/tests/test-postgres-secrets-upgrade-path.sh` — passes, including the new
  deterministic argv-exposure regression test (Finding 1).
- `bash runtime/tests/test-secrets-aead-cross-language.sh` — pass.
- `python3 -m unittest runtime.scripts.lib.test_secrets_aead` — 18/18 pass.
- Live re-verification on this host's real, production `dune-postgres` container (population
  0/60 throughout): enabled the age backend against the existing data directory, confirmed the
  new password authenticates over the real `dune-net` network, and independently confirmed via
  `strace -f -e trace=execve` that the live sync call produces **zero** argv exposure of the
  password on the actual production host — not just in the isolated test fixture.
- Host restored to its prior clean state and reconfirmed healthy after verification.

## Outcome

Findings 1, 2, 3, 4, 5, and 7 are resolved and verified. Findings 6, 8, and 9 are documented,
accepted, non-blocking gaps for follow-up. Finding 10 confirms multiple areas of the diff have
no issues. PR #257 remains in draft pending resolution of the pre-existing, unrelated `api-tests`
CI failure (tracked separately in issue #245) before it can be merged internally or proceed
toward an upstream PR.
