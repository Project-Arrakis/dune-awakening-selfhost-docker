#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

script="runtime/scripts/autoscaler.sh"

bash -n "$script"

python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")

sources_start = text.index("named_destination_source_maps()")
sources_end = text.index("named_destination_source_rows()", sources_start)
sources = text[sources_start:sources_end]
assert "CB_Story_DestroyedZanovar" in sources
assert "CB_Story_OrbitalMonitor" in sources

rows_start = sources_end
rows_end = text.index("hub_travel_seen()", rows_start)
rows = text[rows_start:rows_end]
assert "dune.world_partition" in rows
assert "dune.farm_state" in rows
assert "coalesce(fs.alive, false) = true" in rows
assert 'dynamic_container_name_for_partition "$partition_id"' in rows
assert "hub_container_for_map" not in text

replay_start = text.index("replay_hagga_travel_handoff()")
replay_end = text.index("map_uses_dedicated_scaling()", replay_start)
replay = text[replay_start:replay_end]
assert 'local origin_server_id="$3"' in replay
assert 'FLOW_ID="$flow_id" LOG_FILE="$director_log_file"' in replay
assert "ORIGIN_ID=" not in replay
assert "match.group(1) != origin_id" not in replay

scan_start = text.index("scan_named_destination_failures()")
scan_end = text.index("scan_idle_servers()", scan_start)
scan = text[scan_start:scan_end]
assert "done < <(named_destination_source_rows)" in scan
assert 'replay_hagga_travel_handoff "$flow_id" "$destination_name" "$source_server_id"' in scan
assert "for source_map in SH_Arrakeen" not in scan

assert 'Travel_To_HaggaBasin_*|Travel_To_Hagga_Basin_*' in text
PY

source_functions="$(python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("named_destination_source_maps()")
end = text.index("hub_travel_seen()", start)
print(text[start:end])
PY
)"

source_rows="$(bash -c "$source_functions
psql_value() {
  printf '%s\n' \
    'CB_Story_DestroyedZanovar|31|story-server-31' \
    'CB_Story_OrbitalMonitor|32|story-server-32'
}
dynamic_container_name_for_partition() {
  printf 'dune-server-story-%s\n' \"\$1\"
}
named_destination_source_rows")"

test "$source_rows" = "CB_Story_DestroyedZanovar|dune-server-story-31|story-server-31
CB_Story_OrbitalMonitor|dune-server-story-32|story-server-32"

replay_function="$(python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("replay_hagga_travel_handoff()")
end = text.index("map_uses_dedicated_scaling()", start)
print(text[start:end])
PY
)"

replay_log="$(mktemp)"
trap 'rm -f "$replay_log"' EXIT
cat >"$replay_log" <<'LOG'
Notified player(s) of travel response CB_Story_OrbitalMonitor32: {"RequestID":"AABBCCDDEEFF00112233445566778899","MapName":"Survival_1"}
Notified player of travel grant CB_Story_OrbitalMonitor32: {"RequestID":"AABBCCDDEEFF00112233445566778899","Map":"Survival_1"}
LOG

replay_output="$(REPLAY_LOG="$replay_log" bash -c "$replay_function
docker() { cat \"\$REPLAY_LOG\"; }
publish_rmq_json() { printf 'PUBLISHED|%s|%s\n' \"\$2\" \"\$3\"; }
NAMED_DESTINATION_SINCE=10m
replay_hagga_travel_handoff AABBCCDDEEFF00112233445566778899 Travel_To_HaggaBasin_EndCredits story-server-32")"

test "$(grep -c '^PUBLISHED|story-server-32|' <<<"$replay_output")" -eq 2
test "$(grep -cF '"MapName":"HaggaBasin"' <<<"$replay_output")" -eq 1
test "$(grep -cF '"Map":"HaggaBasin"' <<<"$replay_output")" -eq 1

echo "autoscaler recovers Hagga Basin returns from every running new-story instance"
