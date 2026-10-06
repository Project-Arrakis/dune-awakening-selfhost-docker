#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

catalog="runtime/generated/partition-catalog.json"
sql_file="$(mktemp runtime/generated/world-partition-reconcile.sql.tmp.XXXXXX)"
mode="${1:-apply}"

case "$mode" in
  apply|--check) ;;
  *)
    echo "Usage: $0 [--check]" >&2
    exit 2
    ;;
esac

cleanup() {
  rm -f -- "$sql_file"
}
trap cleanup EXIT

if ! docker inspect -f '{{.State.Running}}' dune-postgres 2>/dev/null | grep -qx true; then
  echo "dune-postgres must be running before world partitions can be reconciled." >&2
  exit 1
fi

if [ ! -s "$catalog" ]; then
  echo "Partition catalog is missing or empty: $catalog" >&2
  exit 1
fi

reserved_partition_ids="$(
  awk -F= '
    /^DUNE_MEMORY_PARTITION_[0-9]+=/ {
      key = $1
      sub(/^DUNE_MEMORY_PARTITION_/, "", key)
      if (key ~ /^[0-9]+$/) print key
    }
  ' .env 2>/dev/null | sort -n -u | paste -sd, -
)"

if [ "$mode" = "apply" ]; then
  DUNE_RESERVED_PARTITION_IDS="$reserved_partition_ids" \
    runtime/scripts/generate-world-partition-reconcile-sql.py "$catalog" >"$sql_file"

  echo "Reconciling official world partitions without changing existing rows..."
  docker exec -i dune-postgres psql -v ON_ERROR_STOP=1 -U dune -d dune <"$sql_file"
fi

missing_count="$(
  python3 - "$catalog" <<'PY' | docker exec -i dune-postgres psql -v ON_ERROR_STOP=1 -U dune -d dune -At
import json
import sys
from pathlib import Path

rows = json.loads(Path(sys.argv[1]).read_text())
values = []
for row in rows:
    map_name = str(row["map"]).replace("'", "''")
    dimension = int(row.get("dimension") or 0)
    values.append(f"('{map_name}', {dimension})")

print("with expected(map, dimension_index) as (values " + ",".join(values) + ")")
print("select count(*) from expected e where not exists (")
print("  select 1 from dune.world_partition wp")
print("  where lower(wp.map) = lower(e.map) and wp.dimension_index = e.dimension_index");
print(");")
PY
)"
missing_count="$(printf '%s' "$missing_count" | tr -d '[:space:]')"
if [ "${missing_count:-1}" != "0" ]; then
  echo "World-partition reconciliation is incomplete: ${missing_count:-unknown} official partitions are still missing." >&2
  exit 1
fi

if [ "$mode" = "apply" ]; then
  echo "Official world partitions are present. Existing custom partitions were preserved."
else
  echo "Official world partitions are present."
fi
