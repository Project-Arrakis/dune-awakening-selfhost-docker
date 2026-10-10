#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/bin"

cat > "$test_root/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
state="$(cat "$DUNE_POSTGRES_TEST_STATE")"
printf '%s\n' "$*" >> "$DUNE_POSTGRES_TEST_LOG"
case "$1" in
  ps)
    [ "$state" != "list-failure" ] || exit 1
    [ "$state" = "absent" ] || printf '%s\n' dune-postgres
    ;;
  inspect)
    [ "$state" != "absent" ]
    [ "$state" != "running" ] || printf '%s\n' true
    [ "$state" != "stopped" ] || printf '%s\n' false
    [ "$state" != "stop-failure" ] || printf '%s\n' true
    ;;
  stop)
    [ "$2" = "--time" ] && [ "$3" = "120" ] && [ "$4" = "dune-postgres" ]
    [ "$state" != "stop-failure" ] || exit 1
    printf '%s\n' stopped > "$DUNE_POSTGRES_TEST_STATE"
    ;;
  rm)
    [ "$2" = "dune-postgres" ] && [ "$state" = "stopped" ]
    printf '%s\n' absent > "$DUNE_POSTGRES_TEST_STATE"
    ;;
  *) exit 2 ;;
esac
MOCK
chmod +x "$test_root/bin/docker"
export PATH="$test_root/bin:$PATH"
export DUNE_POSTGRES_TEST_STATE="$test_root/state"
export DUNE_POSTGRES_TEST_LOG="$test_root/docker.log"
script="$repo_root/runtime/scripts/stop-postgres-container.sh"

printf '%s\n' running > "$DUNE_POSTGRES_TEST_STATE"
"$script"
[ "$(cat "$DUNE_POSTGRES_TEST_STATE")" = "absent" ]
grep -qx 'stop --time 120 dune-postgres' "$DUNE_POSTGRES_TEST_LOG"
grep -qx 'rm dune-postgres' "$DUNE_POSTGRES_TEST_LOG"
if grep -Fq 'rm -f' "$DUNE_POSTGRES_TEST_LOG"; then exit 1; fi

: > "$DUNE_POSTGRES_TEST_LOG"
printf '%s\n' stopped > "$DUNE_POSTGRES_TEST_STATE"
"$script"
[ "$(cat "$DUNE_POSTGRES_TEST_STATE")" = "absent" ]
if grep -q '^stop ' "$DUNE_POSTGRES_TEST_LOG"; then exit 1; fi

: > "$DUNE_POSTGRES_TEST_LOG"
printf '%s\n' absent > "$DUNE_POSTGRES_TEST_STATE"
"$script"
if grep -Eq '^(stop|rm) ' "$DUNE_POSTGRES_TEST_LOG"; then exit 1; fi

: > "$DUNE_POSTGRES_TEST_LOG"
printf '%s\n' stop-failure > "$DUNE_POSTGRES_TEST_STATE"
if "$script"; then exit 1; fi
[ "$(cat "$DUNE_POSTGRES_TEST_STATE")" = "stop-failure" ]
if grep -q '^rm ' "$DUNE_POSTGRES_TEST_LOG"; then exit 1; fi

: > "$DUNE_POSTGRES_TEST_LOG"
printf '%s\n' list-failure > "$DUNE_POSTGRES_TEST_STATE"
if "$script"; then exit 1; fi
if grep -Eq '^(stop|rm) ' "$DUNE_POSTGRES_TEST_LOG"; then exit 1; fi

grep -Fq 'runtime/scripts/stop-postgres-container.sh' "$repo_root/runtime/scripts/stop-all.sh"
grep -Fq 'runtime/scripts/stop-postgres-container.sh' "$repo_root/runtime/scripts/start-postgres.sh"
echo "PostgreSQL shutdown tests passed."
