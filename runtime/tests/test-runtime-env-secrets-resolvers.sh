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

# Regression coverage for runtime-env.sh's shared secret resolvers
# (resolve_funcom_token, resolve_rmq_http_token_auth_secret,
# resolve_fls_apikey, resolve_server_login_password_secret,
# resolve_username_server_login_secret) -- the "one seam, not 13"
# consolidation of what was previously a nearly-identical inline
# read-the-flat-file pattern duplicated across 7+ scripts. Exercised
# against a real age identity/KEK in a disposable temp directory,
# seeded with realistic flat-file fixtures -- never touching this
# repo's actual runtime/secrets/ or any live deployment.

test_root="$(mktemp -d)"
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

mkdir -p "$test_root/runtime/secrets" "$test_root/runtime/generated"
printf 'legacy-funcom-token-value' > "$test_root/runtime/secrets/funcom-token.txt"
chmod 600 "$test_root/runtime/secrets/funcom-token.txt"

identity_path="$test_root/age-identity.txt"
kek_path="$test_root/kek.age"
age-keygen -o "$identity_path" >/dev/null 2>&1
public_key="$(age-keygen -y "$identity_path")"

# runtime-env.sh (and its own sourced dependencies, e.g.
# compose-project.sh) uses paths relative to the repo root -- it must
# be sourced from here, BEFORE cd-ing into the disposable test
# directory below. This is read-only at source time (it only resolves
# the compose project name via a pure function call, never persists
# anything) and matches how every real caller already uses it.
# shellcheck disable=SC1091
source runtime/scripts/runtime-env.sh

kek_hex="$(dune_secrets_generate_dek)"
printf '%s' "$kek_hex" | age --encrypt -r "$public_key" -o "$kek_path"

cd "$test_root"

# --- Test 1: unconfigured backend -- resolve_funcom_token must match
# the legacy flat-file read exactly (byte-for-byte, zero behavior
# change for an operator who never opts in). ---
resolved="$(resolve_funcom_token "$test_root/runtime/secrets/funcom-token.txt")"
[ "$resolved" = "legacy-funcom-token-value" ] || fail "expected resolve_funcom_token to return the legacy flat-file value when backend is unconfigured, got '$resolved'"

# --- Test 2: resolve_funcom_token fails (non-zero, empty stdout) when
# neither the encrypted form nor the flat file exists -- must not
# silently succeed with an empty string. ---
if resolved="$(resolve_funcom_token "$test_root/runtime/secrets/nonexistent-token.txt" 2>/dev/null)"; then
  fail "expected resolve_funcom_token to fail when neither the .enc form nor the flat file exist, but it returned '$resolved'"
fi

# --- Test 3: once the age backend is configured and this secret is
# migrated, resolve_funcom_token must prefer the encrypted form over
# the (now-stale) flat file, never regenerate/overwrite the flat file,
# and never silently swallow the divergence. ---
export DUNE_KEK_FILE="$kek_path"
export DUNE_AGE_IDENTITY_FILE="$identity_path"
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""

dune_secrets_write_secret "funcom-token" "migrated-encrypted-token-value"

resolved="$(resolve_funcom_token "$test_root/runtime/secrets/funcom-token.txt")"
[ "$resolved" = "migrated-encrypted-token-value" ] || fail "expected resolve_funcom_token to prefer the encrypted form once migrated, got '$resolved'"

flat_file_contents="$(cat "$test_root/runtime/secrets/funcom-token.txt")"
[ "$flat_file_contents" = "legacy-funcom-token-value" ] || fail "expected the legacy flat file to remain UNCHANGED after migration (rollback-by-construction), but it was modified to '$flat_file_contents'"

# --- Test 4: resolve_fls_apikey and resolve_rmq_http_token_auth_secret
# preserve the existing auto-generate-if-missing behavior when the
# backend is unconfigured (matching the openssl rand -hex pattern
# previously duplicated inline in start-director.sh /
# start-server-gateway.sh / start-text-router.sh), and are stable
# (idempotent) across repeated calls. ---
unset DUNE_KEK_FILE DUNE_AGE_IDENTITY_FILE
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""

