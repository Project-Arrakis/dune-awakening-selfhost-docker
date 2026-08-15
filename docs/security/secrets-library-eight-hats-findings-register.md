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

## Verification Summary

- `runtime/tests/test-secrets-lib.sh`, `runtime/tests/test-secrets-aead-cross-language.sh`, `python3 -m pytest runtime/scripts/lib/test_secrets_aead.py` (18/18): all pass, run directly against this branch with `age`/`age-keygen`/`pytest` genuinely installed (not just confirmed to skip gracefully).
- `shellcheck -S warning`: clean across every new file.
- `tests/security-pr-checks.sh` (gitleaks + shellcheck + trivy): clean.
- Real upstream CI (`Red-Blink/dune-awakening-selfhost-docker#160`): all 9 checks pass, including `runtime-script-unit` and `Release gate`, confirmed after the `pytest` fix.
- Adversarial testing beyond the shipped test suite's own examples (Security Architect hat): crafted secret names containing Python-injection syntax and path-traversal sequences, confirmed rejected before reaching a filesystem path or subprocess call.
