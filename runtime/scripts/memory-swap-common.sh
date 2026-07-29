#!/usr/bin/env bash

# Shared Docker memory/swap calculations. This file is sourced by world-server
# startup scripts and host-side memory tooling; it must not change shell flags.

memory_swap_allowance_gib() {
  local enabled="${DUNE_MEMORY_SWAP_ENABLED:-0}"
  local allowance="${DUNE_MEMORY_SWAP_PER_SERVER_GIB:-0}"

  if [ "$enabled" != "1" ]; then
    echo 0
    return
  fi
  if ! printf '%s' "$allowance" | grep -Eq '^[1-9][0-9]*$' || [ "$allowance" -gt 16 ]; then
    echo 0
    return
  fi
  echo "$allowance"
}

memory_to_mib() {
  local value="${1:-}"
  awk -v value="$value" '
    BEGIN {
      if (value !~ /^[0-9]+([.][0-9]+)?[mMgG]$/) exit 1
      unit = substr(value, length(value), 1)
      amount = substr(value, 1, length(value) - 1) + 0
      if (unit == "g" || unit == "G") amount *= 1024
      printf "%d\n", int(amount + 0.5)
    }
  '
}

memory_swap_total_for_limit() {
  local memory="$1"
  local allowance_gib memory_mib

  allowance_gib="$(memory_swap_allowance_gib)"
  memory_mib="$(memory_to_mib "$memory")" || {
    printf '%s\n' "$memory"
    return
  }
  if [ "$allowance_gib" -eq 0 ]; then
    # Docker's legacy/default behavior when --memory is set without
    # --memory-swap is an equal amount of additional swap. Live memory
    # updates must spell that total out so changing RAM does not retain a
    # stale swap ceiling from the previous limit.
    printf '%sm\n' "$((memory_mib * 2))"
    return
  fi
  printf '%sm\n' "$((memory_mib + allowance_gib * 1024))"
}

memory_swap_docker_args() {
  local memory="$1"
  [ "$(memory_swap_allowance_gib)" -gt 0 ] || return 0
  printf '%s\n' --memory-swap "$(memory_swap_total_for_limit "$memory")"
}
