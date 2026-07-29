#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
# shellcheck disable=SC1091
source runtime/scripts/runtime-env.sh

MEMINFO_FILE="${DUNE_HOST_MEMORY_MEMINFO_FILE:-/proc/meminfo}"
GIB=$((1024 * 1024 * 1024))

meminfo_bytes() {
  local field="$1"
  awk -v field="$field" '$1 == field ":" { printf "%.0f\n", $2 * 1024; exit }' "$MEMINFO_FILE"
}

memory_bytes() {
  awk '
    BEGIN { IGNORECASE = 1 }
    /^[0-9]+([.][0-9]+)?[mg]$/ {
      unit = substr($0, length($0), 1)
      value = substr($0, 1, length($0) - 1)
      multiplier = (tolower(unit) == "g") ? 1073741824 : 1048576
      printf "%.0f\n", value * multiplier
      found = 1
    }
    END { if (!found) exit 1 }
  ' <<<"$1"
}

gib_rounded_up() {
  local bytes="$1"
  echo $(((bytes + GIB - 1) / GIB))
}

host_memory_snapshot() {
  local total available swap_free reserve configured_reserve

  total="$(meminfo_bytes MemTotal)"
  available="$(meminfo_bytes MemAvailable)"
  swap_free="$(meminfo_bytes SwapFree 2>/dev/null || echo 0)"
  configured_reserve="${DUNE_ALWAYS_ON_HOST_MEMORY_RESERVE_GIB:-}"
  if [[ "$configured_reserve" =~ ^[1-9][0-9]*$ ]]; then
    reserve=$((configured_reserve * GIB))
  else
    reserve=$((total * 15 / 100))
    [ "$reserve" -ge $((4 * GIB)) ] || reserve=$((4 * GIB))
  fi
  [ "$reserve" -lt "$total" ] || reserve=$((total / 4))

  printf '%s|%s|%s|%s\n' "$total" "$available" "${swap_free:-0}" "$reserve"
}

recommended_parallelism() {
  local total available swap_free reserve usable slots
  IFS='|' read -r total available swap_free reserve < <(host_memory_snapshot)
  usable=$((total - reserve))
  slots=$((usable / (16 * GIB)))
  [ "$slots" -ge 1 ] || slots=1
  [ "$slots" -le 16 ] || slots=16
  echo "$slots"
}

check_map() {
  local map="$1"
  local partition="${2:-}"
  local result state reason available requested reserve required swap_free limit

  result="$(map_status "$map" "$partition")"
  state="$(status_field "$result" state)"
  reason="$(status_field "$result" reason)"

  if [ "$state" = "disabled" ]; then
    echo "WARN always-on host-memory safety is disabled by DUNE_ALWAYS_ON_HOST_MEMORY_SAFETY=0"
    return 0
  fi
  if [ "$state" != "blocked" ]; then
    return 0
  fi

  if [ "$reason" = "invalid-limit" ]; then
    limit="$(status_field "$result" limit)"
    echo "WAIT always-on map=$map partition=${partition:-unknown} host-memory invalid-limit=$limit"
    return 1
  fi

  available="$(status_field "$result" available_gib)"
  requested="$(status_field "$result" requested_gib)"
  reserve="$(status_field "$result" reserve_gib)"
  required="$(status_field "$result" required_gib)"
  swap_free="$(status_field "$result" swap_free_gib)"
  echo "WAIT always-on map=$map partition=${partition:-unknown} host-memory available=${available}GiB requested=${requested}GiB reserve=${reserve}GiB required=${required}GiB swap-free=${swap_free}GiB"
  echo "     Automatic startup was deferred to protect the host from memory exhaustion. Swap is emergency headroom and is not treated as launch capacity."
  return 1
}

status_field() {
  local line="$1"
  local field="$2"

  awk -v field="$field" '{
    for (i = 1; i <= NF; i++) {
      split($i, parts, "=")
      if (parts[1] == field) {
        sub("^[^=]*=", "", $i)
        print $i
        exit
      }
    }
  }' <<<"$line"
}

