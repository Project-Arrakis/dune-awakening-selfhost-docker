#!/usr/bin/env bash
set -euo pipefail

# Regression coverage for dune-awakening-selfhost-docker#1156: autoscaler.sh runs
# under `set -euo pipefail`, and three scans read Director logs inside a command
# substitution. With the Director log-cache follower down, stale or not yet
# connected, the reader (runtime/scripts/director-log-cache.py read) exits 1 and,
# unguarded, pipefail + errexit end the WHOLE autoscaler, which then restart-loops.
#
# The three scans are extracted from the script and run in a separate bash process
# (errexit is silently disabled in a subshell on the left of `||`, which would hide
# exactly this failure) against the REAL reader pointed at a cache that does not
# exist. Two modes:
#   gate - the normal path: director_logs_available fails, the scan must defer.
#   race - the follower dies between the availability check and the read: the
#          check is forced to pass, the read fails, the scan must still survive.

cd "$(dirname "$0")/.."

script="${AUTOSCALER_UNDER_TEST:-runtime/scripts/autoscaler.sh}"
bash -n "$script"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

python3 - "$script" "$work/functions.sh" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
names = [
    "director_logs",
    "director_logs_available",
    "director_logs_or_defer",
    "scan_igwo_unavailable_maps",
    "scan_stale_server_state",
    "scan_unscoped_stale_server_state",
    "scan_proactive_hagga_handoffs",
    "scan_deepdesert_loading_responses",
    "scan_rejected_story_returns",
    "scan_travel_demand",
]
out = []
for name in names:
    start = text.index(name + "() {")
    line_end = text.index("\n", start) + 1
    nxt = re.search(r"^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{", text[line_end:], re.M)
    out.append(text[start : line_end + nxt.start()])
Path(sys.argv[2]).write_text("\n".join(out), encoding="utf-8")
PY

# scan function : key it hands director_logs_or_defer (and director_heal_due)
scans=(
  "scan_igwo_unavailable_maps:igwo_unavailable"
  "scan_stale_server_state:stale_server_state"
  "scan_unscoped_stale_server_state:unscoped_stale_server_state"
  "scan_proactive_hagga_handoffs:proactive_hagga"
  "scan_deepdesert_loading_responses:deepdesert_loading"
  "scan_rejected_story_returns:rejected_story_returns"
)

# Static: each scan must carry the availability gate, so an edit that drops it is visible.
for entry in "${scans[@]}" scan_travel_demand:; do
  fn="${entry%%:*}"
  key="${entry#*:}"
  python3 - "$work/functions.sh" "$fn" "$key" <<'PY' || fail "$fn lost its follower guard"
from pathlib import Path
import re
import sys
text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index(sys.argv[2] + "() {")
line_end = text.index("\n", start) + 1
nxt = re.search(r"^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{", text[line_end:], re.M)
body = text[start : line_end + (nxt.start() if nxt else len(text))]
key = sys.argv[3]
if key:
    assert f"director_logs_or_defer {key} || return 0" in body, "interval-giving guard"
else:  # scan_travel_demand has no interval of its own
    assert "director_logs_available || return 0" in body, "plain guard"
PY
done

run_mode() {
  local mode="$1" scan="$2"
  cat >"$work/run.sh" <<EOF
set -euo pipefail
cd "$PWD"
# Stubs for the surrounding autoscaler. Anything that would act on the farm is a
# tripwire: with no log evidence none of it may run.
director_heal_due() { return 0; }
director_heal_get() { return 0; }
director_heal_clear() { echo "\$1" >>"$work/heal-cleared"; }
survival_partition_target_json() { echo '{"partition_id":1,"dimension":0,"port":7777,"ip":"10.0.0.1"}'; }
origin_server_id_for_origin_id() { :; }
psql_value() { :; }
psql_app_value() { :; }
dune_psql() { :; }
rmq_eval() { :; }
publish_rmq_json() { echo "TRIPWIRE publish_rmq_json \$*"; exit 97; }
spawn_or_ensure_server() { echo "TRIPWIRE spawn \$*"; exit 97; }
director_heal_set() { echo "TRIPWIRE director_heal_set \$*"; exit 97; }
demand_event_seen() { return 1; }
remember_demand_event() { :; }
map_is_disabled() { return 1; }
map_is_always_on() { return 1; }
map_is_overmap_active() { return 1; }
map_is_dynamic() { return 1; }
map_for_partition() { :; }
reconcile_always_on_map() { echo "TRIPWIRE reconcile_always_on_map \$*"; exit 97; }
publish_state_for_map() { echo "TRIPWIRE publish_state_for_map \$*"; exit 97; }
IGWO_UNAVAILABLE_SCAN_SECONDS=1
PROACTIVE_HAGGA_SCAN_SECONDS=1
DEEPDESERT_LOADING_SCAN_SECONDS=1
STORY_RETURN_RECOVERY_SCAN_SECONDS=1
HUB_TRAVEL_FILE="$work/hub-travel"
DIRECTOR_HEAL_FILE="$work/heal"
: >"\$HUB_TRAVEL_FILE"
STALE_SERVER_STATE_SCAN_SECONDS=1
IGWO_UNAVAILABLE_COOLDOWN_SECONDS=1
STALE_SERVER_STATE_COOLDOWN_SECONDS=1
NAMED_DESTINATION_SINCE=10m
SINCE=10m
DIRECTOR_LOG_CACHE_FILE="$work/no-such-cache.sqlite"
. "$work/functions.sh"
$( [ "$mode" = race ] && echo 'director_logs_available() { return 0; }' )
$scan
echo SURVIVED
EOF
  bash "$work/run.sh" >"$work/out" 2>&1 || {
    cat "$work/out" >&2
    fail "$scan ended the autoscaler with the log follower down (mode=$mode)"
  }
  grep -q '^SURVIVED$' "$work/out" || fail "$scan did not run to completion (mode=$mode)"
  if grep -q TRIPWIRE "$work/out"; then
    cat "$work/out" >&2
    fail "$scan acted on the farm without log evidence (mode=$mode)"
  fi
}

for entry in "${scans[@]}" scan_travel_demand:; do
  scan="${entry%%:*}"
  key="${entry#*:}"
  : >"$work/heal-cleared"
  run_mode gate "$scan"
  if [ -n "$key" ]; then
    # Deferring must give the interval back, so the next pass retries at once instead of after a
    # full interval of events that were never looked at.
    grep -qx "scan:$key" "$work/heal-cleared" || fail "$scan consumed its interval during the outage (gate)"
  fi
  echo "PASS: $scan defers when the follower is down (gate)"
  run_mode race "$scan"
  echo "PASS: $scan survives the follower dying mid-scan (race)"
done

echo "All autoscaler log-follower-down tests passed."
