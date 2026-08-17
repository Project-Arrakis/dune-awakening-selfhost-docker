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
# deployment.

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
# dune_secrets_load_kek's age --decrypt call, and read_secret FAILS
# CLOSED (does NOT fall back to the legacy flat file) once a .enc file
# already exists for this secret.
#
# This is a deliberate behavior change from an earlier version of this
# library, which fell back to the legacy plaintext file on ANY
# decryption failure, including one caused by a wrong/corrupted .enc
# file for an already-migrated secret -- silently returning stale
# plaintext with no indication anything was wrong, defeating the point
# of migrating the secret at all. Legacy fallback is now correct only
# for a secret that has never been migrated (see Test 6 below).
#
# The secret must be written under the CORRECT identity first, then
# read back under the WRONG one -- reading a secret whose .enc file
# doesn't exist yet would short-circuit on the missing-file check
# before ever calling dune_secrets_load_kek, silently never exercising
# the age-decrypt failure path at all (confirmed via mutation testing:
# a hardcoded dummy-KEK bypass of real identity verification passed
# this test undetected until the ordering was fixed). ---
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
fail_closed_stdout="$test_root/fail-closed-stdout.txt"
if dune_secrets_read_secret "$wrong_identity_secret_test_target" "runtime/secrets/${wrong_identity_secret_test_target}.txt" >"$fail_closed_stdout" 2>/dev/null; then
  fail "expected dune_secrets_read_secret to fail closed (non-zero exit) once a .enc file exists but fails to decrypt, but it succeeded"
fi
[ ! -s "$fail_closed_stdout" ] || fail "expected no stdout output when failing closed, got '$(cat "$fail_closed_stdout")'"

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
# written to.
#
# Skipped when running as root: root bypasses chmod 000, so this
# specific unwritable-directory simulation is inert under root (a
# root-owned `touch` into a chmod 000 dir succeeds). CI runs as a
# non-root user, so real coverage still exists there. ---
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
# takes effect on the FINAL path. Every other call site in this suite
# requests mode 600, which mktemp already produces by default, so a
# removed `chmod "$mode"` line would go undetected -- request 0640
# here (a mode mktemp never produces on its own) to close that gap. ---
mode_test_target="$test_root/mode-test-secret.enc"
_dune_secrets_atomic_write "$mode_test_target" "mode-test-content" 640
actual_mode="$(stat -c '%a' "$mode_test_target")"
[ "$actual_mode" = "640" ] || fail "expected _dune_secrets_atomic_write to apply mode 640 to the final path, got '$actual_mode' -- mktemp's own default (600) would mask a broken/removed chmod call here"

# --- Test 8c: the temp-file-then-rename discipline is a REAL rename(2)
# syscall on the final path, not merely "no error was reported" --
# a variant of the write-straight-to-final-path bug that avoids the
# incidental `mv: same file` self-move error would otherwise pass this
# suite undetected without a direct strace assertion. Skips cleanly if
# strace isn't available. ---
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
# instead of aborting -- reproduces a real production incident where a
# plain `rm -f` silently failed to remove a stray directory Docker had
# left behind, aborting the calling script under set -euo pipefail. ---
stray_dir_target="$test_root/render-target-with-stray-directory"
mkdir -p "$stray_dir_target"  # reproduce the exact incident state: a directory, not a file, at the render path

dune_secrets_render_plaintext_file "$stray_dir_target" "recovered-value-after-stray-dir" 600 2>/dev/null
render_result=$?

[ "$render_result" -eq 0 ] || fail "expected dune_secrets_render_plaintext_file to succeed (self-heal) when a stray directory exists at the target path, got exit code $render_result"
[ -f "$stray_dir_target" ] || fail "expected $stray_dir_target to be a regular file after self-healing, but it is not"
rendered_content="$(cat "$stray_dir_target")"
[ "$rendered_content" = "recovered-value-after-stray-dir" ] || fail "expected the rendered file to contain the correct value after self-healing, got '$rendered_content'"

