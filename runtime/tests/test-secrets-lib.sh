#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v age >/dev/null 2>&1 || { echo "SKIP: age not found on PATH -- see docs/runtime/AGE-SECRETS-MANAGEMENT.md for the operator install path"; exit 0; }
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

# --- Test 4: wrong age identity fails to decrypt the KEK, and read_secret falls back to the legacy flat file ---
wrong_identity_path="$test_root/wrong-identity.txt"
age-keygen -o "$wrong_identity_path" >/dev/null 2>&1

mkdir -p runtime/secrets
printf 'legacy-plaintext-value' > runtime/secrets/legacy-only.txt

export DUNE_AGE_IDENTITY_FILE="$wrong_identity_path"
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""
fallback_value="$(dune_secrets_read_secret "legacy-only" "runtime/secrets/legacy-only.txt")"
[ "$fallback_value" = "legacy-plaintext-value" ] || fail "expected fallback to the legacy flat file when the age identity is wrong, got '$fallback_value'"

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
# dune_secrets_write_secret's happy path in test 2 above. ---
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

echo "All secrets.sh library tests passed."
