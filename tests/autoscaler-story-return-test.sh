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

rejected_start = text.index("scan_rejected_story_returns()")
rejected_end = text.index("scan_idle_servers()", rejected_start)
rejected = text[rejected_start:rejected_end]
assert "Teleport not allowed" in rejected
assert "CB_Story_(?:DestroyedZanovar|OrbitalMonitor)" in rejected
assert "target_fs.ready = true" in rejected
assert "target_fs.alive = true" in rejected
assert "ServerId = ([A-Za-z0-9_+\\-/]*)" in rejected
assert "ps.previous_server_partition_id = $source_partition" in rejected
assert "join dune.world_partition source_wp" not in rejected
assert "with moved as (" in rejected
assert "update dune.encrypted_player_state" in rejected
assert "delete from dune.travel_return_info" in rejected
assert "returning account_id, player_controller_id" in rejected
assert "select player_controller_id\n          from moved" in rejected
assert "from dune.actors\n          where owner_account_id" not in rejected
assert "(select count(*) from cleared_return)" in rejected
assert '[ "$moved_account_id" = "$account_id" ] || continue' in rejected
assert "remember_story_return_hold" in rejected
alignment = text[text.index("scan_live_player_partition_alignment()"):text.index("scan_travel_demand()", text.index("scan_live_player_partition_alignment()"))]
assert "wp.map in ('CB_Story_DestroyedZanovar', 'CB_Story_OrbitalMonitor')" in alignment
assert "return_wp.partition_id = ps.previous_server_partition_id" in alignment
assert "coalesce(return_wp.dimension_index, 0) = ps.return_dimension_index" in alignment
assert "return_fs.ready = true" in alignment and "return_fs.alive = true" in alignment
main_loop = text.rindex("while true; do")
assert text.index("maintain_story_return_holds", main_loop) < text.index("scan_rejected_story_returns", main_loop)
assert text.index("scan_rejected_story_returns", main_loop) < text.index("scan_named_destination_failures", main_loop)
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

rejected_function="$(python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("scan_rejected_story_returns()")
end = text.index("scan_idle_servers()", start)
print(text[start:end])
PY
)"

rejected_log="$(mktemp)"
rejected_sql="$(mktemp)"
rejected_seen="$(mktemp)"
trap 'rm -f "$replay_log" "$rejected_log" "$rejected_sql" "$rejected_seen"' EXIT
cat >"$rejected_log" <<'LOG'
2026-09-18T10:39:04Z [10:39:04 9 INF Main] Handling LoginRequest request in LoginRequest { RequestID = 0335A8724B8F8F5B0DB6908CCE7CEFCC, Player = Player { Id = 745EF36C1E46811A, TargetDimension = 1 }, IsCancellation = False, PasswordOrToken =  }. Looking for player partition
2026-09-18T10:39:04Z [10:39:04 9 INF Main] Player 745EF36C1E46811A requested WorldPartition { PartitionId = 31, ServerId = targetServer31, Map = Survival_1, PartitionDefinition = {"box": {}}, DimensionIndex = 1, Blocked = False, Label = Alraab }. Teleport not allowed, returning to WorldPartition { PartitionId = 133, ServerId = , Map = CB_Story_OrbitalMonitor, PartitionDefinition = {"box": {}}, DimensionIndex = 0, Blocked = False, Label = OrbitalMonitor_0 }, setting return dimension to 1.
LOG