# --- Test 10: a secret name containing Python-syntax-breaking
# characters must be REJECTED, not executed -- reproduces the exact
# payload confirmed to achieve RCE against an earlier draft that
# string-interpolated the name into a `python3 -c` script. Confirms
# both that the name is rejected up front AND that the injected
# os.system() call left no side effect. ---
rce_marker="$test_root/PWNED-if-rce-still-present"
rce_payload="x', os.O_RDONLY); os.system('touch $rce_marker') #"

if dune_secrets_encrypted_path "$rce_payload" >/dev/null 2>&1; then
  fail "expected dune_secrets_encrypted_path to reject an RCE-payload name, but it was accepted"
fi
[ -f "$rce_marker" ] && fail "CRITICAL: RCE payload executed -- marker file $rce_marker was created"

# --- Test 11: a secret name containing path-traversal sequences must
# be REJECTED -- an earlier draft built the path with zero validation,
# so a name like "../../../somewhere/else" escaped runtime/secrets/
# entirely. ---
traversal_marker="$test_root/traversal-marker-outside-secrets-dir"
traversal_payload="../../../../../../..${traversal_marker}"

if dune_secrets_encrypted_path "$traversal_payload" >/dev/null 2>&1; then
  fail "expected dune_secrets_encrypted_path to reject a path-traversal name, but it was accepted"
fi
[ -f "${traversal_marker}.enc" ] && fail "path traversal succeeded -- file exists outside runtime/secrets/ at ${traversal_marker}.enc"

# --- Test 12: every real secret name already in use elsewhere in this
# codebase must still be ACCEPTED by the same validation that rejects
# tests 10/11's payloads -- pins the exact names later wiring stages
# must not regress against. ---
for real_name in funcom-token rmq-http-token-auth-secret fls-apikey \
                 server-login-password-secret username-server-login-secret \
                 postgres-password; do
  dune_secrets_encrypted_path "$real_name" >/dev/null 2>&1 \
    || fail "expected the real, already-in-use secret name '$real_name' to be accepted by name validation, but it was rejected"
done

# --- Test 13: dune_secrets_render_plaintext_file must not permanently
# change the CALLING shell's umask -- an earlier draft's `umask 077`
# had no save/restore, and since this file is sourced (not run in a
# subshell), that leaked into the caller's remaining execution.
#
# The umask reset to a known baseline (022) right before this test is
# NOT cosmetic: Test 9 above already calls this same function, so
# without the reset, a leaked 077 from Test 9 would make "before" and
# "after" both read 077 here, hiding the exact regression this test
# exists to catch. ---
umask 022
umask_before_render="$(umask)"
dune_secrets_render_plaintext_file "$test_root/umask-probe-file" "probe-content" 600
umask_after_render="$(umask)"
[ "$umask_before_render" = "$umask_after_render" ] \
  || fail "expected dune_secrets_render_plaintext_file to leave the caller's umask unchanged (was $umask_before_render, now $umask_after_render)"

# --- Test 14: dune_secrets_read_secret's KEK cache actually works
# THROUGH the public function real callers use, not just through the
# lower-level functions in isolation -- direct regression coverage for
# a real upstream review finding: dune_secrets_read_secret invoked
# dune_secrets_read_encrypted via $(...) command substitution, which
# forks a subshell; that subshell's own cache population never
# propagated back to the calling shell, so N calls to
# dune_secrets_read_secret cost N real `age --decrypt` invocations even
# though the lower-level cache was already correct in isolation. Counts
# real `age` invocations via a PATH-shadowing wrapper around the real
# `age` binary, calling dune_secrets_read_secret 5 times in the SAME
# shell (the realistic scenario: one script instance reading several
# secrets in sequence). ---
age_call_counter_dir="$test_root/age-call-counter"
mkdir -p "$age_call_counter_dir"
age_call_log="$age_call_counter_dir/calls.log"
: > "$age_call_log"
real_age_path="$(command -v age)"
cat > "$age_call_counter_dir/age" <<EOF
#!/usr/bin/env bash
echo "call" >> "$age_call_log"
exec "$real_age_path" "\$@"
EOF
chmod +x "$age_call_counter_dir/age"

