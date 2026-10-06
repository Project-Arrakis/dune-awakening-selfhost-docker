#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

catalog="$tmpdir/partition-catalog.json"
sql="$tmpdir/reconcile.sql"

cat >"$catalog" <<'JSON'
[
  {
    "map": "Existing_Map",
    "id": 31,
    "dimension": 0,
    "disable": false,
    "minX": 0,
    "minY": 0,
    "maxX": 1,
    "maxY": 1
  },
  {
    "map": "New_Map_With_'_Quote",
    "id": 32,
    "dimension": 1,
    "disable": true,
    "minX": -1,
    "minY": -2,
    "maxX": 3,
    "maxY": 4
  }
]
JSON

runtime/scripts/generate-world-partition-reconcile-sql.py "$catalog" >"$sql"

grep -Fq "lower(map) = lower('Existing_Map')" "$sql"
grep -Fq "lower(map) = lower('New_Map_With_''_Quote')" "$sql"
grep -Fq "partition_id = 32" "$sql"
grep -Fq "'New_Map_With_''_Quote'" "$sql"
grep -Fq '"min_x":-1' "$sql"
grep -Fq '1, true, null' "$sql"
grep -Fq "canonical ID % was already in use" "$sql"
grep -Fq "pg_advisory_xact_lock" "$sql"

DUNE_RESERVED_PARTITION_IDS=32 runtime/scripts/generate-world-partition-reconcile-sql.py "$catalog" >"$tmpdir/reserved.sql"
grep -Fq "elsif false then" "$tmpdir/reserved.sql"
grep -Fq "canonical ID % has an existing partition override" "$tmpdir/reserved.sql"

if grep -Eiq 'delete[[:space:]]+from[[:space:]]+dune\.world_partition|update[[:space:]]+dune\.world_partition' "$sql"; then
  echo "FAIL: additive reconciliation generated destructive world_partition SQL" >&2
  exit 1
fi

duplicate_catalog="$tmpdir/duplicate.json"
cat >"$duplicate_catalog" <<'JSON'
[
  {"map":"Duplicate","id":1,"dimension":0},
  {"map":"duplicate","id":2,"dimension":0}
]
JSON
if runtime/scripts/generate-world-partition-reconcile-sql.py "$duplicate_catalog" >/dev/null 2>&1; then
  echo "FAIL: duplicate map/dimension rows were accepted" >&2
  exit 1
fi

db_line="$(grep -n 'run_timed_step "Ensuring Database Is Up To Date"' runtime/scripts/start-all.sh | head -n1 | cut -d: -f1)"
catalog_line="$(grep -n 'run_timed_step "Refreshing Map Catalogs"' runtime/scripts/start-all.sh | head -n1 | cut -d: -f1)"
reconcile_line="$(grep -n 'run_timed_step "Reconciling Official World Partitions"' runtime/scripts/start-all.sh | head -n1 | cut -d: -f1)"
director_line="$(grep -n 'run_timed_step "Starting Director"' runtime/scripts/start-all.sh | head -n1 | cut -d: -f1)"

if [ -z "$db_line" ] || [ -z "$catalog_line" ] || [ -z "$reconcile_line" ] || [ -z "$director_line" ]; then
  echo "FAIL: could not locate startup map reconciliation sequence" >&2
  exit 1
fi
if [ "$catalog_line" -le "$db_line" ] || [ "$reconcile_line" -le "$catalog_line" ] || [ "$reconcile_line" -ge "$director_line" ]; then
  echo "FAIL: startup must refresh and reconcile maps after migration and before Director startup" >&2
  exit 1
fi

grep -Fq 'runtime/scripts/reconcile-world-partitions.sh' runtime/scripts/update.sh
grep -Fq 'runtime/scripts/reconcile-world-partitions.sh --check' runtime/scripts/ready.sh

echo "PASS: world-partition reconciliation is additive and wired into update and startup recovery"
