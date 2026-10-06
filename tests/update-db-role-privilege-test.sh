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
  local updater_log="${6:-}"
  local initial_external_trigger="${7:-absent}"
  local bin_dir="$tmp_dir/$name/bin"
  local docker_log="$tmp_dir/$name/docker.log"
  local output="$tmp_dir/$name/output.log"
  local role_state="$tmp_dir/$name/role-state"
  local role_marker="$tmp_dir/$name/role-elevated"
  local external_trigger_state="$tmp_dir/$name/external-trigger-state"
  local external_trigger_marker="$tmp_dir/$name/external-triggers.sql"
  local postgres_start_log="$tmp_dir/$name/postgres-start.log"
  local psql_stdin_log="$tmp_dir/$name/psql-stdin.log"
  local host_repo_root="$tmp_dir/$name/host-repo"
  local postgres_running="${8:-1}"
  local existing_trigger_marker="${9:-}"

  mkdir -p "$bin_dir"
  printf '%s\n' "$initial_superuser" > "$role_state"
  printf '%s\n' "$initial_external_trigger" > "$external_trigger_state"
  [ "$stale_marker" != "1" ] || : > "$role_marker"
  [ -z "$existing_trigger_marker" ] || printf '%s\n' "$existing_trigger_marker" > "$external_trigger_marker"
  cat > "$bin_dir/start-postgres" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' started > "$MOCK_POSTGRES_START_LOG"
printf '%s\n' 1 > "$MOCK_POSTGRES_RUNNING_STATE"
EOF
  cat > "$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"

if [ "${1:-}" = "exec" ] && [[ "$*" == *"SELECT rolsuper FROM pg_roles"* ]]; then
  cat "$MOCK_ROLE_STATE"
  exit 0
fi

if [ "${1:-}" = "exec" ] && [[ "$*" == *"pg_get_triggerdef"* ]]; then
  if [ "$(cat "$MOCK_EXTERNAL_TRIGGER_STATE")" = "present" ]; then
    printf '%s\n' 'CREATE TRIGGER console_market_history_capture AFTER INSERT OR UPDATE OF stack_size ON dune.dune_exchange_fulfilled_orders FOR EACH ROW EXECUTE FUNCTION console_market_history.capture_fulfilled_order()'
    printf '%s\n' 'CREATE TRIGGER notify_airdrop AFTER INSERT ON dune.airdrop_pending_deliveries FOR EACH ROW EXECUTE FUNCTION dune_airdrop.notify_pending_delivery()'
  fi
  exit 0
fi

if [ "${1:-}" = "exec" ] && [[ "$*" == *"DROP TRIGGER %I ON %I.%I"* ]]; then
  printf '%s\n' absent > "$MOCK_EXTERNAL_TRIGGER_STATE"
  exit 0
fi

if [ "${1:-}" = "exec" ] && [ "${2:-}" = "-i" ]; then
  stdin="$(cat)"
  printf '%s\n' "$stdin" >> "$MOCK_PSQL_STDIN_LOG"
  if [[ "$stdin" == *"CREATE TRIGGER console_market_history_capture"* ]] \
    && [[ "$stdin" == *"CREATE TRIGGER notify_airdrop"* ]]; then
    printf '%s\n' present > "$MOCK_EXTERNAL_TRIGGER_STATE"
  fi
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

if [ "${1:-}" = "logs" ]; then
  printf '%s\n' "$MOCK_UPDATER_LOG"
  exit 0
fi

if [ "${1:-}" = "inspect" ] && [[ "$*" == *"State.Running"* ]]; then
  if [[ "$*" == *"dune-postgres"* ]]; then
    if [ "$(cat "$MOCK_POSTGRES_RUNNING_STATE")" = "1" ]; then
      printf '%s\n' true
    else
      printf '%s\n' false
    fi
    exit 0
  fi
  printf '%s\n' false
  exit 0
fi

if [ "${1:-}" = "inspect" ] && [[ "$*" == *"State.ExitCode"* ]]; then
  printf '%s\n' "$MOCK_UPDATER_EXIT_CODE"
  exit 0
fi

