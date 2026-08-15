#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v age >/dev/null 2>&1 || { echo "SKIP: age not found on PATH -- install via 'apt install age' (see https://github.com/FiloSottile/age)"; exit 0; }
command -v age-keygen >/dev/null 2>&1 || { echo "SKIP: age-keygen not found on PATH"; exit 0; }
python3 -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM" >/dev/null 2>&1 || {
  echo "SKIP: python3's 'cryptography' package not installed"
  exit 0
}

# Regression coverage for runtime/scripts/lib/secrets.sh, exercised
# against a real age identity/KEK in a disposable temp directory --
# never touching this repo's actual runtime/secrets/ or any live
# deployment. A plain temp directory is sufficient here since this
# test only needs isolated files, not an isolated git checkout (unlike
# tests that need a full disposable working tree, e.g.
# test-compose-project-name-portability.sh's git-worktree approach).

test_root="$(mktemp -d)"
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

identity_path="$test_root/age-identity.txt"
kek_path="$test_root/kek.age"

age-keygen -o "$identity_path" >/dev/null 2>&1
public_key="$(age-keygen -y "$identity_path")"

# shellcheck disable=SC1091
source runtime/scripts/lib/secrets.sh

kek_hex="$(dune_secrets_generate_dek)"
printf '%s' "$kek_hex" | age --encrypt -r "$public_key" -o "$kek_path"

# Run the actual secrets.sh functions inside the disposable test_root,
# not the real repo root, so runtime/secrets/*.enc and
# runtime/generated/.secrets-migrated/*.done are written to (and
# cleaned up from) the temp directory, never this repo's own tree.
cd "$test_root"
export DUNE_KEK_FILE="$kek_path"
export DUNE_AGE_IDENTITY_FILE="$identity_path"

# --- Test 1: backend_configured reflects both env vars being set ---
dune_secrets_backend_configured || fail "backend_configured returned false with both env vars set"

unset DUNE_AGE_IDENTITY_FILE
if dune_secrets_backend_configured; then
  fail "backend_configured returned true with only DUNE_KEK_FILE set (DUNE_AGE_IDENTITY_FILE missing)"
fi
export DUNE_AGE_IDENTITY_FILE="$identity_path"

# --- Test 2: write then read round-trips the exact plaintext ---
dune_secrets_write_secret "test-secret" "round-trip-value-12345"
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""
value="$(dune_secrets_read_encrypted "test-secret")"
[ "$value" = "round-trip-value-12345" ] || fail "write/read round-trip mismatch: got '$value'"

# --- Test 3: per-secret migration marker is written, after the .enc file ---
[ -f "runtime/secrets/test-secret.enc" ] || fail "expected runtime/secrets/test-secret.enc to exist after write_secret"
[ -f "runtime/generated/.secrets-migrated/test-secret.done" ] || fail "expected the per-secret migration marker to exist after write_secret"

# --- Test 4: wrong age identity actually reaches and fails
# dune_secrets_load_kek's age --decrypt call, and read_secret falls
# back to the legacy flat file. ---
#
# This test previously read a secret name ("legacy-only") whose .enc
# file did not exist yet at this point in the script (it was only
# created later, in what is now Test 5) -- dune_secrets_read_encrypted
# short-circuits on its own `[ -r "$enc_path" ]` check before ever
# calling dune_secrets_load_kek, so the wrong-identity/age-decrypt
# failure path this test's name and comment claim to exercise was
# never actually reached. Confirmed via mutation testing during a
# Layer 3 integration audit: replacing dune_secrets_load_kek's real
# `age --decrypt` call with a hardcoded dummy KEK -- a complete
# identity-verification bypass -- still passed this test (and the
# entire suite) undetected. Fixed by writing a real secret under the
# CORRECT identity first, then switching to the wrong identity and
# reading that same, now-existing secret -- so the .enc file genuinely
# exists and dune_secrets_load_kek's age --decrypt call is the thing
# that actually fails.
wrong_identity_secret_test_target="wrong-identity-secret-test"
dune_secrets_write_secret "$wrong_identity_secret_test_target" "value-written-under-correct-identity"
[ -f "runtime/secrets/${wrong_identity_secret_test_target}.enc" ] || fail "expected ${wrong_identity_secret_test_target}.enc to exist before testing the wrong-identity path"

wrong_identity_path="$test_root/wrong-identity.txt"
age-keygen -o "$wrong_identity_path" >/dev/null 2>&1

