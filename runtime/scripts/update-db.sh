#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/host-paths.sh
source runtime/scripts/image-tags.sh
source runtime/scripts/runtime-env.sh
WORLD_IMAGE_TAG="$(resolve_world_image_tag)"

IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server-db-utils:${WORLD_IMAGE_TAG}"
CONTAINER_NAME="dune-db-update"
TIMEOUT_SECONDS="${DUNE_DB_UPDATE_TIMEOUT_SECONDS:-300}"
SUCCESS_MARKER_REGEX='Database is already up to date|User-data encryption:'
FAILURE_MARKER_REGEX='Traceback \(most recent call last\)|ERROR|CRITICAL|FATAL'
QUIESCENT_SUCCESS_AFTER_SECONDS="${DUNE_DB_UPDATE_QUIESCENT_SUCCESS_AFTER_SECONDS:-20}"
ORPHAN_AUDIT_DIR="runtime/generated/db-orphan-audits"
ORPHAN_BACKUP_ON_DETECT="${DUNE_DB_BACKUP_ON_ORPHAN_DETECT:-1}"
PROJECT_DB_ROLE="dune"
PROJECT_ROLE_WAS_SUPERUSER=""
ROLE_ELEVATION_MARKER="${DUNE_DB_UPDATE_ROLE_MARKER:-runtime/generated/db-update-role-elevated}"
EXTERNAL_TRIGGER_MARKER="${DUNE_DB_UPDATE_EXTERNAL_TRIGGER_MARKER:-runtime/generated/db-update-external-triggers.sql}"
DB_UPDATE_PG_DUMP_WRAPPER="$(host_path "$PWD/runtime/scripts/db-update-pg-dump")"
START_POSTGRES_SCRIPT="${DUNE_DB_UPDATE_START_POSTGRES_SCRIPT:-runtime/scripts/start-postgres.sh}"

ensure_postgres_ready() {
  if ! docker inspect -f '{{.State.Running}}' dune-postgres 2>/dev/null | grep -qx true; then
    echo "Postgres is not running; starting it before the database update."
    "$START_POSTGRES_SCRIPT"
  fi

  if ! docker exec dune-postgres pg_isready -h 127.0.0.1 -p 5432 -U postgres -d dune >/dev/null 2>&1; then
    echo "Postgres is running but is not ready for the database update." >&2
    return 1
  fi
}

write_guarded_trigger_restore_sql() {
  local trigger_definition
  local trigger_delimiter="\$dune_trigger_definition\$"

  while IFS= read -r trigger_definition || [ -n "$trigger_definition" ]; do
    [ -n "$trigger_definition" ] || continue
    case "$trigger_definition" in
      CREATE\ TRIGGER*) ;;
      *)
        echo "Invalid project-owned trigger recovery entry; refusing to execute it." >&2
        return 1
        ;;
    esac
    if [[ "$trigger_definition" == *"$trigger_delimiter"* ]]; then
      echo "Invalid project-owned trigger recovery entry; refusing to execute it." >&2
      return 1
    fi
    cat <<SQL
DO \$dune_restore_trigger\$
BEGIN
  EXECUTE \$dune_trigger_definition\$${trigger_definition}\$dune_trigger_definition\$;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'Project-owned database trigger already present: %', SQLERRM;
  WHEN invalid_schema_name OR undefined_function OR undefined_table THEN
    RAISE NOTICE 'Skipping stale project-owned database trigger: %', SQLERRM;
END
\$dune_restore_trigger\$;
SQL
  done < "$EXTERNAL_TRIGGER_MARKER"
}

restore_external_triggers() {
  [ -f "$EXTERNAL_TRIGGER_MARKER" ] || return 0
  if ! write_guarded_trigger_restore_sql \
    | docker exec -i dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 \
      -f - >/dev/null; then
    echo "Failed to restore project-owned database triggers after the update." >&2
    return 1
  fi

  rm -f "$EXTERNAL_TRIGGER_MARKER"
}

