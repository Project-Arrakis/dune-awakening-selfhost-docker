#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

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

# Regression coverage for Stage 3 of the age-based secrets library
# rollout (dune-awakening-selfhost-docker#901):
# discord-hosted-bot-oauth-client-secret, resolved by
# runtime/scripts/lib/console-secrets-env.sh and wired into
# runtime/scripts/console.sh. Deliberately does NOT re-prove what
# test-secrets-stage2.sh already covers generically at the
# runtime/scripts/lib/secrets.sh library level (corrupted .enc files,
# KEK/identity mismatches, permission drift, cleanup-legacy's
# adversarial cases) -- none of that is name-specific, and Stage 3
# reuses the exact same library functions Stage 2 already exercises
# against those failure modes. This file covers only what is
# genuinely different for Stage 3: the secret is OPTIONAL and operator-
# supplied, never auto-generated, and it is resolved by a different
# caller (console.sh, not runtime-env.sh).

test_root="$(mktemp -d)"
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

identity_path="$test_root/age-identity.txt"
wrong_identity_path="$test_root/wrong-identity.txt"
kek_path="$test_root/kek.age"

age-keygen -o "$identity_path" >/dev/null 2>&1
public_key="$(age-keygen -y "$identity_path")"
age-keygen -o "$wrong_identity_path" >/dev/null 2>&1

# shellcheck disable=SC1091
source "$repo_root/runtime/scripts/lib/secrets.sh"

kek_hex="$(dune_secrets_generate_dek)"
printf '%s' "$kek_hex" | age --encrypt -r "$public_key" -o "$kek_path"

# Copy console-secrets-env.sh's own dependencies (just secrets.sh) plus
# secrets-cli.sh and its own dependencies into the disposable test_root,
# matching test-secrets-stage2.sh's own established isolation pattern --
# never touches this repo's real runtime/secrets/.
mkdir -p "$test_root/runtime/scripts/lib" "$test_root/runtime/generated" "$test_root/runtime/secrets"
cp "$repo_root/runtime/scripts/runtime-env.sh" "$test_root/runtime/scripts/"
cp "$repo_root/runtime/scripts/memory-swap-common.sh" "$test_root/runtime/scripts/"
cp "$repo_root/runtime/scripts/env-file.sh" "$test_root/runtime/scripts/"
cp "$repo_root/runtime/scripts/host-file-ownership.sh" "$test_root/runtime/scripts/"
cp "$repo_root/runtime/scripts/compose-project.sh" "$test_root/runtime/scripts/"
cp "$repo_root/runtime/scripts/secrets-cli.sh" "$test_root/runtime/scripts/"
cp "$repo_root/runtime/scripts/lib/secrets.sh" "$test_root/runtime/scripts/lib/"
cp "$repo_root/runtime/scripts/lib/secrets_aead.py" "$test_root/runtime/scripts/lib/"
cp "$repo_root/runtime/scripts/lib/console-secrets-env.sh" "$test_root/runtime/scripts/lib/"

cd "$test_root"

# --- Test 1: fresh install / genuinely never configured -- the
# resolver must print NOTHING and exit 0, and it must NEVER fabricate
# a legacy plaintext file the way Stage 2's resolvers do for an
# auto-generated secret. This is the one behavior that is genuinely
# different from Stage 2, and the entire reason Stage 3 isn't just
# "call _resolve_stage2_secret with a new name." ---
unset DUNE_KEK_FILE DUNE_AGE_IDENTITY_FILE 2>/dev/null || true
(
  # shellcheck disable=SC1091
  source runtime/scripts/lib/console-secrets-env.sh
  out="$(resolve_discord_hosted_bot_oauth_client_secret)"
  [ -z "$out" ] || fail "Test 1: resolver returned a non-empty value for a never-configured secret"
)
[ ! -e runtime/secrets/discord-hosted-bot-oauth-client-secret.txt ] || fail "Test 1: resolver fabricated a legacy plaintext file for an operator-supplied secret that was never configured"
echo "PASS: Test 1 (never configured -- empty output, no fabricated file)"

