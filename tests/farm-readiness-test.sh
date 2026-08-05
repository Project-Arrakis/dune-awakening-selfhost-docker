#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

source "$repo_root/runtime/scripts/farm-readiness.sh"

mock_map_log=""
mock_director_log=""
mock_db_state="true|true"
export mock_map_log mock_director_log mock_db_state

docker() {
  case "${1:-} ${2:-}" in
    "inspect -f")
      printf 'true\n'
      ;;
    "logs --tail")
      printf '%s\n' "$mock_map_log"
      ;;
    "logs --since")
      printf '%s\n' "$mock_director_log"
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
expect_not_ready

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

# Non-primary maps use the same marker/current-state contract without the
# additional Survival login-stability window.
mock_map_log='Server farm is READY (2 server(s), 31 required), partition 2, server def'
farm_partition_is_ready dune-server-overmap 2 0

grep -Fq "when wp.partition_id = 1 then '\${survival_log_ready}'" "$repo_root/runtime/scripts/servers.sh"
grep -Fq "else 'false'" "$repo_root/runtime/scripts/servers.sh"

echo "farm readiness waits for the definitive marker and stable current state"