exit 0
EOF
  chmod +x "$bin_dir/docker" "$bin_dir/start-postgres"
  printf '%s\n' "$postgres_running" > "$tmp_dir/$name/postgres-running-state"

  set +e
  PATH="$bin_dir:$PATH" \
    MOCK_DOCKER_LOG="$docker_log" \
    MOCK_ROLE_STATE="$role_state" \
    MOCK_EXTERNAL_TRIGGER_STATE="$external_trigger_state" \
    MOCK_POSTGRES_START_LOG="$postgres_start_log" \
    MOCK_POSTGRES_RUNNING_STATE="$tmp_dir/$name/postgres-running-state" \
    MOCK_PSQL_STDIN_LOG="$psql_stdin_log" \
    MOCK_UPDATER_EXIT_CODE="$updater_exit_code" \
    MOCK_UPDATER_LOG="$updater_log" \
    DUNE_DB_UPDATE_START_POSTGRES_SCRIPT="$bin_dir/start-postgres" \
    DUNE_DB_UPDATE_ROLE_MARKER="$role_marker" \
    DUNE_DB_UPDATE_EXTERNAL_TRIGGER_MARKER="$external_trigger_marker" \
    DUNE_DB_BACKUP_ON_ORPHAN_DETECT=0 \
    DUNE_CONTAINER_REPO_ROOT="$PWD" \
    DUNE_HOST_REPO_ROOT="$host_repo_root" \
    runtime/scripts/update-db.sh >"$output" 2>&1
  local actual_script_exit=$?
  set -e

  if [ "$actual_script_exit" -ne "$expected_script_exit" ]; then
    echo "FAIL $name: expected exit $expected_script_exit, got $actual_script_exit"
    cat "$output"
    exit 1
  fi

  if [ -n "$updater_log" ]; then
    grep -Fq "$updater_log" "$output"
  fi

  grep -Fq "function_schema.nspname NOT IN ('dune', 'pg_catalog')" "$docker_log"
  grep -Fq -- "-v $host_repo_root/runtime/scripts/db-update-pg-dump:/tmp/pg17/bin/pg_dump:ro" "$docker_log"

  if [ "$updater_exit_code" = "0" ]; then
    grep -q 'exec -i dune-postgres psql .*ON_ERROR_STOP=1 .* -f -' "$docker_log"
  elif grep -q 'exec -i dune-postgres psql .*ON_ERROR_STOP=1 .* -f -' "$docker_log"; then
    echo "FAIL $name: compatibility patch ran after a failed database update"
    cat "$docker_log"
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

  if [ -e "$external_trigger_marker" ]; then
    echo "FAIL $name: updater left its external-trigger marker behind"
    exit 1
  fi

  if [ "$(cat "$external_trigger_state")" != "$initial_external_trigger" ]; then
    echo "FAIL $name: external trigger state was not restored"
    exit 1
  fi

  if [ "$postgres_running" = "0" ]; then
    grep -Fq "Postgres is not running; starting it before the database update." "$output"
    grep -Fqx started "$postgres_start_log"
  elif [ -e "$postgres_start_log" ]; then
    echo "FAIL $name: updater restarted an already-running Postgres container"
    exit 1
  fi

  if [ -n "$existing_trigger_marker" ]; then
    grep -Fq 'WHEN duplicate_object THEN' "$psql_stdin_log"
    grep -Fq 'WHEN invalid_schema_name OR undefined_function OR undefined_table THEN' "$psql_stdin_log"
    grep -Fq "$existing_trigger_marker" "$psql_stdin_log"
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
run_case failure-restores-role f 128 1 0 'ERROR preserved updater failure detail'
run_case existing-superuser-unchanged t 0 0
run_case interrupted-update-recovers-role t 0 0 1
run_case external-triggers-restored-after-success f 0 0 0 '' present
run_case external-triggers-restored-after-failure f 128 1 0 'ERROR migration failed' present
run_case starts-missing-postgres f 0 0 0 '' absent 0
run_case skips-stale-trigger-with-missing-addon-schema f 0 0 0 '' absent 1 \
  'CREATE TRIGGER console_market_history_capture AFTER INSERT ON dune.dune_exchange_fulfilled_orders FOR EACH ROW EXECUTE FUNCTION console_market_history.capture_fulfilled_order();'