rejected_output="$(REJECTED_LOG="$rejected_log" REJECTED_SQL="$rejected_sql" REJECTED_SEEN="$rejected_seen" bash -c "$rejected_function
docker() { cat \"\$REJECTED_LOG\"; }
hub_travel_seen() { grep -qx \"\$1\" \"\$REJECTED_SEEN\"; }
remember_hub_travel() { printf '%s\\n' \"\$1\" >> \"\$REJECTED_SEEN\"; }
remember_story_return_hold() { :; }
psql_value() {
  printf '%s\\n' \"\$1\" >> \"\$REJECTED_SQL\"
  case \"\$1\" in
    *'select a.id'*) printf '42\\n' ;;
    *) printf '42|1\\n' ;;
  esac
}
NAMED_DESTINATION_SINCE=10m
STORY_RETURN_HOLD_SECONDS=300
scan_rejected_story_returns
scan_rejected_story_returns")"

test "$(grep -c '^STORY-RETURN account=42 request=0335A8724B8F8F5B0DB6908CCE7CEFCC ' <<<"$rejected_output")" -eq 1
grep -Fq 'cleared_return_rows=1' <<< "$rejected_output"
grep -Fq "server_id = 'targetServer31'" "$rejected_sql"
grep -Fq "ps.server_id = 'targetServer31' or ps.previous_server_partition_id = 133" "$rejected_sql"
grep -Fq "eps.server_id = 'targetServer31' or eps.previous_server_partition_id = 133" "$rejected_sql"
if grep -Fq 'join dune.world_partition source_wp' "$rejected_sql"; then
  echo "story return recovery must not depend on the transient source partition row" >&2
  exit 1
fi
grep -Fq 'previous_server_partition_id = 31' "$rejected_sql"
grep -Fq 'return_dimension_index = 1' "$rejected_sql"
grep -Fq 'delete from dune.travel_return_info' "$rejected_sql"
grep -Fq 'select player_controller_id' "$rejected_sql"
grep -Fq 'from moved' "$rejected_sql"
if grep -Fq 'from dune.actors' "$rejected_sql"; then
  echo "story return cleanup must use the moved player's controller ID" >&2
  exit 1
fi

# Exercise the exact recovery CTE against temporary PostgreSQL tables. The
# controller has no actor ownership row, which used to leave its return state.
if [ -n "${DUNE_TEST_POSTGRES_CONTAINER:-}" ]; then
  pg_result="$(python3 - "$script" <<'PY' | docker exec -i "$DUNE_TEST_POSTGRES_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d dune -Atq
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
query = text.split('recovery_result="$(psql_value "', 1)[1].split('\n    ")', 1)[0]
for old, new in (
    ("dune.encrypted_player_state", "test_story_player_state"),
    ("dune.travel_return_info", "test_story_return_info"),
    ("$target_server", "target-hagga"),
    ("$source_server", "source-story"),
    ("$target_partition", "31"),
    ("$target_dimension", "1"),
    ("$account_id", "42"),
    ("$encrypted_source_predicate", "eps.server_id = 'source-story' or eps.previous_server_partition_id = 133"),
):
    query = query.replace(old, new)
query = query.replace("select distinct account_id, (select count(*) from cleared_return) from moved;", "select 'moved=' || account_id || '|cleared=' || (select count(*) from cleared_return) from moved;")
print("begin;")
print("create temp table test_story_player_state (account_id bigint, player_controller_id bigint, server_id text, previous_server_partition_id bigint, return_dimension_index integer, pending_respawn_location_id bigint);")
print("create temp table test_story_return_info (player_controller_id bigint, map text);")
print("insert into test_story_player_state values (42, 1001, 'source-story', 133, 0, 7);")
print("insert into test_story_return_info values (1001, 'CB_Story_OrbitalMonitor');")
print(query)
print("select 'remaining=' || count(*) from test_story_return_info;")
print("select 'state=' || server_id || ':' || previous_server_partition_id || ':' || return_dimension_index from test_story_player_state where account_id = 42;")
print("rollback;")
PY
  )"
  grep -qx 'moved=42|cleared=1' <<< "$pg_result"
  grep -qx 'remaining=0' <<< "$pg_result"
  grep -qx 'state=target-hagga:31:1' <<< "$pg_result"

  alignment_result="$(python3 - "$script" <<'PY' | docker exec -i "$DUNE_TEST_POSTGRES_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d dune -Atq -F '|'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
query = text.split('scan_live_player_partition_alignment() {', 1)[1].split('-c "', 1)[1].split('\n  " | while', 1)[0]
for old, new in (
    ("dune.player_state", "test_align_player_state"),
    ("dune.world_partition", "test_align_world_partition"),
    ("dune.farm_state", "test_align_farm_state"),
):
    query = query.replace(old, new)
