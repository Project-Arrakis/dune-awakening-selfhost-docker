#!/usr/bin/env bash

# Shared, conservative game-map readiness checks.
#
# farm_state.ready is published before the game necessarily accepts players.
# A map is travel-ready only after its own farm-ready marker has appeared and
# the current database state still reports it ready/alive. The marker is cached
# against the current container ID because noisy game logs can push the startup
# line outside a bounded log tail. A recreated container therefore has to emit
# its own marker and can never inherit readiness from an older process.
# Survival_1 also requires several consecutive director reports so an initial
# or flapping ready=true value cannot briefly appear as Ready in the Console.

farm_ready_log_tail_lines="${DUNE_FARM_READY_LOG_TAIL_LINES:-6000}"
farm_ready_director_tail_lines="${DUNE_FARM_READY_DIRECTOR_TAIL_LINES:-10000}"
farm_ready_survival_reports="${DUNE_FARM_READY_SURVIVAL_REPORTS:-3}"
farm_ready_cache_dir="${DUNE_FARM_READY_CACHE_DIR:-runtime/generated/farm-ready-markers}"

farm_cache_ready_marker() {
  local container="$1"
  local partition_id="$2"
  local container_id="$3"
  local cache_file tmp_file

  [[ "$container" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  mkdir -p "$farm_ready_cache_dir" 2>/dev/null || return 1
  cache_file="$farm_ready_cache_dir/${container}.marker"
  tmp_file="${cache_file}.tmp.$$"
  printf '%s|%s\n' "$container_id" "$partition_id" > "$tmp_file" 2>/dev/null || return 1
  mv -f "$tmp_file" "$cache_file" 2>/dev/null
}

farm_cached_ready_marker_matches() {
  local container="$1"
  local partition_id="$2"
  local container_id="$3"
  local cache_file cached=""

  [[ "$container" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  cache_file="$farm_ready_cache_dir/${container}.marker"
  [ -r "$cache_file" ] || return 1
  IFS= read -r cached < "$cache_file" || true
  [ "$cached" = "${container_id}|${partition_id}" ]
}

farm_cache_stable_reports() {
  local container="$1"
  local partition_id="$2"
  local container_id="$3"
  local director_id="$4"
  local cache_file tmp_file

  [[ "$container" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  mkdir -p "$farm_ready_cache_dir" 2>/dev/null || return 1
  cache_file="$farm_ready_cache_dir/${container}.stable"
  tmp_file="${cache_file}.tmp.$$"
  printf '%s|%s|%s\n' "$container_id" "$director_id" "$partition_id" > "$tmp_file" 2>/dev/null || return 1
  mv -f "$tmp_file" "$cache_file" 2>/dev/null
}

farm_cached_stable_reports_match() {
  local container="$1"
  local partition_id="$2"
  local container_id="$3"
  local director_id="$4"
  local cache_file cached=""

  [[ "$container" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  cache_file="$farm_ready_cache_dir/${container}.stable"
  [ -r "$cache_file" ] || return 1
  IFS= read -r cached < "$cache_file" || true
  [ "$cached" = "${container_id}|${director_id}|${partition_id}" ]
}

farm_container_logs_have_ready_marker() {
  local container="$1"
  local partition_id="$2"
  local scope="${3:-tail}"
  local pattern

  pattern="Server farm is READY .*partition ${partition_id}([,[:space:]]|$)"
  if [ "$scope" = "all" ]; then
    # Process substitution makes the match authoritative even when grep exits
    # early and Docker receives SIGPIPE. This keeps a one-time full-log lookup
    # fast without pipefail turning a successful match into a false negative.
    grep -E -m 1 "$pattern" < <(docker logs "$container" 2>&1) >/dev/null
  else
    grep -E -m 1 "$pattern" \
      < <(docker logs --tail "$farm_ready_log_tail_lines" "$container" 2>&1) >/dev/null
  fi
}

farm_container_has_ready_marker() {
  local container="$1"
  local partition_id="$2"
  local container_id

  container_id="$(docker inspect -f '{{.Id}}' "$container" 2>/dev/null)"
  [ -n "$container_id" ] || return 1

  if farm_cached_ready_marker_matches "$container" "$partition_id" "$container_id"; then
    return 0
  fi

  if farm_container_logs_have_ready_marker "$container" "$partition_id"; then
    farm_cache_ready_marker "$container" "$partition_id" "$container_id" || true
    return 0
  fi

  # The Console may first inspect a map after the marker has already rolled out
  # of the bounded tail. Scan the current container's complete log once; a hit
  # is cached, so subsequent status refreshes remain cheap and stable.
  if farm_container_logs_have_ready_marker "$container" "$partition_id" all; then
    farm_cache_ready_marker "$container" "$partition_id" "$container_id" || true
    return 0
  fi

  return 1
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
  local container="${3:-}"
  local container_id="" director_id=""
  local reports report_count

  [ "$required_reports" -gt 0 ] 2>/dev/null || return 0

  if [ -n "$container" ]; then
    container_id="$(docker inspect -f '{{.Id}}' "$container" 2>/dev/null)"
    director_id="$(docker inspect -f '{{.Id}}' dune-director 2>/dev/null)"
    if [ -n "$container_id" ] && [ -n "$director_id" ] \
      && farm_cached_stable_reports_match \
        "$container" "$partition_id" "$container_id" "$director_id"; then
      return 0
    fi
  fi

  reports="$(
    docker logs --tail "$farm_ready_director_tail_lines" dune-director 2>&1 \
      | grep -F "\"partitionId\":${partition_id}," \
      | sed -n 's/.*"ready":\(true\|false\).*/\1/p' \
      | tail -n "$required_reports"
  )"
  report_count="$(grep -c . <<<"$reports" || true)"
  [ "$report_count" -eq "$required_reports" ] || return 1
  grep -Fqx false <<<"$reports" && return 1

  if [ -n "$container_id" ] && [ -n "$director_id" ]; then
    farm_cache_stable_reports \
      "$container" "$partition_id" "$container_id" "$director_id" || true
  fi
  return 0
}

farm_partition_is_ready() {
  local container="$1"
  local partition_id="$2"
  local required_reports="${3:-0}"

  docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true || return 1
  docker inspect -f '{{.State.Running}}' dune-postgres 2>/dev/null | grep -qx true || return 1
  farm_container_has_ready_marker "$container" "$partition_id" || return 1
  farm_partition_db_ready "$partition_id" || return 1
  farm_partition_has_stable_director_reports \
    "$partition_id" "$required_reports" "$container"
}

survival_farm_is_ready() {
  farm_partition_is_ready dune-server-survival-1 1 "$farm_ready_survival_reports"
}

overmap_farm_is_ready() {
  farm_partition_is_ready dune-server-overmap 2 0
}
