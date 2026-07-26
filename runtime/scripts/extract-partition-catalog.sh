#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

mkdir -p runtime/generated

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
source runtime/scripts/runtime-env.sh

SERVER_REGION="$(resolve_server_region)"
SERVER_IP="$(resolve_server_ip)"
export SERVER_REGION SERVER_IP
catalog_extract_timeout_seconds="${DUNE_CATALOG_EXTRACT_TIMEOUT_SECONDS:-120}"
catalog_output="runtime/generated/partition-catalog.json"
catalog_tmp="$(mktemp "${catalog_output}.tmp.XXXXXX")"

cleanup_catalog_tmp() {
  rm -f -- "$catalog_tmp"
}
trap cleanup_catalog_tmp EXIT

echo "Extracting partition catalog from world-template.yaml..."

timeout --kill-after=2s "${catalog_extract_timeout_seconds}s" docker compose exec -T orchestrator python3 - > "$catalog_tmp" <<'PY'
import json
import re
import sys
from pathlib import Path
import yaml

src = Path("/srv/dune/server/scripts/setup/templates/world-template.yaml")
text = src.read_text()
text = re.sub(r"\{([A-Z0-9_]+)\}", r"PLACEHOLDER_\1", text)

doc = yaml.safe_load(text)

db = (
    doc.get("spec", {})
       .get("database", {})
       .get("template", {})
       .get("spec", {})
       .get("deployment", {})
       .get("spec", {})
)

world_partitions = db.get("worldPartitions", [])

rows = []
for wp in world_partitions:
    map_name = wp.get("map")
    for p in wp.get("partitions", []):
        rows.append({
            "map": map_name,
            "id": p.get("id"),
            "dimension": p.get("dimension"),
            "disable": p.get("disable"),
            "minX": p.get("minX"),
            "minY": p.get("minY"),
            "maxX": p.get("maxX"),
            "maxY": p.get("maxY"),
        })

json.dump(rows, sys.stdout, indent=2)
sys.stdout.write("\n")

print(f"partitions: {len(rows)}", file=sys.stderr)
for r in rows:
    print(
        f"id={str(r['id']).rjust(3)} "
        f"map={r['map']} "
        f"dim={r['dimension']} "
        f"disabled={r['disable']} "
        f"box=({r['minX']},{r['minY']})-({r['maxX']},{r['maxY']})",
        file=sys.stderr,
    )
PY

if [ ! -s "$catalog_tmp" ]; then
  echo "Generated partition catalog is empty." >&2
  exit 1
fi

chmod 0644 "$catalog_tmp"
mv -f -- "$catalog_tmp" "$catalog_output"
trap - EXIT

echo
echo "Wrote $catalog_output"