mkdir -p runtime/secrets
printf 'legacy-plaintext-value' > "runtime/secrets/${wrong_identity_secret_test_target}.txt"

export DUNE_AGE_IDENTITY_FILE="$wrong_identity_path"
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""
if dune_secrets_load_kek >/dev/null 2>&1; then
  fail "expected dune_secrets_load_kek to fail with the wrong age identity against an .enc file written under a different identity, but it succeeded"
fi
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""
fallback_value="$(dune_secrets_read_secret "$wrong_identity_secret_test_target" "runtime/secrets/${wrong_identity_secret_test_target}.txt")"
[ "$fallback_value" = "legacy-plaintext-value" ] || fail "expected fallback to the legacy flat file when the age identity is wrong, got '$fallback_value'"

mkdir -p runtime/secrets
printf 'legacy-plaintext-value' > runtime/secrets/legacy-only.txt

# Restore the correct identity for the remaining tests.
export DUNE_AGE_IDENTITY_FILE="$identity_path"
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""

# --- Test 5: with the correct identity, the age-decrypted value takes precedence over the legacy file ---
dune_secrets_write_secret "legacy-only" "age-encrypted-takes-precedence"
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""
preferred_value="$(dune_secrets_read_secret "legacy-only" "runtime/secrets/legacy-only.txt")"
[ "$preferred_value" = "age-encrypted-takes-precedence" ] || fail "expected the age-encrypted value to take precedence over the legacy file, got '$preferred_value'"

# --- Test 6: backend not configured at all falls back to the legacy file, unconditionally ---
unset DUNE_KEK_FILE DUNE_AGE_IDENTITY_FILE
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""
unconfigured_value="$(dune_secrets_read_secret "legacy-only" "runtime/secrets/legacy-only.txt")"
[ "$unconfigured_value" = "legacy-plaintext-value" ] || fail "expected the legacy file when the backend is entirely unconfigured, got '$unconfigured_value'"

# --- Test 7: reading a secret with neither an .enc file nor a legacy file fails (non-zero exit), not an empty-string success ---
export DUNE_KEK_FILE="$kek_path"
export DUNE_AGE_IDENTITY_FILE="$identity_path"
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""
if dune_secrets_read_secret "nonexistent-secret" "runtime/secrets/also-nonexistent.txt" >/dev/null 2>&1; then
  fail "expected dune_secrets_read_secret to fail (non-zero exit) when neither the .enc file nor the legacy file exist"
fi

# --- Test 8: _dune_secrets_atomic_write fails cleanly (non-zero exit,
# no torn/partial final file) when the target directory cannot be
# written to -- direct coverage for the atomic-write primitive itself,
# which was previously only exercised indirectly via
# dune_secrets_write_secret's happy path in test 2 above.
#
# Skipped when running as root: root bypasses standard filesystem
# permission checks, so chmod 000 on a directory does not actually
# block root from writing into it -- confirmed directly (a root-owned
# `touch` into a chmod 000 directory succeeds). This is not a gap in
# the assertion itself, only in this specific mechanism's ability to
# simulate an unwritable directory under root. CI runs as an
# unprivileged user (GitHub Actions' standard runners use a non-root
# `runner` account), so this test still provides real coverage there;
# it is only inert in a root-run environment such as some local dev
# setups or self-hosted runners. ---
if [ "$(id -u)" -eq 0 ]; then
  echo "SKIP (test 8): running as root -- chmod 000 does not block root from writing, so this directory-permission simulation cannot work. This is a real, unprivileged-only test; it is exercised in CI (GitHub Actions runs as a non-root user), just not in this root-run environment."
else
  unwritable_dir="$test_root/unwritable"
  mkdir -p "$unwritable_dir"
  chmod 000 "$unwritable_dir"
  unwritable_target="$unwritable_dir/some-secret.enc"

  atomic_write_failed=0
  _dune_secrets_atomic_write "$unwritable_target" "should-never-be-written" 600 2>/dev/null || atomic_write_failed=1

  chmod 755 "$unwritable_dir"  # restore permissions before cleanup's rm -rf runs

  [ "$atomic_write_failed" -eq 1 ] || fail "expected _dune_secrets_atomic_write to fail when the target directory is unwritable, but it reported success"
  [ -e "$unwritable_target" ] && fail "expected no final file to exist after a failed atomic write, but $unwritable_target exists"
  # Also confirm no orphaned temp file was left behind in the unwritable
  # directory itself (there shouldn't be one, since mktemp there would
  # also fail -- but confirm explicitly rather than assume).
  if find "$unwritable_dir" -maxdepth 1 -name '*.tmp.*' 2>/dev/null | grep -q .; then
    fail "expected no orphaned .tmp file after a failed atomic write"
  fi
