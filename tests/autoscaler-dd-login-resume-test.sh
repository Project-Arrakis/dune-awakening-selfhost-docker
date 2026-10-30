#!/usr/bin/env bash
# A player who logs out inside a Deep Desert dimension and returns after that dimension's idle
# server despawned is refused by the Director and queued for a partition with no server. The
# Deep Desert travel-response path never runs for a login, so the autoscaler must spawn that exact
# partition itself (#1271).
set -euo pipefail

cd "$(dirname "$0")/.."

script="runtime/scripts/autoscaler.sh"

bash -n "$script"

extract() {
  python3 - "$script" "$1" "$2" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index(sys.argv[2])
end = text.index(sys.argv[3], start)
print(text[start:end])
PY
}

# --- static wiring -------------------------------------------------------------------------
scan="$(extract "scan_deepdesert_login_resumes()" "scan_idle_servers()")"
grep -q 'director_heal_due deepdesert_login_resume' <<<"$scan"
# Exactly one spawn call, and it is the exact-partition form. Never the bare-map form (or any
# other argument): that picks the first unassigned dimension, not the one the player is in.
test "$(grep -v '^[[:space:]]*#' <<<"$scan" | grep -c 'spawn-server\.sh')" -eq 1
grep -qE 'timeout --kill-after=5s [0-9]+s runtime/scripts/spawn-server\.sh "\$partition_id" \|\|' <<<"$scan"
grep -q 'map_is_disabled "DeepDesert_1" && return 0' <<<"$scan"
# The stub below answers by partition id and cannot evaluate SQL, so pin the predicate itself:
# a partition is free only when it has no server_id.
grep -qF "case when coalesce(server_id, '') = '' then 'free' else 'taken' end" <<<"$scan"
grep -qF "where partition_id = \${partition_id}" <<<"$scan"

follow="$(extract "follow_director_travel_demand() {" "scan_igwo_unavailable_maps()")"
grep -q 'scan_deepdesert_login_resumes' <<<"$follow"
# Story recovery stays first; the login resume must run before generic demand handling.
story_at="$(grep -bo 'scan_rejected_story_returns' <<<"$follow" | head -n1 | cut -d: -f1)"
resume_at="$(grep -bo 'scan_deepdesert_login_resumes' <<<"$follow" | head -n1 | cut -d: -f1)"
demand_at="$(grep -bo 'scan_travel_demand' <<<"$follow" | head -n1 | cut -d: -f1)"
test "$story_at" -lt "$resume_at"
test "$resume_at" -lt "$demand_at"

# --- behaviour: which partitions does a Director log ask us to spawn? -----------------------
parser="$(extract "deepdesert_login_resume_partitions()" "scan_deepdesert_login_resumes()")"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
cat >"$log" <<'LOG'
[14:52:49 8 INF Director] Player AAAAAAAAAAAAAAAA requested WorldPartition { PartitionId = 38, ServerId = 5iQw6_4RQeGU37j062cmOw, Map = Survival_1, PartitionDefinition = {"box": {"max_x": 1, "max_y": 1, "min_x": 0, "min_y": 0}, "type": "box2d_array"}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 8, ServerId = , Map = DeepDesert_1, PartitionDefinition = {"box": {"max_x": 1, "max_y": 1, "min_x": 0, "min_y": 0}, "type": "box2d_array"}, DimensionIndex = 0, Blocked = False, Label = DeepDesert_0 }, setting return dimension to 2.
[14:52:50 8 INF Director] Player AAAAAAAAAAAAAAAA requested WorldPartition { PartitionId = 38, ServerId = 5iQw6_4RQeGU37j062cmOw, Map = Survival_1, PartitionDefinition = {"box": {"max_x": 1, "max_y": 1, "min_x": 0, "min_y": 0}, "type": "box2d_array"}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 8, ServerId = , Map = DeepDesert_1, PartitionDefinition = {"box": {"max_x": 1, "max_y": 1, "min_x": 0, "min_y": 0}, "type": "box2d_array"}, DimensionIndex = 0, Blocked = False, Label = DeepDesert_0 }, setting return dimension to 2.
[14:53:10 8 INF Director] Player BBBBBBBBBBBBBBBB requested WorldPartition { PartitionId = 38, ServerId = 5iQw6_4RQeGU37j062cmOw, Map = Survival_1, PartitionDefinition = {}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 36, ServerId = 4q3nMp9kRGW9GqpEIAHpzQ, Map = DeepDesert_1, PartitionDefinition = {}, DimensionIndex = 1, Blocked = False, Label = DeepDesert_1 }, setting return dimension to 2.
[14:53:20 8 INF Director] Player CCCCCCCCCCCCCCCC requested WorldPartition { PartitionId = 38, ServerId = 5iQw6_4RQeGU37j062cmOw, Map = Survival_1, PartitionDefinition = {}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 31, ServerId = , Map = CB_Story_OrbitalMonitor, PartitionDefinition = {}, DimensionIndex = 0, Blocked = False, Label = Story }, setting return dimension to 2.
[14:53:30 8 INF Director] Player DDDDDDDDDDDDDDDD requested WorldPartition { PartitionId = 38, ServerId = 5iQw6_4RQeGU37j062cmOw, Map = Survival_1, PartitionDefinition = {}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 40, ServerId = , Map = DeepDesert_1, PartitionDefinition = {}, DimensionIndex = 2, Blocked = False, Label = DeepDesert_2 }, setting return dimension to 2.
[14:55:01 8 INF Director] Some other teleport path: Teleport not allowed, returning to WorldPartition { PartitionId = 99, ServerId = , Map = DeepDesert_1, PartitionDefinition = {}, DimensionIndex = 3, Blocked = False, Label = DeepDesert_3 }, setting return dimension to 2.
[14:55:18 13 WRN Server] [60 occurrences]: Failed to process travel queue for partition 8.
LOG

# Only login refusals ("Player X requested WorldPartition ...") that return to a DeepDesert_1
# partition with NO server are spawn requests, each partition once however many times it was
# refused: 8 (twice) and 40, not 36 (already has a server), not the story map, and not 99 (a
# refusal line that is not a login request).
partitions="$(bash -c "$parser
deepdesert_login_resume_partitions < \"$log\"")"
test "$partitions" = "8
40"

