#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

bin_dir="$test_root/bin"
mkdir -p "$bin_dir" "$test_root/runtime/scripts/lib"
cp runtime/scripts/env-file.sh "$test_root/runtime/scripts/env-file.sh"
# db.sh now sources runtime-env.sh (needed for resolve_funcom_token, the
# age-secrets-aware Funcom-token resolver used by its battlegroup-mismatch
# diagnostic) -- this isolated test tree needs runtime-env.sh's own full
# dependency chain too, or sourcing it fails with "No such file or
# directory" in this copy, even though the real repo has every file.
cp runtime/scripts/runtime-env.sh "$test_root/runtime/scripts/runtime-env.sh"
cp runtime/scripts/memory-swap-common.sh "$test_root/runtime/scripts/memory-swap-common.sh"
cp runtime/scripts/compose-project.sh "$test_root/runtime/scripts/compose-project.sh"
cp runtime/scripts/lib/secrets.sh "$test_root/runtime/scripts/lib/secrets.sh"
cp runtime/scripts/lib/secrets_aead.py "$test_root/runtime/scripts/lib/secrets_aead.py"

cat > "$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"

case "${1:-} ${2:-}" in
  "ps --format")
    printf '%s\n' dune-postgres
    ;;
  "exec dune-postgres")
    shift 2
    case "${1:-}" in
      psql)
        printf '%s\n' "${MOCK_PARTITION_COUNT:-30}"
        ;;
      pg_dump)
        ;;
      pg_restore)
        if [ "${MOCK_ARCHIVE_VALID:-1}" = "1" ]; then
          cat <<'TOC'
5; 2615 16385 SCHEMA - dune dune
212; 1259 16432 TABLE dune world_partition dune
3872; 0 16432 TABLE DATA dune world_partition dune
TOC
        else
          printf '%s\n' '1; 1262 12345 DATABASE - dune postgres'
        fi
        ;;
      rm)
        ;;
    esac
    ;;
  "cp dune-postgres:"*)
    destination="${3:-}"
    mkdir -p "$(dirname "$destination")"
    printf '%s\n' mock-custom-archive > "$destination"
    ;;
  "cp "*)
    ;;
esac
EOF
chmod +x "$bin_dir/docker"

run_backup_case() {
  local name="$1"
  local partition_count="$2"
  local archive_valid="$3"
  local expected_exit="$4"
  local case_root="$test_root/$name"
  local output="$case_root/output.log"
  local docker_log="$case_root/docker.log"

  mkdir -p "$case_root/work/runtime/generated" "$case_root/backups"
  cp runtime/scripts/db.sh "$case_root/work/db.sh"

  set +e
  (
    cd "$case_root/work"
    PATH="$bin_dir:$PATH" \
      MOCK_DOCKER_LOG="$docker_log" \
      MOCK_PARTITION_COUNT="$partition_count" \
      MOCK_ARCHIVE_VALID="$archive_valid" \
      bash ./db.sh backup "$case_root/backups"
  ) > "$output" 2>&1
  local actual_exit=$?
  set -e

  if [ "$actual_exit" -ne "$expected_exit" ]; then
    echo "FAIL $name: expected exit $expected_exit, got $actual_exit"
    cat "$output"
    exit 1
  fi

  if [ "$expected_exit" -eq 0 ]; then
    [ "$(find "$case_root/backups" -maxdepth 1 -name '*.backup' | wc -l)" -eq 1 ]
    [ "$(find "$case_root/backups" -maxdepth 1 -name '*.backup.yaml' | wc -l)" -eq 1 ]
  else
    if find "$case_root/backups" -maxdepth 1 -type f | grep -q .; then
      echo "FAIL $name: rejected backup left a published or partial artifact"
      find "$case_root/backups" -maxdepth 1 -type f -print
      exit 1
    fi
  fi

  echo "PASS $name"
}

run_backup_case valid-dune-backup 30 1 0
run_backup_case empty-live-database 0 1 1
run_backup_case missing-dune-archive 30 0 1

restore_root="$test_root/invalid-restore"
mkdir -p "$restore_root/work/runtime/generated"
cp runtime/scripts/db.sh "$restore_root/work/db.sh"
printf '%s\n' mock-empty-database-archive > "$restore_root/empty.backup"

set +e
(
  cd "$restore_root/work"
  PATH="$bin_dir:$PATH" \
    MOCK_DOCKER_LOG="$restore_root/docker.log" \
    MOCK_PARTITION_COUNT=30 \
    MOCK_ARCHIVE_VALID=0 \
    DUNE_DB_ASSUME_YES=1 \
    bash ./db.sh restore "$restore_root/empty.backup" --no-safety-backup
) > "$restore_root/output.log" 2>&1
restore_exit=$?
set -e

if [ "$restore_exit" -eq 0 ]; then
  echo "FAIL invalid-restore: empty archive was accepted"
  cat "$restore_root/output.log"
  exit 1
fi
grep -q 'Restore aborted before any database changes were made' "$restore_root/output.log"
if grep -Eq 'drop database|start-all|stop-all' "$restore_root/docker.log"; then
  echo "FAIL invalid-restore: destructive work ran after validation failure"
  cat "$restore_root/docker.log"
  exit 1
fi
echo "PASS invalid-restore-aborts-before-database-changes"
