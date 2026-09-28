#!/usr/bin/env bash
set -euo pipefail

# The autoscaler and the Coriolis coordinator run runtime scripts inside a
# container that never sources .env. Anything an operator configures there only
# reaches them if the launcher hands it over on the `docker run` command line --
# which is why the scan-interval knobs were inert until they were forwarded, and
# why the Postgres library inside those containers has to be told which
# published port to dial before it can talk TCP instead of a container exec.

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Run the real launchers against a throwaway repository root, so a developer's
# own .env cannot decide what this test observes. Only runtime/scripts is
# borrowed -- unmodified -- from the checkout under test.
fake_root="$test_root/repo"
mkdir -p "$fake_root/runtime"
ln -s "$repo_root/runtime/scripts" "$fake_root/runtime/scripts"

export DUNE_RUN_ARGV_LOG="$test_root/run.argv"
export DUNE_RUNNING_CONTAINERS="$test_root/running"

mkdir -p "$test_root/bin"
cat > "$test_root/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$1 ${2:-}" in
  "ps -a"|"ps --format")
    # Every dependency the launchers require is up; the container they are
    # about to start exists only once this mock has "run" it.
    printf '%s\n' dune-director dune-postgres
    cat "$DUNE_RUNNING_CONTAINERS"
    ;;
  "run -d")
    printf '%s\n' "$@" > "$DUNE_RUN_ARGV_LOG"
    # Record the --name so the launcher's own post-start liveness check passes.
    awk '/^--name$/ { getline; print }' "$DUNE_RUN_ARGV_LOG" >> "$DUNE_RUNNING_CONTAINERS"
    printf '%s\n' 0123456789ab
    ;;
  "image inspect"|"rm -f"|"logs --tail") ;;
  *)
    echo "unexpected docker invocation: $*" >&2
    exit 1
    ;;
esac
MOCK
chmod +x "$test_root/bin/docker"
export PATH="$test_root/bin:$PATH"

# Skip the permission repair (it would run a container of its own) and pin the
# socket group, so the recorded argv depends only on what we are testing.
export DUNE_RUNTIME_PERMISSIONS_REPAIRED=1
export DOCKER_SOCKET_GID=0

launch() {
  local script="$1"
  shift
  : > "$DUNE_RUNNING_CONTAINERS"
  rm -f "$DUNE_RUN_ARGV_LOG"
  env "$@" "$fake_root/runtime/scripts/$script" >/dev/null \
    || fail "$script exited non-zero"
  [ -s "$DUNE_RUN_ARGV_LOG" ] || fail "$script never reached docker run"
}

# Report the value the recorded argv passes for an environment key, and nothing
# at all if the key is absent -- a bare `grep KEY=` would also be satisfied by
# the value of some unrelated flag.
forwarded() {
  awk -v key="$1" '$0 == "-e" { getline; if (index($0, key "=") == 1) print substr($0, length(key) + 2) }' \
    "$DUNE_RUN_ARGV_LOG"
}

# --- the autoscaler's configuration reaches the container ----------------

launch start-autoscaler.sh \
  DUNE_AUTOSCALER_INTERVAL=9 \
  DUNE_AUTOSCALER_DEMAND_INTERVAL=4 \
  POSTGRES_PORT=25432 \
  DUNE_PSQL_TRANSPORT=exec

[ "$(forwarded DUNE_AUTOSCALER_INTERVAL)" = "9" ] || fail "the scan interval is not forwarded"
[ "$(forwarded DUNE_AUTOSCALER_DEMAND_INTERVAL)" = "4" ] || fail "the demand interval is not forwarded"
[ "$(forwarded POSTGRES_PORT)" = "25432" ] || fail "start-autoscaler.sh does not forward POSTGRES_PORT"
[ "$(forwarded DUNE_PSQL_TRANSPORT)" = "exec" ] || fail "start-autoscaler.sh does not forward DUNE_PSQL_TRANSPORT"

# Unset means unset: the key is still handed over, empty, so the script inside
# the container applies its own default instead of inheriting a stale value.
launch start-autoscaler.sh
for key in DUNE_AUTOSCALER_INTERVAL DUNE_AUTOSCALER_DEMAND_INTERVAL POSTGRES_PORT DUNE_PSQL_TRANSPORT; do
  [ "$(forwarded "$key" | wc -l)" = "1" ] || fail "start-autoscaler.sh drops $key when it is unset"
  [ -z "$(forwarded "$key")" ] || fail "start-autoscaler.sh invented a value for $key"
done

# --- the Coriolis coordinator runs the same query path -------------------

# coriolis-coordinator.sh issues no SQL itself, but restart-game-farm.sh hands
# off to sietches.sh, recycle-world-game-servers.sh and the two override
# publishers, all of which query through the Postgres library.
launch start-coriolis-coordinator.sh POSTGRES_PORT=25432 DUNE_PSQL_TRANSPORT=exec
[ "$(forwarded POSTGRES_PORT)" = "25432" ] \
  || fail "start-coriolis-coordinator.sh does not forward POSTGRES_PORT"
[ "$(forwarded DUNE_PSQL_TRANSPORT)" = "exec" ] \
  || fail "start-coriolis-coordinator.sh does not forward DUNE_PSQL_TRANSPORT"

# --- the intervals are validated where they are read ---------------------

# Execute the real guard out of autoscaler.sh rather than a copy of it: the
# script itself cannot be run here -- it ends in an endless loop -- but these
# lines are self-contained, and they are what keeps a typo in .env from
# turning the scan loop into a busy loop or stalling it outright.
python3 - "$repo_root/runtime/scripts/autoscaler.sh" "$test_root/intervals.sh" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index('INTERVAL="${DUNE_AUTOSCALER_INTERVAL:-5}"')
end = text.index('\n\n', start)
block = text[start:end]
assert "DEMAND_INTERVAL" in block, "the demand-interval default moved out of this block"
Path(sys.argv[2]).write_text(block, encoding="utf-8")
PY

intervals() {
  env -u DUNE_AUTOSCALER_INTERVAL -u DUNE_AUTOSCALER_DEMAND_INTERVAL "$@" \
    bash -c 'source "$0"; printf "%s %s\n" "$INTERVAL" "$DEMAND_INTERVAL"' "$test_root/intervals.sh"
}

[ "$(intervals 2>/dev/null)" = "5 2" ] || fail "the shipped interval defaults changed"
[ "$(intervals DUNE_AUTOSCALER_INTERVAL=9 DUNE_AUTOSCALER_DEMAND_INTERVAL=4)" = "9 4" ] \
  || fail "a valid interval was not honoured"

for bad in 0 abc 2.5 -1 ""; do
  [ "$(intervals "DUNE_AUTOSCALER_INTERVAL=$bad" 2>/dev/null)" = "5 2" ] \
    || fail "DUNE_AUTOSCALER_INTERVAL=$bad was not rejected"
  [ "$(intervals "DUNE_AUTOSCALER_DEMAND_INTERVAL=$bad" 2>/dev/null)" = "5 2" ] \
    || fail "DUNE_AUTOSCALER_DEMAND_INTERVAL=$bad was not rejected"
done

intervals DUNE_AUTOSCALER_INTERVAL=0 2>"$test_root/err" >/dev/null
grep -q 'Invalid DUNE_AUTOSCALER_INTERVAL' "$test_root/err" \
  || fail "a rejected scan interval was replaced silently"

echo "Autoscaler environment forwarding checks passed."