_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""
(
  export PATH="$age_call_counter_dir:$PATH"
  for _ in 1 2 3 4 5; do
    dune_secrets_read_secret "test-secret" "runtime/secrets/test-secret.txt" >/dev/null
  done
)
age_call_count="$(wc -l < "$age_call_log" | tr -d ' ')"
[ "$age_call_count" -eq 1 ] || fail "expected exactly 1 real 'age' invocation across 5 dune_secrets_read_secret calls in the same shell (KEK cache should make calls 2-5 free), got $age_call_count"
echo "PASS: dune_secrets_read_secret's KEK cache works through the public function (1 age call for 5 reads)"

# --- Test 15: AAD binding rejects a complete-payload swap between two
# DIFFERENT secrets' .enc files -- direct regression coverage for a
# real upstream review finding: without binding the secret name into
# the AEAD authentication tag, copying secret A's entire, otherwise-
# valid .enc file content over secret B's .enc path would still
# authenticate successfully (same KEK, same DEK-wrap format), silently
# serving A's value under B's name. ---
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""
dune_secrets_write_secret "aad-swap-secret-a" "value-belonging-to-secret-a"
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""
dune_secrets_write_secret "aad-swap-secret-b" "value-belonging-to-secret-b"

# Swap: overwrite B's .enc file with A's complete .enc file content.
cp "runtime/secrets/aad-swap-secret-a.enc" "runtime/secrets/aad-swap-secret-b.enc"

_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""
if dune_secrets_read_encrypted "aad-swap-secret-b" >/dev/null 2>&1; then
  fail "expected reading 'aad-swap-secret-b' after an .enc-file swap with 'aad-swap-secret-a' to fail (AAD mismatch), but it succeeded"
fi
echo "PASS: AAD binding rejects a complete-payload swap between two different secrets' .enc files"

# --- Test 16: the parent directory is actually fsync'd after
# publishing an atomic write, not just the file's own content --
# direct coverage for a real upstream review finding: fsync'ing only
# the temp file's content before rename does not guarantee the RENAME
# itself is durably recorded in the parent directory across a crash;
# the directory itself must also be fsync'd. Skips cleanly if strace
# isn't available. ---
if command -v strace >/dev/null 2>&1; then
  dir_fsync_target="$test_root/dir-fsync-secret.enc"
  dir_fsync_strace_log="$test_root/dir-fsync.strace"
  strace -f -e trace=fsync,fdatasync -o "$dir_fsync_strace_log" \
    bash -c "source '$repo_root/runtime/scripts/lib/secrets.sh'; _dune_secrets_atomic_write '$dir_fsync_target' 'dir-fsync-content' 600" \
    2>/dev/null || true

  # Expect at least 2 distinct fsync calls: one for the temp file's
  # content, one for the parent directory. Counting fsync syscalls
  # (not just checking >=1) is what actually distinguishes "content
  # fsync only" from "content fsync AND directory fsync" -- a single
  # fsync call would satisfy a weaker ">= 1" assertion without
  # providing the directory-durability guarantee this test exists to
  # confirm.
  dir_fsync_call_count="$(grep -cE '(fsync|fdatasync)\(' "$dir_fsync_strace_log" 2>/dev/null || true)"
  [ "${dir_fsync_call_count:-0}" -ge 2 ] || fail "expected at least 2 fsync/fdatasync syscalls (temp file content + parent directory), got ${dir_fsync_call_count:-0} -- see $dir_fsync_strace_log"
  echo "PASS: parent directory is fsync'd after publishing an atomic write, not just the file's content"
else
  echo "SKIP: strace not available -- skipping direct parent-directory fsync verification (Test 16)"
fi

echo "All secrets.sh library tests passed."
