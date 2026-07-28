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
  local memory requested total available swap_free reserve required

  if [ "${DUNE_ALWAYS_ON_HOST_MEMORY_SAFETY:-1}" = "0" ]; then
    echo "WARN always-on host-memory safety is disabled by DUNE_ALWAYS_ON_HOST_MEMORY_SAFETY=0"
    return 0
  fi

  memory="$(effective_memory_for_map "$map" "$partition")"
  requested="$(memory_bytes "$memory")" || {
    echo "WAIT always-on map=$map partition=${partition:-unknown} host-memory invalid-limit=$memory"
    return 1
  }
  IFS='|' read -r total available swap_free reserve < <(host_memory_snapshot)
  required=$((requested + reserve))

  if [ "$available" -lt "$required" ]; then
    echo "WAIT always-on map=$map partition=${partition:-unknown} host-memory available=$(gib_rounded_up "$available")GiB requested=$(gib_rounded_up "$requested")GiB reserve=$(gib_rounded_up "$reserve")GiB swap-free=$(gib_rounded_up "$swap_free")GiB"
    echo "     Automatic startup was deferred to protect the host from memory exhaustion. Swap is emergency headroom and is not treated as launch capacity."
    return 1
  fi

  return 0
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
  recommended-parallelism)
    recommended_parallelism
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 <status|recommended-parallelism|check-map <map> [partition]>"
    exit 2
    ;;
esac
