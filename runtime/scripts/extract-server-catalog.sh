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
catalog_output="runtime/generated/server-catalog.json"
catalog_tmp="$(mktemp "${catalog_output}.tmp.XXXXXX")"

cleanup_catalog_tmp() {
  rm -f -- "$catalog_tmp"
}
trap cleanup_catalog_tmp EXIT

echo "Extracting server catalog from world-template.yaml..."

timeout --kill-after=2s "${catalog_extract_timeout_seconds}s" docker compose exec -T orchestrator python3 - > "$catalog_tmp" <<'PY'
import json
import re
import sys
from pathlib import Path
import yaml

src = Path("/srv/dune/server/scripts/setup/templates/world-template.yaml")
text = src.read_text()

# Replace Funcom placeholders so YAML can parse.
text = re.sub(r"\{([A-Z0-9_]+)\}", r"PLACEHOLDER_\1", text)

doc = yaml.safe_load(text)

spec = doc.get("spec", {})
server_group = spec.get("serverGroup", {})
template = server_group.get("template", {})
template_spec = template.get("spec", {})

sets = template_spec.get("sets", [])

catalog = []

for i, s in enumerate(sets):
    name = s.get("name") or s.get("metadata", {}).get("name") or f"server-set-{i}"
    map_name = s.get("map")
    image = s.get("image")
    args = s.get("args") or s.get("command") or []
    env = s.get("env") or s.get("envVars") or []
    resources = s.get("resources") or {}

    catalog.append({
        "index": i,
        "name": name,
        "map": map_name,
        "image": image,
        "args": args,
        "env": env,
        "resources": resources,
        "raw": s,
    })

json.dump(catalog, sys.stdout, indent=2)
sys.stdout.write("\n")

print(f"server sets: {len(catalog)}", file=sys.stderr)
for item in catalog:
    print(f"{item['index']:02d} name={item['name']} map={item['map']}", file=sys.stderr)
PY

if [ ! -s "$catalog_tmp" ]; then
  echo "Generated server catalog is empty." >&2
  exit 1
fi

chmod 0644 "$catalog_tmp"
mv -f -- "$catalog_tmp" "$catalog_output"
trap - EXIT

echo
echo "Wrote $catalog_output"