fi

# --- Test 8b: _dune_secrets_atomic_write's <mode> parameter actually
# takes effect on the FINAL path, at a mode that is NOT mktemp's own
# default (0600) -- direct coverage for a real gap found during a
# Layer 2 QA audit: every other call site in this suite requests mode
# 600, which mktemp already produces by default, so the `chmod "$mode"`
# line's real effect was never exercised -- an earlier manual check
# confirmed a test suite with the chmod call disabled still passed all
# assertions, because nothing ever requested a mode other than the one
# mktemp already provides. Requesting 0640 here, a mode mktemp would
# never produce on its own, closes that gap. ---
mode_test_target="$test_root/mode-test-secret.enc"
_dune_secrets_atomic_write "$mode_test_target" "mode-test-content" 640
actual_mode="$(stat -c '%a' "$mode_test_target")"
[ "$actual_mode" = "640" ] || fail "expected _dune_secrets_atomic_write to apply mode 640 to the final path, got '$actual_mode' -- mktemp's own default (600) would mask a broken/removed chmod call here"

# --- Test 8c: the temp-file-then-rename discipline is a REAL rename(2)
# syscall on the final path, not merely "no error was reported" --
# direct coverage for a real gap found during a Layer 2 QA audit: an
# earlier manual check found that removing the temp-file/rename step
# entirely (writing straight to the final path) was only caught by an
# incidental `mv: same file` self-move error, not by any assertion
# about atomicity itself -- a variant of that same bug that avoided
# the self-move collision passed the existing test suite undetected.
# strace's real syscall trace is the only way to directly prove the
# final path is published via a single rename(2), not observed
# indirectly through side effects that could pass for the wrong
# reason. Skips cleanly if strace isn't available rather than failing
# the whole suite over an optional diagnostic tool. ---
if command -v strace >/dev/null 2>&1; then
  atomic_trace_target="$test_root/atomic-trace-secret.enc"
  strace_log="$test_root/atomic-trace.strace"
  # Run inside a subshell so the sourced function/env state here doesn't
  # leak into strace's own exec, and so this uses the real, already-
  # sourced _dune_secrets_atomic_write rather than reimplementing it.
  strace -f -e trace=rename,renameat,renameat2,open,openat -o "$strace_log" \
    bash -c "source '$repo_root/runtime/scripts/lib/secrets.sh'; _dune_secrets_atomic_write '$atomic_trace_target' 'atomic-trace-content' 600" \
    2>/dev/null || true

  if ! grep -qE '(rename|renameat2?)\(' "$strace_log"; then
    fail "expected _dune_secrets_atomic_write to invoke a real rename(2)/renameat(2) syscall to publish the final path, but strace captured none -- see $strace_log"
  fi
  # The traced rename's second path argument must be the exact final
  # path, not some other file -- confirms the syscall we found is the
  # one actually publishing THIS write, not an unrelated rename
  # elsewhere in the same process tree (e.g. mktemp's own internals).
  if ! grep -qF "$atomic_trace_target" "$strace_log"; then
    fail "expected the traced rename syscall to reference the final path $atomic_trace_target, but it did not appear in the trace"
  fi
else
  echo "SKIP: strace not available -- skipping direct rename(2) syscall verification (Test 8c)"
fi

# --- Test 9: dune_secrets_render_plaintext_file self-heals when a
# stray non-file (e.g. a directory) already exists at the target path,
# instead of aborting -- direct regression coverage for a real,
# reproduced production incident: a plain `rm -f` on this exact class
# of path silently failed to remove a directory Docker itself had left
# behind, which aborted the calling script under set -euo pipefail
# before the container it was preparing a credential file for ever
# started. This test reproduces the exact stray-directory state and
# confirms the fixed helper recovers automatically rather than
# requiring manual intervention. ---
stray_dir_target="$test_root/render-target-with-stray-directory"
mkdir -p "$stray_dir_target"  # reproduce the exact incident state: a directory, not a file, at the render path

dune_secrets_render_plaintext_file "$stray_dir_target" "recovered-value-after-stray-dir" 600 2>/dev/null
render_result=$?

