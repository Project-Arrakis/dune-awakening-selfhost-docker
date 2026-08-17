# Shared Age-Based Secrets Library — Requirement 20 Eight Hats Findings Register

**Feature:** shared, credential-agnostic age-based secrets library (`runtime/scripts/lib/secrets.sh`, `secrets_aead.py`) — stage 1 of a multi-PR split of upstream PR #153
**Internal tracking:** fork issue #281 (supersedes stale fork PR #265)
**Upstream PR:** `Red-Blink/dune-awakening-selfhost-docker#160`
**Date:** 2026-08-15

This document is the evidence artifact Requirement 20 requires: every layer's findings, their severity, and their resolution status, committed under version control rather than left in chat history alone.

---

## Layer 1 — Design

No standalone L1 design document was written specifically for this stage before code was first drafted (the broader unified age-secrets design already exists in the `Arrakis-Project` meta-repo, `docs/design/unified-age-secrets-management-l1-design-2026-08-13.md`, and this stage implements a subset of it). The decision to split this out as a library-only, zero-call-site stage was made in direct response to real, quoted upstream maintainer feedback on PR #153 (see the PR body for the exact quote) — not an internally-generated design decision, but externally directed scope reduction, which is itself a form of Layer 1 review by the eventual reviewer.

---

## Layer 2 Audit — Implementation (before first draft submitted anywhere)

Findings and resolution, from the internal implementation-audit round conducted while building this library (referenced in commit `b2f9a35a`'s own message):

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | **CRITICAL** | RCE via unsafe Python `-c` string interpolation: `_dune_secrets_atomic_write`'s fsync helper built a secret-name-derived path directly into a `python3 -c` script's source text; a name containing a single quote plus Python syntax would execute arbitrary code. | **Resolved.** Path passed as a real subprocess argument (`sys.argv[1]`), never interpolated into the script text. |
| 2 | HIGH | Path traversal: no validation on secret `<name>` before it was used to build a filesystem path — a name like `../../../etc/evil` could escape `runtime/secrets/` entirely. | **Resolved.** `_dune_secrets_validate_name()` enforces a conservative allow-list (lowercase letters, digits, single hyphens), called by every path-building function. |
| 3 | MEDIUM | Permanent umask leak: `dune_secrets_render_plaintext_file()`'s `umask 077` had no restore, permanently changing the *calling* script's umask for the rest of its execution the moment this library was sourced once. | **Resolved.** Caller's umask saved before, restored after. |

---

## Layer 3 Audit — Integration (against the assembled branch, before this PR was opened)

Dispatched: 4 independent Task-tool agents (Security Architect, Software Architect, GRC, QA/Test) against `upstream-pr/269-secrets-library-only-v2` at commit `ff4fb501`, before either the internal (fork `main`) or upstream PR was opened — applying the process lesson learned from `dune db backup-system`'s review (that PR's audit happened reactively, after it was already open).

