#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

OVERRIDES_FILE="${SPICEFIELD_OVERRIDES_FILE:-runtime/generated/spicefield-overrides.json}"

usage() {
  cat <<'EOF'
Usage: runtime/scripts/spicefield-overrides.sh apply|status

Persists and reapplies Console Maps -> Interactive Modifiers -> Spice Fields
settings after the game/database refreshes dune.spicefield_types.
EOF
}

postgres_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres
}

apply_overrides() {
  if [ ! -s "$OVERRIDES_FILE" ]; then
    echo "No Spice Field overrides saved."
    return 0
  fi
  if ! postgres_running; then
    echo "dune-postgres is not running; cannot apply Spice Field overrides." >&2
    return 1
  fi

  local sql
  sql="$(python3 - "$OVERRIDES_FILE" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
overrides = data.get("overrides", {})
if not isinstance(overrides, dict):
    raise SystemExit("Invalid Spice Field overrides file: overrides must be an object")

rows = []
for key, row in overrides.items():
    if not isinstance(row, dict):
        continue
    try:
        type_id = int(row.get("spicefield_type_id", key))
        max_active = int(row["max_globally_active"])
        max_primed = int(row["max_globally_primed"])
        spawning = row["is_spawning_active"]
        spawn_weight = float(row["global_spawn_weight"])
    except (KeyError, TypeError, ValueError) as exc:
        raise SystemExit(f"Invalid Spice Field override for {key}: {exc}") from exc
    if not isinstance(spawning, bool):
        raise SystemExit(f"Invalid Spice Field override for {key}: is_spawning_active must be true or false")
    if type_id < 1 or max_active < 0 or max_primed < 0 or spawn_weight < 0:
        raise SystemExit(f"Invalid negative Spice Field override for {key}")
    rows.append((type_id, max_active, max_primed, spawning, spawn_weight))

if not rows:
    print("select 0::int as applied where false;")
    raise SystemExit(0)

values = []
for type_id, max_active, max_primed, spawning, spawn_weight in rows:
    values.append(
        f"({type_id}, {max_active}, {max_primed}, {'true' if spawning else 'false'}, {spawn_weight!r}::double precision)"
    )

print("""
do $$
begin
  if to_regclass('dune.spicefield_types') is null then
    raise notice 'dune.spicefield_types does not exist; skipping Spice Field overrides';
    return;
  end if;

  with override_values(spicefield_type_id, max_globally_active, max_globally_primed, is_spawning_active, global_spawn_weight) as (
    values
      %s
  )
  update dune.spicefield_types target
     set max_globally_active = override_values.max_globally_active,
         max_globally_primed = override_values.max_globally_primed,
         is_spawning_active = override_values.is_spawning_active,
         global_spawn_weight = override_values.global_spawn_weight
    from override_values
   where target.spicefield_type_id = override_values.spicefield_type_id;
end $$;
""" % ",\n      ".join(values))
PY
)"

  docker exec -i dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 <<<"$sql"
  echo "Applied Spice Field overrides from $OVERRIDES_FILE."
}

status_overrides() {
  if [ ! -s "$OVERRIDES_FILE" ]; then
    echo "No Spice Field overrides saved."
    return 0
  fi
  python3 - "$OVERRIDES_FILE" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
overrides = data.get("overrides", {})
print(f"saved overrides: {len(overrides) if isinstance(overrides, dict) else 0}")
print(f"file: {path}")
PY
}

case "${1:-}" in
  apply) apply_overrides ;;
  status) status_overrides ;;
  ""|-h|--help|help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
