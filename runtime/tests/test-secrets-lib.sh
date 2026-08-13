#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v age >/dev/null 2>&1 || { echo "SKIP: age not found on PATH -- see docs/design (Arrakis-Project) section 5.1 for the operator install path"; exit 0; }
command -v age-keygen >/dev/null 2>&1 || { echo "SKIP: age-keygen not found on PATH"; exit 0; }
python3 -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM" >/dev/null 2>&1 || {
  echo "SKIP: python3's 'cryptography' package not installed"
  exit 0
}

# Regression coverage for runtime/scripts/lib/secrets.sh, exercised
# against a real age identity/KEK in a disposable temp directory --
# never touching this repo's actual runtime/secrets/ or any live
# deployment. Per design doc section 6's [R3] revision, this is the
# same disposable-fixture discipline as the break-glass recovery test
# (a real git-worktree-isolated environment for tests that need one;
# this test only needs isolated files, not an isolated git checkout,
# so a plain temp directory is sufficient and correctly scoped).

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

echo "All secrets.sh library tests passed."