| # | Hat | Severity | Finding | Resolution |
|---|---|---|---|---|
| 1 | Software Architect | **CRITICAL** | `dune_secrets_write_secret()` silently reported success (exit 0) while writing a corrupt, empty `enc:v2:1::` line to the real secret path if DEK generation or AEAD encryption failed — every step (`dek=...`, both `_dune_secrets_aead_encrypt` calls, `_dune_secrets_atomic_write`) had its exit status discarded, unlike the read path, which correctly checked its own decrypt call. | **Resolved.** Every step now explicitly checked, matching the read path's own convention. `_dune_secrets_atomic_write` itself was also fixed to check every one of its own operations (mkdir, mktemp, write, chmod, fsync, rename) instead of assuming success. |
| 2 | Software Architect | **HIGH** | The in-process KEK cache (`_DUNE_KEK_HEX`/`_DUNE_KEK_LOADED`) was completely non-functional: both real call sites invoked `dune_secrets_load_kek` via `$(...)` command substitution, which forks a subshell whose cache updates never propagate back to the caller. Measured: 6 secrets migrated in one process cost 6 full `age --decrypt` invocations, not the 1 the design intends. | **Resolved.** Both call sites now call `dune_secrets_load_kek` as a plain statement, then read the decrypted value from the correctly-populated `$_DUNE_KEK_HEX` global. Verified directly: 6-secret migration now costs exactly 1 `age` invocation, all 6 secrets still round-trip correctly. |
| 3 | QA/Test | **HIGH** | `runtime/tests/test-secrets-lib.sh`'s "Test 4" claimed to cover "wrong age identity fails to decrypt the KEK," but the secret name it read had no `.enc` file yet at that point in the script — `dune_secrets_read_encrypted` short-circuits on its own missing-file check before ever calling `dune_secrets_load_kek`, so the claimed failure path was never actually exercised. Proven via mutation testing: replacing `dune_secrets_load_kek`'s real `age --decrypt` call with a hardcoded dummy KEK — a complete identity-verification bypass — passed the entire existing suite undetected. | **Resolved.** Test rewritten to write a real secret under the correct identity first, then switch to the wrong identity and read that same, now-existing secret, so the `.enc` file genuinely exists and the `age --decrypt` call is the thing that actually fails. Confirmed the fixed test now produces the real "failed to decrypt DUNE_KEK_FILE" stderr message. |
| 4 | Security Architect | MEDIUM | Silent truncation of secret values containing an embedded newline through the shell↔Python stdin protocol — `_read_two_stdin_lines` fails silently (exit 0) on a multi-line value, dropping everything after the first newline. Zero current impact (no wired-in secret today has this shape), but a real latent gap for a future caller (e.g. a multi-line credential like a TLS private key). | **Accepted as documented limitation, not fixed in this stage.** No credential is wired to this library yet, so this cannot cause data loss today. Flagged for whichever future stage first wires a credential whose value could plausibly contain a newline. |
| 5 | Security Architect | LOW | No length limit on secret `<name>` — an extremely long name passes validation, then fails deep inside `mktemp` with a raw, unfriendly OS error instead of a clean library-level rejection. No security impact (no torn state), purely a UX/robustness gap. | **Not fixed in this stage** — no current caller could plausibly hit this; flagged for awareness. |
| 6 | Software Architect | LOW | CI step installed `age`/`cryptography` explicitly but relied on `pytest` being present implicitly, assumed (incorrectly, per the finding's own hedge) to ship as part of the GitHub Actions runner image's default toolchain. | **Confirmed as a real regression on this PR's own first live upstream CI run** (`No module named pytest`, failing `runtime-script-unit`) — the LOW prediction was correct and should have been fixed before this PR was ever opened, not left as a documented risk. Fixed post-hoc, immediately, once the real failure was observed: `pytest` now installed explicitly alongside `cryptography`. |
| 7 | Software Architect | LOW | `secrets.sh`'s own `set -euo pipefail` at the top of the file executes in the *caller's* shell when sourced, permanently changing the caller's error-handling options — matches this repo's own existing precedent for sourced libraries (e.g. `runtime-env.sh`), not a novel inconsistency. | **Accepted as consistent with existing repo convention**, not fixed. |

**Note on Finding 6:** this is a direct, concrete instance of Requirement 20's core rationale — a finding correctly identified during audit but not acted on before submission became a real, observed CI failure on the actual upstream PR. Recorded here explicitly as a process lesson: a LOW finding with a stated, unverified assumption ("GitHub's runner images ship X") should be either verified directly or fixed defensively before submission, not left as a documented risk to be discovered by CI.

---

## Layer 3 Audit — Round 2 (upstream maintainer review of PR #160)

**Source:** live review comment from the upstream maintainer (`Red-Blink`) on `Red-Blink/dune-awakening-selfhost-docker#160`, 2026-08-15, after the Layer 2/3 audit above was already merged and CI was green. An external, independent review — exactly the kind of verification the internal Layer 3 round above cannot substitute for on its own.

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | **HIGH** | `dune_secrets_read_secret()` (the one function real callers actually use) invoked `dune_secrets_read_encrypted()` via `$(...)` command substitution, forking a subshell whose KEK cache population never propagated back — the exact same class of bug as Round 1 Finding 2, but one call site deeper, missed because that finding's fix and regression test only verified the lower-level functions call each other correctly, not that the KEK cache actually works *through* the public function real callers use. | **Resolved.** `dune_secrets_load_kek` now called as a plain statement inside `dune_secrets_read_secret` itself, before the subshell-forking call. New regression test counts real `age` invocations through `dune_secrets_read_secret` specifically (via a PATH-shadowing wrapper around the real `age` binary): confirmed 1 real call across 5 reads in the same shell, not 5. |
| 2 | **HIGH** | Once a secret's `.enc` file exists, a decryption failure (wrong KEK, corrupted ciphertext) silently fell back to whatever plaintext still sat at the legacy path — invisible to the caller, defeating the entire point of migrating the secret. Legacy fallback should be limited to a secret that was never migrated at all. | **Resolved.** `dune_secrets_read_secret` now fails closed (returns 1, prints nothing) whenever a `.enc` file exists but fails to decrypt. `runtime/tests/test-secrets-lib.sh`'s Test 4 (which previously asserted the OLD, now-incorrect silent-fallback behavior) rewritten to assert the new fail-closed behavior instead. |
| 3 | **HIGH** | The AEAD ciphertext was not bound to the secret name or format/version using associated data (AAD) — a complete `.enc` file's content could be copied over a *different* secret's `.enc` path and would still authenticate successfully under the wrong name, since nothing in the ciphertext format itself is tied to which secret it's supposed to belong to. | **Resolved.** `secrets_aead.py`'s `encrypt`/`decrypt` (and the CLI's stdin protocol) now take an AAD parameter, bound into the AEAD auth tag but never encrypted. `secrets.sh` passes `enc:v2:<key-version>:<secret-name>` as AAD on both the DEK-wrap and payload encryption steps, computed identically on the read side using the key-version actually present in the file being read. New coverage: 3 Python unit tests (round-trip, mismatch rejection, missing-AAD rejection), a new `secrets.sh`-level swap-attack regression test (writes two real secrets, overwrites one's `.enc` file with the other's, confirms decryption now fails), and 2 new cross-language (Node/Python) tests proving the AAD binding itself — not just the ciphertext bytes — is portable across both implementations. |
| 4 | MEDIUM | `_dune_secrets_atomic_write`'s power-loss-durability claim only `fsync`'d the temp file's content before the publishing `rename(2)` — on many POSIX filesystems/mount options, the rename itself is only durably recorded in the parent directory's own metadata once that directory is separately `fsync`'d. | **Resolved.** Added a best-effort parent-directory `fsync` immediately after the rename (non-fatal if it fails -- the file itself is still correctly published; only the directory-entry-durability guarantee weakens, logged as a warning rather than treated as a write failure). New strace-based regression test confirms exactly 2 distinct `fsync`/`fdatasync` syscalls occur per atomic write (content, then directory), not just the 1 that existed before this fix. |
| 5 | MEDIUM | `secrets.sh`'s own header comment referenced `docs/security/secrets-library-eight-hats-findings-register.md` (this very file) by path -- but this file is a fork-internal artifact, correctly excluded from the upstream diff per Requirement 19 gate (f). The maintainer reviewing the upstream PR has no way to see the file the comment points at. | **Resolved.** Reworded the header comment to describe the audit history's existence and rationale without pointing at a specific file outside the diff the maintainer is actually reviewing. |

**All 4 code-level findings (1-4) mutation-tested**: each new/updated regression test independently confirmed to genuinely fail against the pre-fix code (not passing by construction) -- Finding 1's test measured 5 real `age` calls instead of 1 against the unfixed function; Finding 2's updated Test 4 failed with "expected... to fail closed... but it succeeded" against the unfixed function; Finding 3's swap-attack test failed with "expected... to fail (AAD mismatch)... but it succeeded" against the pre-AAD code; Finding 4's strace test measured exactly 1 fsync call instead of 2 against the unfixed function.

---

## Verification Summary

- `runtime/tests/test-secrets-lib.sh`: 16/16 pass (13 from Round 1 + 3 new from Round 2).
- `python3 -m pytest runtime/scripts/lib/test_secrets_aead.py`: 21/21 pass (18 from Round 1 + 3 new AAD unit tests from Round 2).
- `runtime/tests/test-secrets-aead-cross-language.sh`: 5/5 checks pass (3 from Round 1 + 2 new AAD checks from Round 2).
- All pass, run directly against this branch with `age`/`age-keygen`/`pytest`/`node` genuinely installed (not just confirmed to skip gracefully).
- `shellcheck -S warning`: clean across every changed file.
- `tests/security-pr-checks.sh` (gitleaks + shellcheck + trivy): clean.
- Real upstream CI (`Red-Blink/dune-awakening-selfhost-docker#160`): all 9 checks pass, including `runtime-script-unit` and `Release gate`, confirmed after both the Round 1 `pytest` fix and the Round 2 findings above.
- Adversarial testing beyond the shipped test suite's own examples (Security Architect hat, Round 1): crafted secret names containing Python-injection syntax and path-traversal sequences, confirmed rejected before reaching a filesystem path or subprocess call.
- Round 2's 4 code-level fixes were each independently mutation-tested (see note above) -- the test suite growth is not passing by construction.
