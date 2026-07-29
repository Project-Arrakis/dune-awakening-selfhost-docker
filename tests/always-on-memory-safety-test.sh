#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

meminfo="$test_root/meminfo"
write_meminfo() {
  local total_kib="$1"
  local available_kib="$2"
  local swap_free_kib="$3"
  cat > "$meminfo" <<EOF
MemTotal:       ${total_kib} kB
MemFree:        ${available_kib} kB
MemAvailable:   ${available_kib} kB
SwapTotal:      ${swap_free_kib} kB
SwapFree:       ${swap_free_kib} kB
EOF
}

run_safety() {
  (
    cd "$repo_root"
    DUNE_HOST_MEMORY_MEMINFO_FILE="$meminfo" "$repo_root/runtime/scripts/host-memory-safety.sh" "$@"
  )
}

# A 30 GiB host is limited to one heavy startup at a time.
write_meminfo $((30 * 1024 * 1024)) $((12 * 1024 * 1024)) $((32 * 1024 * 1024))
[ "$(run_safety recommended-parallelism)" = "1" ]
if output="$(run_safety check-map DeepDesert_1 31 2>&1)"; then
  echo "expected a 16 GiB map to be deferred on a low-headroom host" >&2
  exit 1
fi
grep -Fq 'Automatic startup was deferred' <<<"$output"
grep -Fq 'swap-free=32GiB' <<<"$output"
grep -Fq 'required=21GiB' <<<"$output"

map_status="$(run_safety map-status DeepDesert_1 31)"
grep -Fq 'state=blocked reason=host-memory' <<<"$map_status"
grep -Fq 'required_gib=21' <<<"$map_status"

# Autoscaler checks log a block immediately, suppress identical loop noise,
# repeat it periodically, and reset as soon as the map becomes admissible.
wait_state="$test_root/waits"
run_throttled() {
  (
    cd "$repo_root"
    DUNE_HOST_MEMORY_MEMINFO_FILE="$meminfo" \
      DUNE_HOST_MEMORY_WAIT_STATE_DIR="$wait_state" \
      DUNE_HOST_MEMORY_WAIT_NOW_EPOCH="$1" \
      "$repo_root/runtime/scripts/host-memory-safety.sh" check-map-throttled DeepDesert_1 31
  )
}
if first_wait="$(run_throttled 100 2>&1)"; then exit 1; fi
grep -Fq 'WAIT always-on' <<<"$first_wait"
if repeated_wait="$(run_throttled 101 2>&1)"; then exit 1; fi
[ -z "$repeated_wait" ]
if reminder_wait="$(run_throttled 400 2>&1)"; then exit 1; fi
grep -Fq 'WAIT always-on' <<<"$reminder_wait"

# Swap remains visible in diagnostics but cannot make an unsafe launch pass.
status="$(run_safety status)"
grep -Fq 'swap_free_gib=32' <<<"$status"

# A host with sufficient physical headroom admits the same map.
write_meminfo $((64 * 1024 * 1024)) $((40 * 1024 * 1024)) $((8 * 1024 * 1024))
[ "$(run_safety recommended-parallelism)" = "3" ]
run_safety check-map DeepDesert_1 31
run_throttled 401

write_meminfo $((30 * 1024 * 1024)) $((12 * 1024 * 1024)) $((32 * 1024 * 1024))
if reset_wait="$(run_throttled 402 2>&1)"; then exit 1; fi
grep -Fq 'WAIT always-on' <<<"$reset_wait"

# Partition overrides use the exact same effective limit as the launcher.
write_meminfo $((30 * 1024 * 1024)) $((8 * 1024 * 1024)) 0
(
  cd "$repo_root"
  DUNE_HOST_MEMORY_MEMINFO_FILE="$meminfo" DUNE_MEMORY_PARTITION_31=2g \
    runtime/scripts/host-memory-safety.sh check-map DeepDesert_1 31
)

# An explicit advanced override remains available and produces a warning.
output="$(cd "$repo_root" && DUNE_HOST_MEMORY_MEMINFO_FILE="$meminfo" DUNE_ALWAYS_ON_HOST_MEMORY_SAFETY=0 runtime/scripts/host-memory-safety.sh check-map DeepDesert_1 31)"
grep -Fq 'host-memory safety is disabled' <<<"$output"

# A stale core farm_state.ready flag must not consume the warm-up slot used
# for Always-On dynamic maps. Core readiness has its own log-aware checks.
grep -Fq "and wp.map not in ('Survival_1', 'Overmap')" "$repo_root/runtime/scripts/map-modes.sh"

echo "always-on startup respects host RAM headroom, effective map limits, and the emergency-only role of swap"