# --- Test 2: operator has a real plaintext value (simulating what
# adapterSettings.js's handleSaveOAuthConfig would have written) --
# the resolver must return it unchanged when the backend isn't
# configured at all, matching plain readInlineOrFile()'s own
# file-fallback behavior. ---
mkdir -p runtime/secrets
printf 'operator-typed-client-secret-value' > runtime/secrets/discord-hosted-bot-oauth-client-secret.txt
chmod 600 runtime/secrets/discord-hosted-bot-oauth-client-secret.txt
(
  unset DUNE_KEK_FILE DUNE_AGE_IDENTITY_FILE 2>/dev/null || true
  # shellcheck disable=SC1091
  source runtime/scripts/lib/console-secrets-env.sh
  out="$(resolve_discord_hosted_bot_oauth_client_secret)"
  [ "$out" = "operator-typed-client-secret-value" ] || fail "Test 2: resolver did not return the existing legacy plaintext value when backend not configured"
)
echo "PASS: Test 2 (existing legacy plaintext returned as-is when backend not configured)"

# --- Test 3: migrate via secrets-cli.sh, resolver returns the
# original value through the encrypted path ---
export DUNE_KEK_FILE="$kek_path"
export DUNE_AGE_IDENTITY_FILE="$identity_path"
bash runtime/scripts/secrets-cli.sh migrate discord-hosted-bot-oauth-client-secret >/dev/null
[ -f runtime/secrets/discord-hosted-bot-oauth-client-secret.enc ] || fail "Test 3: .enc file was not created by migrate"
legacy_after="$(cat runtime/secrets/discord-hosted-bot-oauth-client-secret.txt)"
[ "$legacy_after" = "operator-typed-client-secret-value" ] || fail "Test 3: migrate mutated the legacy file"
(
  # shellcheck disable=SC1091
  source runtime/scripts/lib/console-secrets-env.sh
  out="$(resolve_discord_hosted_bot_oauth_client_secret)"
  [ "$out" = "operator-typed-client-secret-value" ] || fail "Test 3: resolver did not return the original value after migration"
)
echo "PASS: Test 3 (migration via secrets-cli.sh, resolver reads the encrypted form)"

# --- Test 4: wrong age identity after migration is a hard stop
# (fail closed), not a silent fallback to empty or to stale plaintext ---
(
  # shellcheck disable=SC2030,SC2031
  export DUNE_AGE_IDENTITY_FILE="$wrong_identity_path"
  # shellcheck disable=SC1091
  source runtime/scripts/lib/console-secrets-env.sh
  set +e
  resolve_discord_hosted_bot_oauth_client_secret >/dev/null 2>/dev/null
  rc=$?
  [ "$rc" != "0" ] || fail "Test 4: resolver succeeded with the wrong age identity after migration"
)
echo "PASS: Test 4 (wrong age identity is a hard stop after migration)"

