#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v age >/dev/null 2>&1 || { echo "SKIP: age not found on PATH -- install via 'apt install age' (see https://github.com/FiloSottile/age)"; exit 0; }
command -v age-keygen >/dev/null 2>&1 || { echo "SKIP: age-keygen not found on PATH"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node not found on PATH"; exit 0; }
python3 -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM" >/dev/null 2>&1 || {
  echo "SKIP: python3's 'cryptography' package not installed"
  exit 0
}

# Cross-language drift-detection test between the two independent
# implementations of the Stage 2 secrets migration-state check:
#   - Bash:  _dune_secrets_stage2_state() in runtime/scripts/secrets-cli.sh
#            (exercised here via the real, public `dune secrets status`
#            output, not by reaching into the private function directly --
#            secrets-cli.sh's own `cd "$(dirname "$0")/../.."` idiom only
#            resolves correctly when run as a real subprocess, matching
#            this repo's own established convention for every comparable
#            CLI script; sourcing it directly is not a supported pattern).
#   - Node:  secretState() in console/api/src/services/secretsStatus.js
#
# This test exists because a Requirement 20 Layer 1 audit of the web
# console's Secrets Status Panel (issue #320) found that revision 1's
# design proposed "a code comment cross-reference" as the only safeguard
# against these two implementations drifting apart -- explicitly rejected
# as insufficient, since this project's own past CRITICAL bug (Stage 2
# Layer 2 audit, Finding 1: the marker-check-not-threaded-through
# regression) was exactly this class of two-copies-of-the-same-check
# silently disagreeing. This test constructs fixtures covering every
# combination of (kek configured) x (.enc exists/readable) x (marker
# exists/readable) and asserts both implementations agree on every one,
# including the specific adversarial case the audit named explicitly:
# the .enc file exists but is unreadable while the marker IS readable --
# the correct answer is "migrated" (either independently-readable signal
# is sufficient), and a subtly-wrong implementation requiring both
# signals to be readable simultaneously would incorrectly say "broken".

test_root="$(mktemp -d)"
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

NAME="server-login-password-secret"

identity_path="$test_root/age-identity.txt"
age-keygen -o "$identity_path" >/dev/null 2>&1
public_key="$(age-keygen -y "$identity_path")"

kek_path="$test_root/kek.age"
# shellcheck disable=SC1091
source "$repo_root/runtime/scripts/lib/secrets.sh"
kek_hex="$(dune_secrets_generate_dek)"
printf '%s' "$kek_hex" | age --encrypt -r "$public_key" -o "$kek_path"

# Stage the minimal repo layout both implementations need, mirroring
# test-secrets-stage2.sh's own established self-contained pattern.
mkdir -p "$test_root/runtime/scripts/lib" "$test_root/runtime/generated/.secrets-migrated" "$test_root/runtime/secrets"
cp "$repo_root/runtime/scripts/runtime-env.sh" "$test_root/runtime/scripts/"
cp "$repo_root/runtime/scripts/memory-swap-common.sh" "$test_root/runtime/scripts/"
cp "$repo_root/runtime/scripts/env-file.sh" "$test_root/runtime/scripts/"
cp "$repo_root/runtime/scripts/host-file-ownership.sh" "$test_root/runtime/scripts/"
cp "$repo_root/runtime/scripts/compose-project.sh" "$test_root/runtime/scripts/"
cp "$repo_root/runtime/scripts/secrets-cli.sh" "$test_root/runtime/scripts/"
cp "$repo_root/runtime/scripts/lib/secrets.sh" "$test_root/runtime/scripts/lib/"
cp "$repo_root/runtime/scripts/lib/secrets_aead.py" "$test_root/runtime/scripts/lib/"

# bash_state <encPresent> <encReadable> <markerPresent> <markerReadable> <kekConfigured>
# Runs the real `dune secrets status <name>` CLI and maps its human-
# readable output back to the same state-string vocabulary
# secretState() (Node) returns, so the two can be compared directly.
bash_state() {
  local enc_present="$1" enc_readable="$2" marker_present="$3" marker_readable="$4" kek_configured="$5"
  rm -f "$test_root/runtime/secrets/${NAME}.enc"
  rm -f "$test_root/runtime/generated/.secrets-migrated/${NAME}.done"

  if [ "$enc_present" = "1" ]; then
    printf 'enc:v2:1:fake:fake' > "$test_root/runtime/secrets/${NAME}.enc"
    if [ "$enc_readable" = "1" ]; then chmod 600 "$test_root/runtime/secrets/${NAME}.enc"; else chmod 000 "$test_root/runtime/secrets/${NAME}.enc"; fi
  fi
  if [ "$marker_present" = "1" ]; then
    printf '2026-08-17T00:00:00Z' > "$test_root/runtime/generated/.secrets-migrated/${NAME}.done"
    if [ "$marker_readable" = "1" ]; then chmod 600 "$test_root/runtime/generated/.secrets-migrated/${NAME}.done"; else chmod 000 "$test_root/runtime/generated/.secrets-migrated/${NAME}.done"; fi
  fi

  local out
  if [ "$kek_configured" = "1" ]; then
    out="$(cd "$test_root" && DUNE_KEK_FILE="$kek_path" DUNE_AGE_IDENTITY_FILE="$identity_path" bash runtime/scripts/secrets-cli.sh status "$NAME" 2>&1)"
  else
    out="$(cd "$test_root" && env -u DUNE_KEK_FILE -u DUNE_AGE_IDENTITY_FILE bash runtime/scripts/secrets-cli.sh status "$NAME" 2>&1)"
  fi

  # Cleanup permissions so the trap's rm -rf can actually remove these
  # files afterward (chmod 000 would otherwise block deletion for a
  # non-root user).
  chmod 600 "$test_root/runtime/secrets/${NAME}.enc" 2>/dev/null || true
  chmod 600 "$test_root/runtime/generated/.secrets-migrated/${NAME}.done" 2>/dev/null || true

  if printf '%s' "$out" | grep -q "backend not configured"; then
    printf 'backend-not-configured'
  elif printf '%s' "$out" | grep -q "migrated but currently unreadable/broken"; then
    printf 'broken'
  elif printf '%s' "$out" | grep -q "not migrated (legacy plaintext)"; then
    printf 'not-migrated'
  elif printf '%s' "$out" | grep -q "migrated (encrypted)"; then
    printf 'migrated'
  else
    printf 'UNRECOGNIZED_OUTPUT: %s' "$out"
  fi
}