detach_external_triggers() {
  local trigger_definitions

  trigger_definitions="$(docker exec dune-postgres psql -U postgres -d dune -Atc \
    "SELECT pg_get_triggerdef(t.oid, true) || ';'
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace table_schema ON table_schema.oid = c.relnamespace
       JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
       JOIN pg_catalog.pg_namespace function_schema ON function_schema.oid = p.pronamespace
      WHERE table_schema.nspname = 'dune'
        AND function_schema.nspname NOT IN ('dune', 'pg_catalog')
        AND NOT t.tgisinternal
      ORDER BY t.tgname;")"
  [ -n "$trigger_definitions" ] || return 0

  mkdir -p "$(dirname "$EXTERNAL_TRIGGER_MARKER")"
  printf '%s\n' "$trigger_definitions" > "$EXTERNAL_TRIGGER_MARKER"
  chmod 600 "$EXTERNAL_TRIGGER_MARKER"
  docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 \
    -c "DO \$block\$
        DECLARE trigger_row record;
        BEGIN
          FOR trigger_row IN
            SELECT t.tgname, table_schema.nspname AS schema_name, c.relname AS table_name
              FROM pg_catalog.pg_trigger t
              JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
              JOIN pg_catalog.pg_namespace table_schema ON table_schema.oid = c.relnamespace
              JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
              JOIN pg_catalog.pg_namespace function_schema ON function_schema.oid = p.pronamespace
             WHERE table_schema.nspname = 'dune'
               AND function_schema.nspname NOT IN ('dune', 'pg_catalog')
               AND NOT t.tgisinternal
          LOOP
            EXECUTE format('DROP TRIGGER %I ON %I.%I', trigger_row.tgname, trigger_row.schema_name, trigger_row.table_name);
          END LOOP;
        END
        \$block\$;" >/dev/null
}

restore_project_role_privileges() {
  local status=$?

  trap - EXIT
  if ! restore_external_triggers; then
    [ "$status" -ne 0 ] || status=1
  fi
  if [ "$PROJECT_ROLE_WAS_SUPERUSER" = "false" ]; then
    if ! docker exec dune-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
      -c "ALTER ROLE ${PROJECT_DB_ROLE} NOSUPERUSER;" >/dev/null; then
      echo "Failed to restore the ${PROJECT_DB_ROLE} database role to NOSUPERUSER." >&2
      [ "$status" -ne 0 ] || status=1
    else
      rm -f "$ROLE_ELEVATION_MARKER"
    fi
  fi

  exit "$status"
}

prepare_project_role_for_update() {
  local is_superuser

  if [ -f "$ROLE_ELEVATION_MARKER" ]; then
    echo "Recovering database role privileges from an interrupted update."
    docker exec dune-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
      -c "ALTER ROLE ${PROJECT_DB_ROLE} NOSUPERUSER;" >/dev/null
    rm -f "$ROLE_ELEVATION_MARKER"
  fi

  is_superuser="$(docker exec dune-postgres psql -U postgres -d postgres -Atc \
    "SELECT rolsuper FROM pg_roles WHERE rolname = '${PROJECT_DB_ROLE}';" | tr -d '[:space:]')"
  case "$is_superuser" in
    t)
      PROJECT_ROLE_WAS_SUPERUSER="true"
      ;;
    f)
      PROJECT_ROLE_WAS_SUPERUSER="false"
      mkdir -p "$(dirname "$ROLE_ELEVATION_MARKER")"
      : > "$ROLE_ELEVATION_MARKER"
      docker exec dune-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
        -c "ALTER ROLE ${PROJECT_DB_ROLE} SUPERUSER;" >/dev/null
      ;;
    *)
      echo "Cannot determine database privileges for role ${PROJECT_DB_ROLE}." >&2
      return 1
      ;;
  esac
}

audit_db_orphans() {
  local summary ts report_file total
  mkdir -p "$ORPHAN_AUDIT_DIR"

  summary="$(bash runtime/scripts/db-orphan-audit.sh summary 2>/dev/null || true)"
  [ -n "$summary" ] || return 0

  total="$(printf '%s\n' "$summary" | awk -F '\t' '{ sum += ($2 + 0) } END { print sum + 0 }')"
  if [ "${total:-0}" -le 0 ]; then
    return 0
  fi

  ts="$(date +%Y%m%d-%H%M%S)"
  report_file="$ORPHAN_AUDIT_DIR/orphans-$ts.tsv"
  bash runtime/scripts/db-orphan-audit.sh export "$report_file" >/dev/null 2>&1 || true

  echo "=== Database orphan audit before updater ==="
  printf '%s\n' "$summary" | awk -F '\t' '{ printf "  %-40s %s\n", $1 ":", $2 }'
  echo "Detailed report: $report_file"

  if [ "$ORPHAN_BACKUP_ON_DETECT" = "1" ]; then
    echo "Orphaned player/account rows were detected before the DB updater."
    echo "Creating a safety backup before running updater cleanup."
    DB_BACKUP_ORIGIN=pre-update bash runtime/scripts/db.sh backup runtime/backups/db >/dev/null
  fi
}

ensure_postgres_ready

echo "=== Running Dune DB update/migration ==="
echo "Image: $IMAGE"

audit_db_orphans

