#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

source "$repo_root/runtime/scripts/farm-readiness.sh"

mock_map_log=""
mock_full_map_log=""
mock_director_log=""
mock_db_state="true|true"
mock_container_id="container-generation-1"
mock_director_id="director-generation-1"
mock_container_started_at="2026-09-05T13:00:00Z"
mock_now_epoch="1788614400"
test_cache_dir="$(mktemp -d)"
mock_docker_log_calls_file="$test_cache_dir/docker-log-calls"
trap 'rm -rf "$test_cache_dir"' EXIT
farm_ready_cache_dir="$test_cache_dir"
export mock_map_log mock_full_map_log mock_director_log mock_db_state mock_container_id mock_director_id mock_container_started_at mock_docker_log_calls_file

# Keep Docker as an in-process mock while preserving the production helper's
# call boundary. A separate assertion below verifies that the real helper uses
# the external timeout command.
farm_docker_timeout() {
  "$@"
}

farm_now_epoch() {
  printf '%s\n' "$mock_now_epoch"
}

docker() {
  case "${1:-} ${2:-}" in
    "inspect -f")
      if [ "${3:-}" = "{{.Id}}" ]; then
        if [ "${4:-}" = "dune-director" ]; then
          printf '%s\n' "$mock_director_id"
        else
          printf '%s\n' "$mock_container_id"
        fi
      elif [ "${3:-}" = "{{.State.StartedAt}}" ]; then
        printf '%s\n' "$mock_container_started_at"
      else
        printf 'true\n'
      fi
      ;;
    "logs --since")
      printf '%s\n' "$*" >> "$mock_docker_log_calls_file"
      printf '%s\n' "$mock_director_log"
      ;;
    "logs --tail")
      printf '%s\n' "$*" >> "$mock_docker_log_calls_file"
      if [ "${4:-}" = "dune-director" ]; then
        printf '%s\n' "$mock_director_log"
      else
        printf '%s\n' "$mock_map_log"
      fi
      ;;
    "logs dune-server-survival-1"|"logs dune-server-overmap")
      printf '%s\n' "$*" >> "$mock_docker_log_calls_file"
      printf '%s\n' "$mock_full_map_log"
      ;;
    "exec dune-postgres")
      printf '%s\n' "$mock_db_state"
      ;;
    *)
      printf 'unexpected docker invocation: %s\n' "$*" >&2
      return 1
      ;;
  esac
}

expect_not_ready() {
  if farm_partition_is_ready dune-server-survival-1 1 3; then
    echo "expected Survival_1 to remain finalizing startup" >&2
    exit 1
  fi
}

# An early farm_state.ready value must not make the Console report Ready.
mock_map_log="startup is still loading persistence"
mock_director_log='[ServerState] {"partitionId":1,"ready":true}'
expect_not_ready

# The definitive marker is necessary, but current DB readiness is still
# authoritative if the map falls out of the farm.
mock_map_log='Server farm is READY (2 server(s), 31 required), partition 1, server abc'
mock_db_state="false|true"
mock_director_log=$'[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}'
: > "$mock_docker_log_calls_file"
expect_not_ready
[ ! -s "$mock_docker_log_calls_file" ] || {
  echo "database-not-ready partitions must not scan game logs" >&2
  exit 1
}

# A transient false report resets the startup confirmation.
mock_db_state="true|true"
mock_director_log=$'[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":false}\n[ServerState] {"partitionId":1,"ready":true}'
expect_not_ready

# Fewer than the configured number of reports cannot briefly flash Ready.
mock_director_log=$'[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}'
expect_not_ready

# Marker + current ready/alive state + three consecutive reports is Ready.
mock_director_log=$'[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}'
farm_partition_is_ready dune-server-survival-1 1 3

# Once confirmed, startup stability is retained for the exact map/director
# generations instead of reparsing a noisy Director log on every UI refresh.
mock_director_log=""
farm_partition_is_ready dune-server-survival-1 1 3
mock_director_id="director-generation-2"
expect_not_ready
mock_director_id="director-generation-1"
mock_director_log=$'[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}'

# A marker that rolled out of the bounded tail uses current-generation stable
# Director reports without scanning the complete noisy game log.
rm -f "$test_cache_dir/dune-server-survival-1.marker"
mock_map_log=""
mock_full_map_log='Server farm is READY (2 server(s), 31 required), partition 1, server abc'
: > "$mock_docker_log_calls_file"
farm_partition_is_ready dune-server-survival-1 1 3
if grep -Fq 'logs dune-server-survival-1' "$mock_docker_log_calls_file"; then
  echo "stable Director readiness must avoid a complete game-log scan" >&2
  exit 1
fi
mock_full_map_log=""
farm_partition_is_ready dune-server-survival-1 1 3

# Cached readiness belongs only to the exact container generation.
mock_container_id="container-generation-2"
mock_director_log=""
expect_not_ready
mock_container_id="container-generation-1"

# Non-primary maps use the same marker/current-state contract without the
# additional Survival login-stability window.
mock_map_log='Server farm is READY (2 server(s), 31 required), partition 2, server def'
farm_partition_is_ready dune-server-overmap 2 0

# Non-core maps without Director reports use an age-gated DB fallback and must
# never scan their complete noisy game logs.
mock_map_log=""
mock_director_log=""
mock_container_id="deep-desert-generation-1"
mock_container_started_at="2026-09-05T12:00:00Z"
: > "$mock_docker_log_calls_file"
farm_partition_is_ready dune-server-deepdesert-1-8 8 0
if grep -Fq 'logs dune-server-deepdesert-1-8' "$mock_docker_log_calls_file"; then
  echo "non-core DB readiness fallback must not scan complete game logs" >&2
  exit 1
fi

# A newly created non-core container cannot become ready from DB state alone.
mock_container_id="deep-desert-generation-2"
mock_container_started_at="2026-09-05T13:19:30Z"
if farm_partition_is_ready dune-server-deepdesert-1-8 8 0; then
  echo "recent non-core container must remain finalizing startup" >&2
  exit 1
fi

grep -Fq "when wp.partition_id = 1 then '\${survival_log_ready}'" "$repo_root/runtime/scripts/servers.sh"
grep -Fq "else 'false'" "$repo_root/runtime/scripts/servers.sh"
grep -Fq 'timeout --kill-after=2s "${farm_ready_docker_timeout_seconds}s" "$@"' "$repo_root/runtime/scripts/farm-readiness.sh"

heal_script="$repo_root/runtime/scripts/heal-core-ready.sh"
grep -Fq 'docker_timeout docker logs --tail "$log_tail_lines" "$container_name"' "$heal_script"
if grep -Fq 'docker logs "$container_name"' "$heal_script"; then
  echo "core readiness healing must not scan complete game logs" >&2
  exit 1
fi

echo "farm readiness retains definitive markers only for the current container generation"