[ "$render_result" -eq 0 ] || fail "expected dune_secrets_render_plaintext_file to succeed (self-heal) when a stray directory exists at the target path, got exit code $render_result"
[ -f "$stray_dir_target" ] || fail "expected $stray_dir_target to be a regular file after self-healing, but it is not"
rendered_content="$(cat "$stray_dir_target")"
[ "$rendered_content" = "recovered-value-after-stray-dir" ] || fail "expected the rendered file to contain the correct value after self-healing, got '$rendered_content'"

# --- Test 10: a secret name containing Python-syntax-breaking
# characters must be REJECTED, not executed -- direct regression
# coverage for a real, found-before-shipping RCE: an earlier draft of
# _dune_secrets_atomic_write's fsync helper string-interpolated the
# temp path directly into a `python3 -c` script, so a crafted name
# containing a single quote and Python syntax executed arbitrary code
# instead of merely producing a weird filename. This test reproduces
# the exact payload that was confirmed to execute code before the fix
# (passing the path via sys.argv instead of interpolating it) and
# confirms it is now rejected up front by name validation, with no
# side effect (the injected os.system() call, if it ran, would create
# a marker file -- confirm that file does NOT exist). ---
rce_marker="$test_root/PWNED-if-rce-still-present"
rce_payload="x', os.O_RDONLY); os.system('touch $rce_marker') #"

if dune_secrets_encrypted_path "$rce_payload" >/dev/null 2>&1; then
  fail "expected dune_secrets_encrypted_path to reject an RCE-payload name, but it was accepted"
fi
[ -f "$rce_marker" ] && fail "CRITICAL: RCE payload executed -- marker file $rce_marker was created"

# --- Test 11: a secret name containing path-traversal sequences must
# be REJECTED -- direct regression coverage for a real, found-before-
# shipping path-traversal bug: dune_secrets_encrypted_path/
# dune_secrets_migration_marker_path built a path via
# printf 'runtime/secrets/%s.enc' "$name" with zero validation, so a
# name of "../../../somewhere/else" produced a path escaping
# runtime/secrets/ entirely. This test confirms such a name is now
# rejected before any path is ever printed or written to. ---
traversal_marker="$test_root/traversal-marker-outside-secrets-dir"
traversal_payload="../../../../../../..${traversal_marker}"

if dune_secrets_encrypted_path "$traversal_payload" >/dev/null 2>&1; then
  fail "expected dune_secrets_encrypted_path to reject a path-traversal name, but it was accepted"
fi
[ -f "${traversal_marker}.enc" ] && fail "path traversal succeeded -- file exists outside runtime/secrets/ at ${traversal_marker}.enc"

# --- Test 12: every real secret name already in use elsewhere in this
# codebase must still be ACCEPTED by the same validation that rejects
# tests 10/11's malicious payloads -- confirms the fix doesn't merely
# reject everything, and pins the exact real names this validation
# must never regress against as new secrets are wired up in later
# stages of this feature's rollout. ---
for real_name in funcom-token rmq-http-token-auth-secret fls-apikey \
                 server-login-password-secret username-server-login-secret \
                 postgres-password; do
  dune_secrets_encrypted_path "$real_name" >/dev/null 2>&1 \
    || fail "expected the real, already-in-use secret name '$real_name' to be accepted by name validation, but it was rejected"
done

# --- Test 13: dune_secrets_render_plaintext_file must not permanently
# change the CALLING shell's umask -- direct regression coverage for a
# real, found-before-shipping bug: this function set `umask 077` with
# no save/restore, and since this file is sourced (not run in a
# subshell), that silently changed the caller's umask for its entire
# remaining execution, affecting every unrelated file the caller
# creates afterward, not just the one this function renders.
#
# The umask reset to a known baseline (022) immediately before this
# test is NOT cosmetic -- without it, this test produced a false pass
# against the unfixed bug, because Test 9 above already calls this
# same function first; if Test 9's call had leaked the umask to 077,
# "before" and "after" here would both read 077 and look unchanged,
# hiding the exact regression this test exists to catch. Confirmed
# directly: reverting the fix with this reset removed reproduces the
# original false pass; with the reset present, the same reverted fix
# correctly fails. ---
umask 022
umask_before_render="$(umask)"
dune_secrets_render_plaintext_file "$test_root/umask-probe-file" "probe-content" 600
umask_after_render="$(umask)"
[ "$umask_before_render" = "$umask_after_render" ] \
  || fail "expected dune_secrets_render_plaintext_file to leave the caller's umask unchanged (was $umask_before_render, now $umask_after_render)"

echo "All secrets.sh library tests passed."
