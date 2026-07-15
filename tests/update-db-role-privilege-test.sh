#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

run_case() {
  local name="$1"
  local initial_superuser="$2"
  local updater_exit_code="$3"
  local expected_script_exit="$4"
  local stale_marker="${5:-0}"
  local bin_dir="$tmp_dir/$name/bin"
  local docker_log="$tmp_dir/$name/docker.log"
  local output="$tmp_dir/$name/output.log"
  local role_state="$tmp_dir/$name/role-state"
  local role_marker="$tmp_dir/$name/role-elevated"

  mkdir -p "$bin_dir"
  printf '%s\n' "$initial_superuser" > "$role_state"
  [ "$stale_marker" != "1" ] || : > "$role_marker"
  cat > "$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"

if [ "${1:-}" = "exec" ] && [[ "$*" == *"SELECT rolsuper FROM pg_roles"* ]]; then
  cat "$MOCK_ROLE_STATE"
  exit 0
fi

if [ "${1:-}" = "exec" ] && [[ "$*" == *"ALTER ROLE dune SUPERUSER"* ]]; then
  printf '%s\n' t > "$MOCK_ROLE_STATE"
  exit 0
fi

if [ "${1:-}" = "exec" ] && [[ "$*" == *"ALTER ROLE dune NOSUPERUSER"* ]]; then
  printf '%s\n' f > "$MOCK_ROLE_STATE"
  exit 0
fi

if [ "${1:-}" = "run" ]; then
  printf '%s\n' mock-update-container
  exit 0
fi

if [ "${1:-}" = "inspect" ] && [[ "$*" == *"State.Running"* ]]; then
  printf '%s\n' false
  exit 0
fi

if [ "${1:-}" = "inspect" ] && [[ "$*" == *"State.ExitCode"* ]]; then
  printf '%s\n' "$MOCK_UPDATER_EXIT_CODE"
  exit 0
fi

exit 0
EOF
  chmod +x "$bin_dir/docker"

  set +e
  PATH="$bin_dir:$PATH" \
    MOCK_DOCKER_LOG="$docker_log" \
    MOCK_ROLE_STATE="$role_state" \
    MOCK_UPDATER_EXIT_CODE="$updater_exit_code" \
    DUNE_DB_UPDATE_ROLE_MARKER="$role_marker" \
    DUNE_DB_BACKUP_ON_ORPHAN_DETECT=0 \
    runtime/scripts/update-db.sh >"$output" 2>&1
  local actual_script_exit=$?
  set -e

  if [ "$actual_script_exit" -ne "$expected_script_exit" ]; then
    echo "FAIL $name: expected exit $expected_script_exit, got $actual_script_exit"
    cat "$output"
    exit 1
  fi

  if [ "$initial_superuser" = "f" ] || [ "$stale_marker" = "1" ]; then
    grep -q 'ALTER ROLE dune SUPERUSER' "$docker_log"
    grep -q 'ALTER ROLE dune NOSUPERUSER' "$docker_log"
  else
    if grep -q 'ALTER ROLE dune SUPERUSER' "$docker_log" || grep -q 'ALTER ROLE dune NOSUPERUSER' "$docker_log"; then
      echo "FAIL $name: updater changed a role that was already superuser"
      cat "$docker_log"
      exit 1
    fi
  fi

  if [ -e "$role_marker" ]; then
    echo "FAIL $name: updater left its role-elevation marker behind"
    exit 1
  fi

  local expected_role_state="$initial_superuser"
  [ "$stale_marker" != "1" ] || expected_role_state=f
  if [ "$(cat "$role_state")" != "$expected_role_state" ]; then
    echo "FAIL $name: database role state was not restored"
    exit 1
  fi

  echo "PASS $name"
}

run_case success-restores-role f 0 0
run_case failure-restores-role f 128 1
run_case existing-superuser-unchanged t 0 0
run_case interrupted-update-recovers-role t 0 0 1