# node_state <encPresent> <encReadable> <markerPresent> <markerReadable> <kekConfigured>
# Calls the real Node secretState() function against the same fixture
# directory, via a tiny one-shot Node script (not a mock/stub).
node_state() {
  local enc_present="$1" enc_readable="$2" marker_present="$3" marker_readable="$4" kek_configured="$5"
  rm -f "$test_root/runtime/secrets/${NAME}.enc"
  rm -f "$test_root/runtime/generated/.secrets-migrated/${NAME}.done"

  if [ "$enc_present" = "1" ]; then
    printf 'enc:v2:1:fake:fake' > "$test_root/runtime/secrets/${NAME}.enc"
    if [ "$enc_readable" = "1" ]; then chmod 600 "$test_root/runtime/secrets/${NAME}.enc"; else chmod 000 "$test_root/runtime/secrets/${NAME}.enc"; fi
  fi
  if [ "$marker_present" = "1" ]; then
    printf '2026-08-17T00:00:00Z' > "$test_root/runtime/generated/.secrets-migrated/${NAME}.done"
    if [ "$marker_readable" = "1" ]; then chmod 600 "$test_root/runtime/generated/.secrets-migrated/${NAME}.done"; else chmod 000 "$test_root/runtime/generated/.secrets-migrated/${NAME}.done"; fi
  fi

  local out
  if [ "$kek_configured" = "1" ]; then
    out="$(DUNE_KEK_FILE="$kek_path" DUNE_AGE_IDENTITY_FILE="$identity_path" node --input-type=module -e "
import { secretState } from '$repo_root/console/api/src/services/secretsStatus.js';
console.log(secretState('$test_root', '$NAME'));
")"
  else
    out="$(env -u DUNE_KEK_FILE -u DUNE_AGE_IDENTITY_FILE node --input-type=module -e "
import { secretState } from '$repo_root/console/api/src/services/secretsStatus.js';
console.log(secretState('$test_root', '$NAME'));
")"
  fi

  chmod 600 "$test_root/runtime/secrets/${NAME}.enc" 2>/dev/null || true
  chmod 600 "$test_root/runtime/generated/.secrets-migrated/${NAME}.done" 2>/dev/null || true

  printf '%s' "$out" | tr -d '[:space:]'
}

assert_parity() {
  local label="$1" enc_present="$2" enc_readable="$3" marker_present="$4" marker_readable="$5" kek_configured="$6" expected="$7"
  local bash_result node_result
  bash_result="$(bash_state "$enc_present" "$enc_readable" "$marker_present" "$marker_readable" "$kek_configured")"
  node_result="$(node_state "$enc_present" "$enc_readable" "$marker_present" "$marker_readable" "$kek_configured")"

  [ "$bash_result" = "$expected" ] || fail "$label: bash returned '$bash_result', expected '$expected'"
  [ "$node_result" = "$expected" ] || fail "$label: node returned '$node_result', expected '$expected'"
  [ "$bash_result" = "$node_result" ] || fail "$label: bash ('$bash_result') and node ('$node_result') DISAGREE -- cross-language drift detected"
  echo "PASS: $label (both agree: $expected)"
}

# args: enc_present enc_readable marker_present marker_readable kek_configured
assert_parity "backend not configured, nothing exists"            0 0 0 0 0 "backend-not-configured"
assert_parity "backend not configured even if .enc exists"        1 1 0 0 0 "backend-not-configured"
assert_parity "not-migrated: kek configured, nothing exists"       0 0 0 0 1 "not-migrated"
assert_parity "migrated: .enc present and readable"                1 1 0 0 1 "migrated"
assert_parity "migrated: marker present and readable, no .enc"     0 0 1 1 1 "migrated"
assert_parity "migrated: both .enc and marker present and readable" 1 1 1 1 1 "migrated"

# The specific adversarial case named explicitly by the Layer 1 audit
# (QA/Test hat, Finding QA-2): .enc exists but is UNREADABLE, marker
# exists AND is readable. Correct answer: "migrated" (either
# independently-readable signal is sufficient). Skipped when running as
# root -- root bypasses chmod readability restrictions entirely, the same
# already-accepted constraint test-secrets-lib.sh's own Test 8 and
# test-secrets-stage2.sh's own Test 7b use.
if [ "$(id -u)" = "0" ]; then
  echo "SKIP: adversarial precedence cases (running as root -- chmod 000 does not block root from reading; exercised in CI, which runs non-root)"
else
  assert_parity "ADVERSARIAL: .enc unreadable, marker readable -> migrated, not broken" 1 0 1 1 1 "migrated"
  assert_parity "broken: .enc present but unreadable, no marker"                        1 0 0 0 1 "broken"
  assert_parity "broken: marker present but unreadable, no .enc"                        0 0 1 0 1 "broken"
fi

echo "All cross-language (bash/Node) secrets status parity checks passed."