# --- Test 5: cleanup-legacy removes the plaintext copy; the secret
# stays correctly resolvable, and the scope allow-list still rejects
# every other name (regression -- adding this 3rd name must not have
# widened the allow-list beyond exactly 3) ---
bash runtime/scripts/secrets-cli.sh cleanup-legacy discord-hosted-bot-oauth-client-secret >/dev/null
[ ! -e runtime/secrets/discord-hosted-bot-oauth-client-secret.txt ] || fail "Test 5: cleanup-legacy did not remove the legacy file"
(
  # shellcheck disable=SC1091
  source runtime/scripts/lib/console-secrets-env.sh
  out="$(resolve_discord_hosted_bot_oauth_client_secret)"
  [ "$out" = "operator-typed-client-secret-value" ] || fail "Test 5: resolver value changed after cleanup-legacy"
)
set +e
bash runtime/scripts/secrets-cli.sh migrate postgres-password >/tmp/scope-out.$$ 2>&1
scope_rc=$?
bash runtime/scripts/secrets-cli.sh migrate discord-oauth-client-secret >/tmp/scope-out2.$$ 2>&1
scope_rc2=$?
set -e
[ "$scope_rc" != "0" ] || fail "Test 5: migrate accepted an out-of-scope secret name (postgres-password)"
[ "$scope_rc2" != "0" ] || fail "Test 5: migrate accepted the UNRELATED console-sign-in Discord secret (discord-oauth-client-secret) -- Stage 3 must not have widened scope beyond the hosted-bot wizard's own secret"
rm -f /tmp/scope-out.$$ /tmp/scope-out2.$$
echo "PASS: Test 5 (cleanup-legacy, and the allow-list still rejects everything else, including the similarly-named but unrelated console-sign-in secret)"

# --- Test 6: the prepare_discord_hosted_bot_oauth_secret() export
# pattern console.sh uses actually exports the resolved value, and
# does NOT export anything (leaves the var genuinely unset) when the
# secret was never configured at all. NOTE: this re-declares the
# function body inline rather than sourcing runtime/scripts/console.sh
# itself -- that file's own top-level statements (cd to repo root,
# unconditionally sourcing compose-project.sh, computing the real
# compose project name) run the instant it's sourced, which this
# isolated test_root cannot support and a unit test for this one
# function shouldn't need to. If console.sh's real
# prepare_discord_hosted_bot_oauth_secret() implementation ever
# changes, keep this copy in sync by hand -- there is no automated
# guard against drift between the two. ---
(
  unset DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET 2>/dev/null || true
  # shellcheck disable=SC1091
  source runtime/scripts/lib/console-secrets-env.sh
  # Deliberately scoped to this subshell only (SC2030/SC2031).
  prepare_discord_hosted_bot_oauth_secret() {
    # shellcheck disable=SC2031
    if [ -n "${DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET:-}" ]; then return 0; fi
    local resolved
    resolved="$(resolve_discord_hosted_bot_oauth_client_secret)"
    if [ -n "$resolved" ]; then
      # shellcheck disable=SC2030,SC2031
      export DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET="$resolved"
    fi
  }
  prepare_discord_hosted_bot_oauth_secret
  # shellcheck disable=SC2031
  [ "$DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET" = "operator-typed-client-secret-value" ] || fail "Test 6: prepare_discord_hosted_bot_oauth_secret did not export the resolved value"
)
rm -f runtime/secrets/discord-hosted-bot-oauth-client-secret.enc
rm -f runtime/generated/.secrets-migrated/discord-hosted-bot-oauth-client-secret.done
(
  unset DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET DUNE_KEK_FILE DUNE_AGE_IDENTITY_FILE 2>/dev/null || true
  # shellcheck disable=SC1091
  source runtime/scripts/lib/console-secrets-env.sh
  # Deliberately scoped to this subshell only (SC2030/SC2031).
  prepare_discord_hosted_bot_oauth_secret() {
    # shellcheck disable=SC2031
    if [ -n "${DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET:-}" ]; then return 0; fi
    local resolved
    resolved="$(resolve_discord_hosted_bot_oauth_client_secret)"
    if [ -n "$resolved" ]; then
      # shellcheck disable=SC2030,SC2031
      export DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET="$resolved"
    fi
  }
  prepare_discord_hosted_bot_oauth_secret
  # shellcheck disable=SC2031
  [ -z "${DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET:-}" ] || fail "Test 6b: prepare_discord_hosted_bot_oauth_secret exported a value for a never-configured secret"
)
echo "PASS: Test 6 (console.sh's prepare_discord_hosted_bot_oauth_secret exports correctly, and stays silent when unconfigured)"

echo "All Stage 3 secrets tests passed."