# Console features and community addons can attach triggers to game-owned
# tables while keeping their functions in separately owned schemas. Funcom's
# updater copies game tables into an isolated validation database without those
# external schemas, so preserve and detach every such trigger for the migration.
# The EXIT trap restores each exact definition on every exit path.
restore_external_triggers
detach_external_triggers

# Funcom's updater restores a schema dump as the project role. PostgreSQL checks
# superuser privileges for CREATE EXTENSION even when IF NOT EXISTS is used, so
# temporarily elevate that role and always restore its original state.
trap restore_project_role_privileges EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
prepare_project_role_for_update

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

docker run -d \
  "${DUNE_DOCKER_LOG_ARGS[@]}" \
  --name "$CONTAINER_NAME" \
  --network dune-net \
  -v "$DB_UPDATE_PG_DUMP_WRAPPER:/tmp/pg17/bin/pg_dump:ro" \
  --entrypoint sh \
  "$IMAGE" \
  -lc '
set -eo pipefail

mkdir -p /tmp/pg17/bin
ln -sf /usr/bin/psql /tmp/pg17/bin/psql
ln -sf /usr/bin/pg_restore /tmp/pg17/bin/pg_restore
ln -sf /usr/bin/pg_isready /tmp/pg17/bin/pg_isready

python -u /root/PSQL/updatedb.py \
  --host dune-postgres:5432 \
  --project-database dune \
  --project-user dune \
  --project-password dune \
  --admin-user postgres \
  --admin-password postgres \
  --admin-database postgres \
  --postgres-installation /tmp/pg17 \
  --ignore-backup-failure \
  --unattended \
  2>&1 | tee /tmp/dune-db-update.log
'

start_ts="$(date +%s)"
last_logs=""

db_update_sessions_active() {
  local count
  count="$(docker exec dune-postgres psql -U postgres -d postgres -Atc "
    select count(*)
    from pg_stat_activity
    where pid <> pg_backend_pid()
      and (
        application_name = 'psql'
        or left(query, 32) in (
          'select pid, application_name, use',
          'select count(*) from pg_stat_acti'
        ) = false
      )
      and datname in ('dune', 'postgres')
      and usename in ('dune', 'postgres')
      and state <> 'idle';
  " 2>/dev/null | tr -d '[:space:]')"
  [ "${count:-0}" -gt 0 ]
}

db_update_schema_looks_valid() {
  local row
  row="$(docker exec dune-postgres psql -U dune -d dune -AtF '|' -c "
    select coalesce(dune.get_schema_version()::text, ''), coalesce((select name from dune.applied_patches order by date desc limit 1), '');
  " 2>/dev/null | head -n1 | tr -d '\r')"
  [ -n "$row" ] || return 1
  local schema_version latest_patch
  IFS='|' read -r schema_version latest_patch <<< "$row"
  [ -n "${schema_version:-}" ] && [ -n "${latest_patch:-}" ]
}

finish_database_update() {
  echo
  echo "=== Apply post-migration database compatibility patches ==="
  runtime/scripts/patch-coriolis-base-backups.sh
  runtime/scripts/patch-vehicle-recovery-guard.sh
  runtime/scripts/patch-blueprint-array-bounds.sh
  exit 0
}

while true; do
  now_ts="$(date +%s)"
  elapsed="$((now_ts - start_ts))"
  running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)"
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$CONTAINER_NAME" 2>/dev/null || echo 1)"
  # Container stdout is durable after exit; docker exec is not. Reading logs
  # here preserves the actual updater error when the helper exits quickly.
  last_logs="$(docker logs "$CONTAINER_NAME" 2>/dev/null || true)"

  if printf '%s\n' "$last_logs" | grep -Eq "$FAILURE_MARKER_REGEX"; then
    echo "$last_logs"
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    echo "Database update failed."
    exit 1
  fi

  if [ "$running" != "true" ]; then
    echo "$last_logs"
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    if [ "$exit_code" = "0" ]; then
      finish_database_update
    fi
    echo "Database update exited with status $exit_code."
    exit 1
  fi

  if printf '%s\n' "$last_logs" | grep -Eq "$SUCCESS_MARKER_REGEX"; then
    echo "$last_logs"
    echo "Database update completed, stopping stale helper container."
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    finish_database_update
  fi

  if [ "$elapsed" -ge "$QUIESCENT_SUCCESS_AFTER_SECONDS" ] \
    && ! db_update_sessions_active \
    && db_update_schema_looks_valid; then
    echo "$last_logs"
    echo "Database update helper became quiescent with valid schema state; stopping stale helper container."
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    finish_database_update
  fi

  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    echo "$last_logs"
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    echo "Database update timed out after ${TIMEOUT_SECONDS}s."
    exit 1
  fi

  sleep 2
done