# Empty or irrelevant input yields nothing and must not fail under set -e / pipefail.
test -z "$(bash -c "set -euo pipefail; $parser
printf '' | deepdesert_login_resume_partitions")"
test -z "$(bash -c "set -euo pipefail; $parser
printf 'unrelated line\n' | deepdesert_login_resume_partitions")"

# --- behaviour: the scan only spawns a free, not-yet-starting, not-recently-tried partition ---
scan_fn="$(extract "scan_deepdesert_login_resumes()" "scan_idle_servers()")"
fixture="$(mktemp -d)"
trap 'rm -f "$log"; rm -rf "$fixture"' EXIT
mkdir -p "$fixture/runtime/scripts"
cat >"$fixture/runtime/scripts/spawn-server.sh" <<'SPAWN'
#!/usr/bin/env bash
printf 'SPAWNED %s\n' "$*" >>"$SPAWN_LOG"
SPAWN
chmod +x "$fixture/runtime/scripts/spawn-server.sh"

run_scan() {
  # $1 database state for partition 8, $2 for partition 40 ("free", "taken" or "" for no such
  # row), $3 running container name for partition 8, $4 partitions whose cooldown is still held
  # (space separated), $5 map disabled (yes|no)
  : >"$fixture/spawn.log"
  (
    cd "$fixture"
    export SPAWN_LOG="$fixture/spawn.log" LOG_FILE="$log" STATE8="$1" STATE40="$2" CONTAINER8="$3" HELD="$4" DISABLED="$5"
    bash -c "set -euo pipefail
$parser
$scan_fn
director_heal_due() {
  case \"\$1\" in
    deepdesert_login_spawn_*) case \" \$HELD \" in *\" \${1#deepdesert_login_spawn_} \"*) return 1 ;; esac ;;
  esac
  return 0
}
director_logs() { cat \"\$LOG_FILE\"; }
map_is_disabled() { [ \"\$DISABLED\" = yes ]; }
# Answer by partition id, and only for the DeepDesert_1 query the scan is supposed to ask.
psql_value() {
  case \"\$1\" in *\"map = 'DeepDesert_1'\"*) ;; *) return 0 ;; esac
  case \"\$1\" in
    *\"partition_id = 8\"*) printf '%s' \"\$STATE8\" ;;
    *\"partition_id = 40\"*) printf '%s' \"\$STATE40\" ;;
  esac
}
dynamic_container_name_for_partition() { [ \"\$1\" = 8 ] && printf '%s' \"\$CONTAINER8\"; return 0; }
scan_deepdesert_login_resumes
wait"
  ) >/dev/null
  sort "$fixture/spawn.log"
}

# Partitions 8 and 40 are refused with no server; both are free and idle, so each is spawned once.
test "$(run_scan free free "" "" no)" = "SPAWNED 40
SPAWNED 8"
# The database decides per partition: 8 free and 40 already taken (a race with the
# travel-response path) spawns only 8, and the reverse spawns only 40.
test "$(run_scan free taken "" "" no)" = "SPAWNED 8"
test "$(run_scan taken free "" "" no)" = "SPAWNED 40"
# A partition with no row is left alone.
test "$(run_scan "" free "" "" no)" = "SPAWNED 40"
# A container that is already starting must not be stacked.
test "$(run_scan free free dune-server-deepdesert-1-8 "" no)" = "SPAWNED 40"
# The cooldown is per partition: holding 8 must not suppress 40, and vice versa.
test "$(run_scan free free "" "8" no)" = "SPAWNED 40"
test "$(run_scan free free "" "40" no)" = "SPAWNED 8"
test -z "$(run_scan free free "" "8 40" no)"
# An operator-disabled Deep Desert is never spawned.
test -z "$(run_scan free free "" "" yes)"

echo "autoscaler deep desert login resume checks passed"