map_status() {
  local map="$1"
  local partition="${2:-}"
  local memory requested total available swap_free reserve required

  if [ "${DUNE_ALWAYS_ON_HOST_MEMORY_SAFETY:-1}" = "0" ]; then
    echo "state=disabled reason=operator-override"
    return
  fi

  memory="$(effective_memory_for_map "$map" "$partition")"
  requested="$(memory_bytes "$memory")" || {
    echo "state=blocked reason=invalid-limit limit=$memory"
    return
  }
  IFS='|' read -r total available swap_free reserve < <(host_memory_snapshot)
  required=$((requested + reserve))

  if [ "$available" -lt "$required" ]; then
    printf 'state=blocked reason=host-memory available_gib=%s requested_gib=%s reserve_gib=%s required_gib=%s swap_free_gib=%s\n' \
      "$(gib_rounded_up "$available")" "$(gib_rounded_up "$requested")" "$(gib_rounded_up "$reserve")" \
      "$(gib_rounded_up "$required")" "$(gib_rounded_up "$swap_free")"
    return
  fi

  printf 'state=allowed reason=none available_gib=%s requested_gib=%s reserve_gib=%s required_gib=%s swap_free_gib=%s\n' \
    "$(gib_rounded_up "$available")" "$(gib_rounded_up "$requested")" "$(gib_rounded_up "$reserve")" \
    "$(gib_rounded_up "$required")" "$(gib_rounded_up "$swap_free")"
}

throttled_check_map() {
  local map="$1"
  local partition="${2:-}"
  local state_dir="${DUNE_HOST_MEMORY_WAIT_STATE_DIR:-}"
  local reminder="${DUNE_HOST_MEMORY_WAIT_REMINDER_SECONDS:-300}"
  local now="${DUNE_HOST_MEMORY_WAIT_NOW_EPOCH:-$(date +%s)}"
  local output key state_file lock_file lock_fd previous_time previous_reason reason tmp

  if [ -z "$state_dir" ]; then
    check_map "$map" "$partition"
    return
  fi
  [[ "$reminder" =~ ^[1-9][0-9]*$ ]] || reminder=300
  [[ "$now" =~ ^[0-9]+$ ]] || now="$(date +%s)"
  key="$(printf '%s-%s' "$map" "${partition:-unknown}" | tr -c 'A-Za-z0-9_.-' '-')"
  mkdir -p "$state_dir"
  state_file="$state_dir/$key.state"
  lock_file="$state_dir/$key.lock"
  exec {lock_fd}>"$lock_file"
  flock "$lock_fd"

  if output="$(check_map "$map" "$partition" 2>&1)"; then
    rm -f "$state_file"
    exec {lock_fd}>&-
    [ -z "$output" ] || printf '%s\n' "$output"
    return 0
  fi

  if grep -q 'host-memory invalid-limit=' <<<"$output"; then
    reason="invalid-limit"
  else
    reason="host-memory"
  fi
  previous_time=""
  previous_reason=""
  if [ -r "$state_file" ]; then
    IFS='|' read -r previous_time previous_reason <"$state_file" || true
  fi
  [[ "$previous_time" =~ ^[0-9]+$ ]] || previous_time=""
  if [ -z "$previous_time" ] || [ "$previous_reason" != "$reason" ] || [ $((now - previous_time)) -ge "$reminder" ]; then
    printf '%s\n' "$output"
    tmp="$(mktemp "$state_dir/.${key}.XXXXXX")"
    printf '%s|%s\n' "$now" "$reason" >"$tmp"
    mv "$tmp" "$state_file"
  fi
  exec {lock_fd}>&-
  return 1
}

status() {
  local total available swap_free reserve parallelism
  IFS='|' read -r total available swap_free reserve < <(host_memory_snapshot)
  parallelism="$(recommended_parallelism)"
  printf 'total_gib=%s\n' "$(gib_rounded_up "$total")"
  printf 'available_gib=%s\n' "$(gib_rounded_up "$available")"
  printf 'swap_free_gib=%s\n' "$(gib_rounded_up "$swap_free")"
  printf 'reserve_gib=%s\n' "$(gib_rounded_up "$reserve")"
  printf 'recommended_parallelism=%s\n' "$parallelism"
}

case "${1:-status}" in
  check-map)
    [ "$#" -ge 2 ] || { echo "Usage: $0 check-map <map> [partition]"; exit 2; }
    check_map "$2" "${3:-}"
    ;;
  check-map-throttled)
    [ "$#" -ge 2 ] || { echo "Usage: $0 check-map-throttled <map> [partition]"; exit 2; }
    throttled_check_map "$2" "${3:-}"
    ;;
  map-status)
    [ "$#" -ge 2 ] || { echo "Usage: $0 map-status <map> [partition]"; exit 2; }
    map_status "$2" "${3:-}"
    ;;
  recommended-parallelism)
    recommended_parallelism
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 <status|recommended-parallelism|map-status <map> [partition]|check-map <map> [partition]>"
    exit 2
    ;;
esac
