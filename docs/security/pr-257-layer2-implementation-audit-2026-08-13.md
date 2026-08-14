# Requirement 20 Layer 2 (Implementation) Audit — PR #257

**Date:** 2026-08-13
**PR:** [#257](https://github.com/yacketrj/dune-awakening-selfhost-docker/pull/257) — `feat/128-age-secrets-management`
**Fix commit:** `d37254dc`
**Scope:** the actual implementation code as it existed after the initial feature commit
(`30d622c8`) — `runtime/scripts/lib/secrets.sh`, `runtime/scripts/lib/secrets_aead.py`,
`runtime/scripts/lib/test_secrets_aead.py`, `runtime/scripts/start-postgres.sh`,
`runtime/tests/test-secrets-aead-cross-language.sh`, `runtime/tests/test-secrets-lib.sh`.

This document exists to close a gap identified by the later Layer 3 audit (see
`docs/security/pr-257-layer3-integration-audit-2026-08-13.md`, GRC finding on evidence-trail
integrity): the Layer 2 findings were originally recorded only in commit `d37254dc`'s commit
message, not as a committed, independently-discoverable findings register document. This file
reproduces that record in the durable, indexed form Requirement 20 actually requires. No new
analysis was performed to produce this document — it is a faithful transcription of the
original audit's findings and verification evidence, sourced from `git show d37254dc`.

## Findings register

| # | Severity | Finding | Fix | Verification |
|---|----------|---------|-----|---------------|
| SEC-3 | **CRITICAL** | `secrets_aead.py`'s CLI took the KEK/DEK/plaintext as command-line arguments — reintroducing the exact GHSA-fc89-h24v-6j3x exposure class this whole initiative exists to eliminate, relocated from `docker inspect` to `/proc/<pid>/cmdline`. Reproduced directly: `python3 secrets_aead.py encrypt <key> <secret> &` followed by `cat /proc/<pid>/cmdline` showed both the key and plaintext in full, for the process's entire lifetime. | `secrets_aead.py`'s `encrypt`/`decrypt` subcommands now read key-hex + value exclusively from stdin (two newline-separated lines), never from argv. `printf` is a shell builtin, not a separate process, so nothing in the calling chain (`secrets.sh`'s `_dune_secrets_aead_encrypt`/`_dune_secrets_aead_decrypt` wrappers) ever writes secret material to any process's own argv. | Re-verified the fix closes the exposure with the same `/proc/<pid>/cmdline` reproduction method used to find it. New permanent regression coverage: `test_secrets_aead.py`'s `CliArgvExposureRegressionTests` spawns the real CLI as a subprocess and inspects its live `/proc/<pid>/cmdline` while running, asserting the secret is never present. Proven to actually catch a regression: reverted the CLI to the old argv-based pattern, confirmed the new tests fail, restored the fix, confirmed 18/18 pass again. |
| SEC-1 | HIGH | `start-postgres.sh`'s cleanup (`rm -f` on the rendered plaintext password file) ran as the last line of the script, *after* `docker run`. Under `set -euo pipefail`, a failing `docker run` aborts the script before cleanup is ever reached, orphaning the plaintext password on disk indefinitely. Reproduced directly: rendered a secret file, forced a subsequent command to fail, confirmed the file survived the script's abort. | `trap 'rm -f "$postgres_superuser_password_render"' EXIT` registered immediately after the file is rendered, before `docker run` is ever invoked — fires on every exit path (success, failure, signal). | Re-verified via the same reproduction: the file is now removed even when the script aborts mid-way. (Note: this specific `EXIT` trap was later found to have its own critical flaw against a live, running container — see issue #258 and the Layer 3 audit register — and was subsequently removed entirely in favor of cleanup-at-next-invocation-start, per commit `d82553f9`. This table entry describes the state as of the Layer 2 audit only.) |
| ARCH-3 | HIGH | No locking around the render-write → `docker-run` → cleanup sequence. Two overlapping `dune restart` invocations could race on the shared render-file path, causing one instance's container to bind-mount another's password, or one instance's cleanup to delete the file out from under another mid-setup. Reproduced with two concurrent flock-less writers to the same path: genuinely interleaved/inconsistent reads. | The entire KEK-read/generate → render → `docker-run` → cleanup block wrapped in `( flock -x 9; ... ) 9>runtime/generated/.pg-superuser-password.lock`. | Re-verified with two concurrent flock'd instances: fully serialized, zero interleaving, confirmed via timestamped acquire/release logging. |
| ARCH-2 | MEDIUM | `_dune_secrets_atomic_write` had zero direct test coverage — only exercised indirectly via `dune_secrets_write_secret`'s happy path. | Added test 8 to `test-secrets-lib.sh`: calls `_dune_secrets_atomic_write` directly against an unwritable target directory, asserts a clean non-zero exit, no torn/partial final file, and no orphaned `.tmp` file left behind. | Test added and passing as part of the 8/8 (at the time) `test-secrets-lib.sh` suite. |
| SEC-2 | LOW | `start-postgres.sh`'s comment implied `umask 077` also tightened `runtime/generated/`'s own directory permissions; it only affects the rendered file's mode (explicitly `chmod 600`'d regardless of umask). | Corrected the comment to state the actual security boundary (file mode, not directory mode) accurately. | Documentation-only fix; no behavior change. |
| ARCH-1 | — | Audited and confirmed already safe, no fix needed: `set -euo pipefail` correctly aborts `secrets.sh`/`start-postgres.sh` on any write failure before an undefined password variable could be used further. | N/A — no fix required. | Reproduced by making the target directory unwritable and confirming a clean, immediate abort at the failing `mktemp` call. |

## Additional note recorded at the time

`test-secrets-aead-cross-language.sh`'s Python-side calls were updated to use the new stdin
protocol; the Node-side calls in that same file remained argv-based at the time, flagged as a
known, accepted asymmetry (test-only code proving cross-language format compatibility, not a
production secret path) rather than silently fixed beyond this PR's actual production code
scope.

## Verification performed (all via real execution, per the original commit message)

- `test_secrets_aead.py`: 18/18 pass (16 original + 2 new argv-exposure regression tests).
- `test-secrets-aead-cross-language.sh`: passes with the updated stdin protocol.
- `test-secrets-lib.sh`: 8/8 assertions pass (7 original + the new atomic-write failure test),
  5/5 consecutive clean runs.
- `shellcheck -S warning`: clean on every shell file (one pre-existing, unrelated `SC2034`
  warning confirmed via `git stash` comparison to predate this change).
- `semgrep --config auto`: 0 findings across all 6 changed files.
- `gitleaks`: 0 findings on every individual changed file.
- Directly proved `CliArgvExposureRegressionTests` catches a real regression by temporarily
  reverting to the vulnerable CLI pattern and confirming those specific tests fail, then
  restoring the fix.

## Relationship to later findings

SEC-1's fix (an `EXIT` trap) was itself found to have a critical flaw when tested against a
real, running production container — deleting a bind-mounted file's host-side source while
the mount is still active corrupts Docker's own archive/`docker cp` mechanism for the entire
container. This was **not caught by this Layer 2 audit**, because Layer 2 testing did not
include live verification against an already-running container with an active bind mount —
it was caught during subsequent live testing and is tracked as issue #258, with its own fix
and findings recorded in `docs/security/pr-257-layer3-integration-audit-2026-08-13.md`. This
is noted here explicitly as a real limitation of Layer 2's scope (implementation-level
correctness) versus what only live, Layer 3-style integration testing against a real running
system can catch — consistent with this account's own operating principle that different
audit layers catch different classes of defect, and neither substitutes for the other.
