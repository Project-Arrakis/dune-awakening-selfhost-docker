#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin"

cat > "$TEST_ROOT/bin/python3" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
map_name="${@: -1}"
case "$map_name" in
  DeepDesert_1) printf 'coriolis_db_wipe_enabled\t%s\n' "${TEST_DEEPDESERT_WIPE:-True}" ;;
  Survival_1) printf 'coriolis_db_wipe_enabled\t%s\n' "${TEST_HAGGA_WIPE:-True}" ;;
  *) exit 2 ;;
esac
MOCK
chmod +x "$TEST_ROOT/bin/python3"

cat > "$TEST_ROOT/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  ps)
    printf '%s\n' dune-postgres
    ;;
  exec)
    printf '%s\n' "$*" > "${TEST_DOCKER_ARGS:?}"
    cat > "${TEST_SQL_INPUT:?}"
    ;;
  *) exit 2 ;;
esac
MOCK
chmod +x "$TEST_ROOT/bin/docker"

export PATH="$TEST_ROOT/bin:$PATH"
export TEST_DOCKER_ARGS="$TEST_ROOT/docker-args"
export TEST_SQL_INPUT="$TEST_ROOT/cleanup.sql"

cd "$REPO_ROOT"

# The stock enabled wipe owns cleanup; the surgical path must stay idle.
TEST_DEEPDESERT_WIPE=True TEST_HAGGA_WIPE=True \
  runtime/scripts/coriolis-data-cleanup.sh > "$TEST_ROOT/enabled.out"
grep -q 'game will clean cycle data' "$TEST_ROOT/enabled.out"
[ ! -e "$TEST_DOCKER_ARGS" ]

# Map-effective settings independently select the cleanup scope.
TEST_DEEPDESERT_WIPE=False TEST_HAGGA_WIPE=True \
  runtime/scripts/coriolis-data-cleanup.sh > "$TEST_ROOT/deep.out"
grep -q -- '-v cleanup_deepdesert=1 -v cleanup_hagga=0' "$TEST_DOCKER_ARGS"
grep -q 'delete_markers_for_all_players' "$TEST_SQL_INPUT"
grep -q "DELETE FROM dune.resourcefield_state WHERE map = 'DeepDesert'" "$TEST_SQL_INPUT"
if grep -q 'delete_actors_and_respawns_on_server' "$TEST_SQL_INPUT"; then
  echo "Unsafe actor cleanup appeared in the Coriolis cleanup transaction." >&2
  exit 1
fi

TEST_DEEPDESERT_WIPE=True TEST_HAGGA_WIPE=False \
  runtime/scripts/coriolis-data-cleanup.sh > "$TEST_ROOT/hagga.out"
grep -q -- '-v cleanup_deepdesert=0 -v cleanup_hagga=1' "$TEST_DOCKER_ARGS"

# An explicit operator opt-out must bypass settings and database access.
rm -f "$TEST_DOCKER_ARGS"
DUNE_CORIOLIS_SAFE_DATA_CLEANUP=0 TEST_DEEPDESERT_WIPE=False TEST_HAGGA_WIPE=False \
  runtime/scripts/coriolis-data-cleanup.sh > "$TEST_ROOT/disabled.out"
grep -q 'cleanup is disabled' "$TEST_ROOT/disabled.out"
[ ! -e "$TEST_DOCKER_ARGS" ]

echo "Coriolis data cleanup tests passed."
