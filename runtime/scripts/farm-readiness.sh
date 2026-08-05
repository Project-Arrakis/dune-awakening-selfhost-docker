#!/usr/bin/env bash

# Shared, conservative game-map readiness checks.
#
# farm_state.ready is published before the game necessarily accepts players.
# A map is travel-ready only after its own farm-ready marker has appeared and
# the current database state still reports it ready/alive. Survival_1 also
# requires several consecutive director reports so an initial or flapping
# ready=true value cannot briefly appear as Ready in the Console.

farm_ready_log_tail_lines="${DUNE_FARM_READY_LOG_TAIL_LINES:-6000}"
farm_ready_report_window="${DUNE_FARM_READY_REPORT_WINDOW:-5m}"
farm_ready_survival_reports="${DUNE_FARM_READY_SURVIVAL_REPORTS:-3}"

farm_container_has_ready_marker() {
  local container="$1"
  local partition_id="$2"

  docker logs --tail "$farm_ready_log_tail_lines" "$container" 2>&1 \
    | grep -Eq "Server farm is READY .*partition ${partition_id}([,[:space:]]|$)"
}

farm_partition_db_ready() {
  local partition_id="$1"
  local state

  state="$(
    docker exec dune-postgres psql -U dune -d dune -Atc "
      select concat(coalesce(fs.ready, false)::text, '|', coalesce(fs.alive, false)::text)
      from dune.world_partition wp
      left join dune.farm_state fs on fs.server_id = wp.server_id
      where wp.partition_id = ${partition_id}
      limit 1;
    " 2>/dev/null | tr -d '[:space:]'
  )"
  [ "$state" = "true|true" ] || [ "$state" = "t|t" ]
}

farm_partition_has_stable_director_reports() {
  local partition_id="$1"
  local required_reports="${2:-1}"
  local reports report_count

  [ "$required_reports" -gt 0 ] 2>/dev/null || return 0

  reports="$(
    docker logs --since "$farm_ready_report_window" dune-director 2>&1 \
      | grep -F "\"partitionId\":${partition_id}," \
      | sed -n 's/.*"ready":\(true\|false\).*/\1/p' \
      | tail -n "$required_reports"
  )"
  report_count="$(grep -c . <<<"$reports" || true)"
  [ "$report_count" -eq "$required_reports" ] || return 1
  ! grep -Fqx false <<<"$reports"
}

farm_partition_is_ready() {
  local container="$1"
  local partition_id="$2"
  local required_reports="${3:-0}"

  docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true || return 1
  docker inspect -f '{{.State.Running}}' dune-postgres 2>/dev/null | grep -qx true || return 1
  farm_container_has_ready_marker "$container" "$partition_id" || return 1
  farm_partition_db_ready "$partition_id" || return 1
  farm_partition_has_stable_director_reports "$partition_id" "$required_reports"
}

survival_farm_is_ready() {
  farm_partition_is_ready dune-server-survival-1 1 "$farm_ready_survival_reports"
}

overmap_farm_is_ready() {
  farm_partition_is_ready dune-server-overmap 2 0
}
