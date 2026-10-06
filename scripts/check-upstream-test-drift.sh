#!/usr/bin/env bash
set -euo pipefail

# Requirement 22 (this account's operating docs): detect when upstream
# (Red-Blink/dune-awakening-selfhost-docker) adds or changes tests in
# console/api/test/ that this fork hasn't picked up. A green CI on this
# fork that never exercises upstream's newer test coverage is a false
# sense of security, not a real signal the fork is current.
#
# Run from the repo root. Exits non-zero (and prints a report) when
# drift is found, so mentat-observatory's hourly validate-and-report.sh
# can surface it the same way it surfaces new releases and CI failures.
#
# Two checks, deliberately asymmetric in confidence:
#   1. NEW test files upstream has that this fork's console/api/test/
#      does not have at all. High confidence, zero false-positive risk
#      (a file either exists or it doesn't) -- this is the same class of
#      gap the #964 sync repeatedly found by hand (skillPointRank.test.js,
#      blueprintArrayBoundsPatch.test.js, setupConfig.test.js, and others
#      all started life exactly this way: a real upstream commit added a
#      test file, and only manual batch-by-batch review caught it).
#   2. DIVERGED test files -- present in both, but upstream's version has
#      MORE test cases than this fork's version of the same file. This is
#      a heuristic (counting top-level test()/it() calls), not a raw
#      content diff, deliberately: this fork's test files routinely,
#      legitimately differ from upstream's byte-for-byte (different
#      import structure, extra fork-only test cases, fork-specific
#      fixtures) without that difference meaning anything is missing. A
#      raw diff would make nearly every shared file "diverged" forever
#      and drown the one signal this check exists to surface. Counting
#      test cases catches the case that actually matters -- upstream
#      added real new coverage to a file this fork also has -- without
#      flagging every legitimate structural difference.

cd "$(dirname "$0")/.."

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "check-upstream-test-drift.sh: no 'upstream' remote configured; skipping." >&2
  exit 0
fi

git fetch upstream main --quiet 2>&1 | grep -v '^$' || true

FORK_TEST_DIR="console/api/test"
UPSTREAM_REF="upstream/main"

if [ ! -d "$FORK_TEST_DIR" ]; then
  echo "check-upstream-test-drift.sh: $FORK_TEST_DIR not found; skipping." >&2
  exit 0
fi

mapfile -t upstream_files < <(git ls-tree -r --name-only "$UPSTREAM_REF" -- "$FORK_TEST_DIR" | grep '\.test\.js$' | sort)

new_files=()
for f in "${upstream_files[@]}"; do
  if [ ! -e "$f" ]; then
    new_files+=("$f")
  fi
done

diverged_files=()
for f in "${upstream_files[@]}"; do
  [ -e "$f" ] || continue
  upstream_count=$(git show "${UPSTREAM_REF}:${f}" 2>/dev/null | grep -cE '^\s*(test|it)\(' || true)
  fork_count=$(grep -cE '^\s*(test|it)\(' "$f" 2>/dev/null || true)
  if [ "${upstream_count:-0}" -gt "${fork_count:-0}" ]; then
    diverged_files+=("${f} (upstream: ${upstream_count} cases, fork: ${fork_count} cases)")
  fi
done

exit_code=0

if [ "${#new_files[@]}" -gt 0 ]; then
  echo "NEW upstream test files not present in this fork:"
  printf '  %s\n' "${new_files[@]}"
  exit_code=1
fi

if [ "${#diverged_files[@]}" -gt 0 ]; then
  echo "DIVERGED: upstream's version has more test cases than this fork's:"
  printf '  %s\n' "${diverged_files[@]}"
  exit_code=1
fi

if [ "$exit_code" -eq 0 ]; then
  echo "No upstream test drift detected (${#upstream_files[@]} upstream test files checked)."
fi

exit "$exit_code"