print("begin;")
print("create temp table test_align_player_state (account_id bigint, server_id text, previous_server_partition_id bigint, return_dimension_index integer, online_status text);")
print("create temp table test_align_world_partition (server_id text, partition_id bigint, map text, dimension_index integer);")
print("create temp table test_align_farm_state (server_id text, ready boolean, alive boolean);")
print("insert into test_align_world_partition values ('story-server', 133, 'CB_Story_OrbitalMonitor', 0), ('hagga-server', 31, 'Survival_1', 1), ('normal-server', 3, 'SH_Arrakeen', 0);")
print("insert into test_align_farm_state values ('hagga-server', true, true);")
print("insert into test_align_player_state values (2, 'story-server', 31, 1, 'Online'), (3, 'normal-server', 31, 1, 'Online'), (4, 'story-server', 31, 0, 'Online');")
print(query)
print("rollback;")
PY
  )"
  grep -qx '3|normal-server|3|0|31' <<< "$alignment_result"
  grep -qx '4|story-server|133|0|31' <<< "$alignment_result"
  if grep -q '^2|' <<< "$alignment_result"; then
    echo "live alignment must preserve the ready story return destination" >&2
    exit 1
  fi
fi

hold_functions="$(python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("remember_story_return_hold()")
end = text.index("deepdesert_travel_seen()", start)
print(text[start:end])
PY
)"

completion_function="$(python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("story_return_completed()")
end = text.index("maintain_story_return_holds()", start)
print(text[start:end])
PY
)"
completion_log="$(mktemp)"
printf '%s\n' 'TravelCompletion { FlsId = 745EF36C1E46811A, MapName = Survival_1, PartitionId = 31, ServerID = targetServer31 }' > "$completion_log"
COMPLETION_LOG="$completion_log" bash -c "$completion_function
docker() { cat \"\$COMPLETION_LOG\"; }
NAMED_DESTINATION_SINCE=10m
story_return_completed 745EF36C1E46811A 31 targetServer31 Survival_1 1789740700"
if COMPLETION_LOG="$completion_log" bash -c "$completion_function
docker() { cat \"\$COMPLETION_LOG\"; }
NAMED_DESTINATION_SINCE=10m
story_return_completed 745EF36C1E46811A 99 targetServer31 Survival_1 1789740700"; then
  echo "story return completion must match the exact target partition" >&2
  exit 1
fi

hold_file="$(mktemp)"
trap 'rm -f "$replay_log" "$rejected_log" "$rejected_sql" "$rejected_seen" "$hold_file" "$completion_log"' EXIT
printf '42\t745EF36C1E46811A\t31\ttargetServer31\tSurvival_1\t1\t133\tstoryServer133\tCB_Story_OrbitalMonitor\t1789740700\t4102444800\n' > "$hold_file"
hold_output="$(STORY_RETURN_HOLD_FILE="$hold_file" bash -c "$hold_functions
story_return_completed() { return 1; }
psql_value() {
  case \"\$1\" in
    *'with eligible as ('*) printf '42|storyServer133|1\\n' ;;
    *) printf 'storyServer133\\n' ;;
  esac
}
NAMED_DESTINATION_SINCE=10m
maintain_story_return_holds")"
grep -Fq 'STORY-RETURN-HOLD account=42 action=reassert' <<< "$hold_output"
grep -q '^42' "$hold_file"

unrelated_output="$(STORY_RETURN_HOLD_FILE="$hold_file" bash -c "$hold_functions
story_return_completed() { return 1; }
psql_value() {
  case \"\$1\" in
    *'with eligible as ('*) return 0 ;;
    *) printf 'unrelatedServer\\n' ;;
  esac
}
NAMED_DESTINATION_SINCE=10m
maintain_story_return_holds")"
grep -Fq 'STORY-RETURN-HOLD account=42 action=cancelled reason=unrelated-travel' <<< "$unrelated_output"
test ! -s "$hold_file"

echo "autoscaler recovers Hagga Basin returns from every running new-story instance"
