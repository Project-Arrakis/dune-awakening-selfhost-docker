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

assert_not_contains_anywhere() {
  local pattern="$1"
  local output
  shift
  output="$(mktemp)"

  if grep -RIn -- "$pattern" "$@" >"$output"; then
    cat "$output" >&2
    rm -f "$output"
    fail "unexpected source match: $pattern"
  fi
  rm -f "$output"
}

assert_contains runtime/scripts/admin-tools.sh 'BUILTIN_COMMAND_AUTH_TOKEN="Nu6VmPWUMvdPMeB7qErr"'
assert_contains runtime/scripts/admin-tools.sh 'DUNE_COMMAND_AUTH_TOKEN'
assert_contains console/api/src/rmq.js 'const BUILTIN_COMMAND_AUTH_TOKEN = "Nu6VmPWUMvdPMeB7qErr"'
assert_contains console/api/src/rmq.js 'process.env.DUNE_COMMAND_AUTH_TOKEN'
assert_contains .env.example 'upstream command-auth token expected by the game server'

echo "PASS: command auth token uses upstream fallback with explicit env override"
