#!/usr/bin/env bash
set -euo pipefail

# Regression coverage for dune-awakening-selfhost-docker#1164: the autoscaler's
# Director log cache directory (runtime/generated/director-log-cache.XXXXXX) is
# removed by an EXIT trap, which a SIGKILL / OOM kill / crash loop skips. Nothing
# removed the leftovers. sweep_orphan_director_log_caches removes only directories
# no process has touched for 30 minutes.
#
# The function is extracted and run in a throwaway directory; nothing outside it
# is touched. AUTOSCALER_UNDER_TEST selects another copy of the script (mutations).

cd "$(dirname "$0")/.."

script="${AUTOSCALER_UNDER_TEST:-runtime/scripts/autoscaler.sh}"
bash -n "$script"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

python3 - "$script" "$work/sweep.sh" <<'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("sweep_orphan_director_log_caches() {")
line_end = text.index("\n", start) + 1
nxt = re.search(r"^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{", text[line_end:], re.M)
Path(sys.argv[2]).write_text(text[start : line_end + nxt.start()], encoding="utf-8")
PY

old="$(date -d '3 hours ago' '+%Y%m%d%H%M')"
mkdir -p "$work/run/runtime/generated" "$work/outside-target"

# orphan: every file and the directory itself untouched for 3 hours
mkdir "$work/run/runtime/generated/director-log-cache.ORPHAN"
echo log >"$work/run/runtime/generated/director-log-cache.ORPHAN/recent.sqlite"
echo log >"$work/run/runtime/generated/director-log-cache.ORPHAN/recent.sqlite-wal"
# live: a follower touched a file a minute ago (the directory itself is old)
mkdir "$work/run/runtime/generated/director-log-cache.LIVE"
echo log >"$work/run/runtime/generated/director-log-cache.LIVE/recent.sqlite"
# this process's own directory, even if it looks idle
mkdir "$work/run/runtime/generated/director-log-cache.OWN"
echo log >"$work/run/runtime/generated/director-log-cache.OWN/recent.sqlite"
# a symlink named like a cache must be skipped, never followed
echo keep >"$work/outside-target/precious"
ln -s "$work/outside-target" "$work/run/runtime/generated/director-log-cache.LINK"
# unrelated directory
mkdir "$work/run/runtime/generated/other-dir"
echo keep >"$work/run/runtime/generated/other-dir/file"

for path in \
  "$work/run/runtime/generated/director-log-cache.ORPHAN/recent.sqlite" \
  "$work/run/runtime/generated/director-log-cache.ORPHAN/recent.sqlite-wal" \
  "$work/run/runtime/generated/director-log-cache.ORPHAN" \
  "$work/run/runtime/generated/director-log-cache.LIVE" \
  "$work/run/runtime/generated/director-log-cache.OWN/recent.sqlite" \
  "$work/run/runtime/generated/director-log-cache.OWN"; do
  touch -t "$old" "$path"
done
touch -h -t "$old" "$work/run/runtime/generated/director-log-cache.LINK"  # old link: only the guard keeps it
touch "$work/run/runtime/generated/director-log-cache.LIVE/recent.sqlite"  # fresh

cat >"$work/run.sh" <<EOF
set -euo pipefail
cd "$work/run"
. "$work/sweep.sh"
DIRECTOR_LOG_CACHE_DIR="runtime/generated/director-log-cache.OWN"
sweep_orphan_director_log_caches
echo SURVIVED
EOF

bash "$work/run.sh" >"$work/out" 2>&1 || { cat "$work/out" >&2; fail "the sweep aborted"; }
grep -q '^SURVIVED$' "$work/out" || fail "the sweep did not finish"

gen="$work/run/runtime/generated"
[ ! -e "$gen/director-log-cache.ORPHAN" ] || fail "the orphaned cache directory was not removed"
[ -e "$gen/director-log-cache.LIVE/recent.sqlite" ] || fail "a cache with a recently written file was removed"
[ -e "$gen/director-log-cache.OWN/recent.sqlite" ] || fail "this process's own cache directory was removed"
[ -L "$gen/director-log-cache.LINK" ] || fail "a symlink named like a cache was removed"
[ -e "$work/outside-target/precious" ] || fail "the sweep followed a symlink and deleted its target"
[ -e "$gen/other-dir/file" ] || fail "an unrelated directory was touched"
grep -q 'Removing orphaned Director log cache .*ORPHAN' "$work/out" || fail "removal was not logged"

# no cache directories at all: the unmatched glob must not abort the autoscaler
rm -rf "$gen"/director-log-cache.*
bash "$work/run.sh" >"$work/out2" 2>&1 || { cat "$work/out2" >&2; fail "the sweep aborted when there was nothing to sweep"; }

# A leftover this user cannot inspect or delete (for example a root-owned one from a manual run) must
# not end the autoscaler at startup: it runs under `set -e` and the container restarts on exit, so a
# fatal sweep would crash-loop until someone deleted the directory by hand (review of PR #1172).
# (Running as root here would bypass real permission errors, so the failures are injected.)
orphan_again() {
  mkdir -p "$gen/director-log-cache.STUCK"
  echo log >"$gen/director-log-cache.STUCK/recent.sqlite"
  touch -t "$old" "$gen/director-log-cache.STUCK/recent.sqlite" "$gen/director-log-cache.STUCK"
}
run_with() {
  cat >"$work/run-injected.sh" <<EOF2
set -euo pipefail
cd "$work/run"
. "$work/sweep.sh"
$1
DIRECTOR_LOG_CACHE_DIR="runtime/generated/director-log-cache.OWN"
sweep_orphan_director_log_caches
echo SURVIVED
EOF2
  bash "$work/run-injected.sh" 2>&1
}

orphan_again
out="$(run_with 'rm() { return 1; }')" || fail "an undeletable orphan ended the sweep (and with it the autoscaler)"
echo "$out" | grep -q '^SURVIVED$' || fail "the sweep did not finish when rm failed"
echo "$out" | grep -q 'WARN could not remove .*STUCK' || fail "an undeletable orphan was not reported"
[ -e "$gen/director-log-cache.STUCK/recent.sqlite" ] || fail "the directory vanished although rm failed"

out="$(run_with 'find() { return 1; }')" || fail "a directory find could not inspect ended the sweep"
echo "$out" | grep -q '^SURVIVED$' || fail "the sweep did not finish when find failed"
echo "$out" | grep -q 'Removing orphaned' && fail "a directory that could not be inspected was treated as stale"
[ -e "$gen/director-log-cache.STUCK/recent.sqlite" ] || fail "an uninspectable directory was removed"

echo "PASS: orphaned caches are removed; live, own, symlinked and unrelated paths are kept; nothing to sweep, or a directory that cannot be inspected or deleted, is not an error"
