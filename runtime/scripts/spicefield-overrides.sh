#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
SCRIPT_PATH="$PWD/runtime/scripts/spicefield-overrides.sh"

OVERRIDES_FILE="${SPICEFIELD_OVERRIDES_FILE:-runtime/generated/spicefield-overrides.json}"
PID_FILE="${SPICEFIELD_RECONCILE_PID_FILE:-runtime/generated/spicefield-overrides.pid}"
LOG_FILE="${SPICEFIELD_RECONCILE_LOG_FILE:-runtime/generated/spicefield-overrides.log}"
CURRENT_LOG_FILE="${SPICEFIELD_RECONCILE_CURRENT_LOG_FILE:-runtime/generated/spicefield-overrides-current.log}"
DEFAULT_RECONCILE_INTERVAL_SECONDS=60

usage() {
  cat <<'EOF'
Usage: runtime/scripts/spicefield-overrides.sh apply|reconcile|loop|restart|stop|status

Persists and reapplies Console Maps -> Interactive Modifiers -> Spice Fields
settings after the game/database refreshes dune.spicefield_types.
EOF
}

postgres_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres
}

override_count() {
  if [ ! -s "$OVERRIDES_FILE" ]; then
    printf '0'
    return 0
  fi
  python3 - "$OVERRIDES_FILE" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    data = json.loads(path.read_text())
except Exception:
    print(0)
    raise SystemExit(0)
overrides = data.get("overrides", {})
print(len(overrides) if isinstance(overrides, dict) else 0)
PY
}

build_override_sql() {
  local mode="$1"
  python3 - "$OVERRIDES_FILE" "$mode" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
mode = sys.argv[2]
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
    print("select 0::int as changed_rows;")
    raise SystemExit(0)

values = []
for type_id, max_active, max_primed, spawning, spawn_weight in rows:
    values.append(
        f"({type_id}, {max_active}, {max_primed}, {'true' if spawning else 'false'}, {spawn_weight!r}::double precision)"
    )
value_sql = ",\n      ".join(values)

if mode == "drift":
    print(f"""
with override_values(spicefield_type_id, max_globally_active, max_globally_primed, is_spawning_active, global_spawn_weight) as (
  values
      {value_sql}
)
select count(*)::int as drift_count
  from override_values
  left join dune.spicefield_types target
    on target.spicefield_type_id = override_values.spicefield_type_id
 where target.spicefield_type_id is null
    or target.max_globally_active is distinct from override_values.max_globally_active
    or target.max_globally_primed is distinct from override_values.max_globally_primed
    or target.is_spawning_active is distinct from override_values.is_spawning_active
    or target.global_spawn_weight is distinct from override_values.global_spawn_weight;
""")
else:
    print(f"""
with override_values(spicefield_type_id, max_globally_active, max_globally_primed, is_spawning_active, global_spawn_weight) as (
  values
      {value_sql}
),
updated as (
  update dune.spicefield_types target
     set max_globally_active = override_values.max_globally_active,
         max_globally_primed = override_values.max_globally_primed,
         is_spawning_active = override_values.is_spawning_active,
         global_spawn_weight = override_values.global_spawn_weight
    from override_values
   where target.spicefield_type_id = override_values.spicefield_type_id
     and (
       target.max_globally_active is distinct from override_values.max_globally_active
       or target.max_globally_primed is distinct from override_values.max_globally_primed
       or target.is_spawning_active is distinct from override_values.is_spawning_active
       or target.global_spawn_weight is distinct from override_values.global_spawn_weight
     )
   returning 1
)
select count(*)::int as changed_rows from updated;
""")
PY
}

psql_scalar() {
  local sql="$1"
  docker exec -i dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -At <<<"$sql" | tail -n 1 | tr -d '[:space:]'
}

spicefield_table_present() {
  [ "$(psql_scalar "select to_regclass('dune.spicefield_types') is not null;")" = "t" ]
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
  if ! spicefield_table_present; then
    echo "dune.spicefield_types does not exist; skipping Spice Field overrides."
    return 0
  fi

  local changed
  changed="$(psql_scalar "$(build_override_sql apply)")"
  echo "Applied Spice Field overrides from $OVERRIDES_FILE (${changed:-0} row(s) changed)."
}

reconcile_overrides() {
  if [ ! -s "$OVERRIDES_FILE" ]; then
    echo "No Spice Field overrides saved."
    return 0
  fi
  if ! postgres_running; then
    echo "dune-postgres is not running; cannot reconcile Spice Field overrides." >&2
    return 1
  fi
  if ! spicefield_table_present; then
    echo "dune.spicefield_types does not exist; skipping Spice Field override reconciliation."
    return 0
  fi

  local drift
  drift="$(psql_scalar "$(build_override_sql drift)")"
  if [ "${drift:-0}" = "0" ]; then
    echo "Spice Field overrides are in sync ($(override_count) saved)."
    return 0
  fi

  echo "Detected Spice Field override drift (${drift} row(s)); reapplying saved values."
  apply_overrides
}

loop_overrides() {
  mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"
  printf '%s\n' "$$" > "$PID_FILE"
  trap 'rm -f "$PID_FILE"; exit 0' INT TERM EXIT

  local interval="${SPICEFIELD_RECONCILE_INTERVAL_SECONDS:-$DEFAULT_RECONCILE_INTERVAL_SECONDS}"
  if ! printf '%s' "$interval" | grep -Eq '^[0-9]+$' || [ "$interval" -lt 10 ]; then
    interval="$DEFAULT_RECONCILE_INTERVAL_SECONDS"
  fi

  echo "Starting Spice Field override reconciler: interval=${interval}s file=$OVERRIDES_FILE"
  while true; do
    reconcile_overrides || true
    sleep "$interval"
  done
}

stop_loop() {
  if [ -s "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$PID_FILE"
  fi
}

restart_loop() {
  if [ "${SPICEFIELD_RECONCILE_ENABLED:-1}" = "0" ]; then
    echo "Spice Field override reconciler disabled by SPICEFIELD_RECONCILE_ENABLED=0."
    stop_loop
    return 0
  fi
  if [ ! -s "$OVERRIDES_FILE" ]; then
    echo "No Spice Field overrides saved; reconciler not started."
    stop_loop
    return 0
  fi

  stop_loop
  mkdir -p "$(dirname "$LOG_FILE")"
  : > "$LOG_FILE"
  ln -sfn "$(basename "$LOG_FILE")" "$CURRENT_LOG_FILE" 2>/dev/null || true
  if command -v setsid >/dev/null 2>&1; then
    setsid -f bash "$SCRIPT_PATH" loop </dev/null >>"$LOG_FILE" 2>&1
    echo "Started Spice Field override reconciler."
  else
    nohup bash "$SCRIPT_PATH" loop </dev/null >>"$LOG_FILE" 2>&1 &
    echo "Started Spice Field override reconciler (pid $!)."
  fi
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
  reconcile) reconcile_overrides ;;
  loop) loop_overrides ;;
  restart) restart_loop ;;
  stop) stop_loop ;;
  status) status_overrides ;;
  ""|-h|--help|help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
