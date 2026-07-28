#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

input='server=3Z9XgjZmTh\u002BDEoLf58Pjew suffix=abc\u002Fdef\u003D untouched=\\u002B invalid=\uZZZZ'
expected='server=3Z9XgjZmTh+DEoLf58Pjew suffix=abc/def= untouched=\+ invalid=\uZZZZ'
actual="$(printf '%s' "$input" | python3 runtime/scripts/decode-log-unicode-escapes.py)"

[ "$actual" = "$expected" ] || {
  printf 'expected: %s\nactual:   %s\n' "$expected" "$actual" >&2
  fail "Director log Unicode escapes were not normalized correctly"
}

grep -Fq 'python3 runtime/scripts/decode-log-unicode-escapes.py' runtime/scripts/autoscaler.sh \
  || fail "autoscaler does not normalize Director logs before matching server IDs"

echo "PASS: Director log server IDs are normalized before matching"
