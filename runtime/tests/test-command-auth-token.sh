#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"

  grep -Fq -- "$pattern" "$file" || fail "$file missing: $pattern"
}

expected_fallback="$(sed -n 's/^BUILTIN_COMMAND_AUTH_TOKEN="\(.*\)"$/\1/p' runtime/scripts/command-auth-token.sh)"
[ -n "$expected_fallback" ] || fail "command token helper is missing its compatibility fallback"

actual_fallback="$(
  unset DUNE_COMMAND_AUTH_TOKEN
  # shellcheck source=../scripts/command-auth-token.sh
  source runtime/scripts/command-auth-token.sh
  command_auth_token
)"
[ "$actual_fallback" = "$expected_fallback" ] || fail "default command token resolution returned the wrong value"

actual_override="$(
  export DUNE_COMMAND_AUTH_TOKEN="test-explicit-override"
  # shellcheck source=../scripts/command-auth-token.sh
  source runtime/scripts/command-auth-token.sh
  command_auth_token
)"
[ "$actual_override" = "test-explicit-override" ] || fail "explicit command token override was not honored"

assert_contains runtime/scripts/admin-tools.sh 'source runtime/scripts/command-auth-token.sh'
assert_contains console/api/src/rmq.js 'const BUILTIN_COMMAND_AUTH_TOKEN = "Nu6VmPWUMvdPMeB7qErr"'
assert_contains console/api/src/rmq.js 'process.env.DUNE_COMMAND_AUTH_TOKEN'
assert_contains .env.example 'upstream command-auth token expected by the game server'

echo "PASS: shell command auth token resolver uses its fallback and honors an explicit override"