[ ! -e "$test_root/runtime/secrets/fls-apikey.txt" ] || fail "test setup error: fls-apikey.txt should not exist yet"
fls_apikey_first="$(resolve_fls_apikey "$test_root/runtime/secrets/fls-apikey.txt")"
[ -n "$fls_apikey_first" ] || fail "expected resolve_fls_apikey to auto-generate a non-empty value when missing and unconfigured"
[ -e "$test_root/runtime/secrets/fls-apikey.txt" ] || fail "expected resolve_fls_apikey to have created the flat file as a side effect of auto-generation"

fls_apikey_second="$(resolve_fls_apikey "$test_root/runtime/secrets/fls-apikey.txt")"
[ "$fls_apikey_first" = "$fls_apikey_second" ] || fail "expected resolve_fls_apikey to be stable (idempotent) across repeated calls, got '$fls_apikey_first' then '$fls_apikey_second'"

rmq_secret_first="$(resolve_rmq_http_token_auth_secret "$test_root/runtime/secrets/rmq-http-token-auth-secret.txt")"
[ -n "$rmq_secret_first" ] || fail "expected resolve_rmq_http_token_auth_secret to auto-generate a non-empty value when missing and unconfigured"
rmq_secret_second="$(resolve_rmq_http_token_auth_secret "$test_root/runtime/secrets/rmq-http-token-auth-secret.txt")"
[ "$rmq_secret_first" = "$rmq_secret_second" ] || fail "expected resolve_rmq_http_token_auth_secret to be stable across repeated calls"

# --- Test 5: once migrated to the encrypted form, resolve_fls_apikey
# must NOT regenerate/overwrite the existing flat file (the same
# "never clobber a deliberately-removed-or-superseded flat file"
# guarantee proven for funcom-token above, but for the
# auto-generating resolver specifically -- a real, distinct risk,
# since this resolver's un-migrated path itself writes to disk). ---
export DUNE_KEK_FILE="$kek_path"
export DUNE_AGE_IDENTITY_FILE="$identity_path"
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""

dune_secrets_write_secret "fls-apikey" "migrated-encrypted-fls-apikey"
resolved="$(resolve_fls_apikey "$test_root/runtime/secrets/fls-apikey.txt")"
[ "$resolved" = "migrated-encrypted-fls-apikey" ] || fail "expected resolve_fls_apikey to prefer the encrypted form once migrated, got '$resolved'"

flat_file_contents="$(cat "$test_root/runtime/secrets/fls-apikey.txt")"
[ "$flat_file_contents" = "$fls_apikey_first" ] || fail "expected the auto-generated flat file to remain UNCHANGED after migration, but it changed from '$fls_apikey_first' to '$flat_file_contents'"

# --- Test 6: funcom_token_host_id's argument-presence distinction
# (${1+...}-style "was an argument passed" check vs a plain ${1:-...}
# default) -- an explicitly-passed empty string (e.g. the result of a
# failed resolve_funcom_token call) must fail loudly, never silently
# fall back to reading the default runtime/secrets/funcom-token.txt
# PATH (relative to cwd) out from under the caller. This specifically
# requires a real, PARSEABLE JWT (one that funcom_token_host_id could
# successfully extract a HostId from) to actually exist at that exact
# default relative path in $PWD -- otherwise a buggy ${1:-...}
# implementation would still (correctly-looking, but for the WRONG
# reason -- the fixture file contains a non-JWT value, not the
# intended argument-presence check) return non-zero, and this test
# would pass even with the bug present. Confirmed directly: with a
# non-JWT fixture at this path, reverting to the buggy ${1:-...}
# pattern did NOT make this specific assertion fail; it only fails
# once a real, parseable JWT is placed there. ---
mkdir -p runtime/secrets
synthetic_payload="$(printf '{"HostId":"SHOULD_NEVER_BE_RETURNED"}' | base64 -w0 | tr '+/' '-_' | tr -d '=')"
printf 'eyJhbGciOiJIUzI1NiJ9.%s.fakesig' "$synthetic_payload" > runtime/secrets/funcom-token.txt

unset DUNE_KEK_FILE DUNE_AGE_IDENTITY_FILE
_DUNE_KEK_LOADED=0
_DUNE_KEK_HEX=""

if result="$(funcom_token_host_id "" 2>/dev/null)"; then
  fail "expected funcom_token_host_id to fail on an explicitly-passed empty string, not silently fall back to reading the default relative path and returning '$result' from the fixture JWT planted there specifically to catch this"
fi

echo "All runtime-env.sh secrets-resolver tests passed."
