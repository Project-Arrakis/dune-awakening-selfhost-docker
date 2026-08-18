#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

script="runtime/scripts/autoscaler.sh"

bash -n "$script"

grep -Fq 'IGW_SOCKET_STALL_SECONDS="${DUNE_AUTOSCALER_IGW_SOCKET_STALL_SECONDS:-30}"' "$script"
grep -Fq 'IGW_SOCKET_RX_QUEUE_THRESHOLD="${DUNE_AUTOSCALER_IGW_SOCKET_RX_QUEUE_THRESHOLD:-1048576}"' "$script"
grep -Fq 'cat /proc/net/udp /proc/net/udp6' "$script"
grep -Fq 'dune-server-survival-1|Survival_1' "$script"
grep -Fq 'dune-server-overmap|Overmap' "$script"
grep -Fq 'runtime/scripts/start-server-survival-1.sh >/dev/null 2>&1' "$script"
grep -Fq 'runtime/scripts/start-server-overmap.sh >/dev/null 2>&1' "$script"
grep -Fq 'wait_for_core_map_ready "$container" "$partition"' "$script"
grep -Fq 'publish_state_for_map "$map"' "$script"

python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("scan_core_igw_socket_health()")
end = text.index("battlegroup_effective_player_count()", start)
body = text[start:end]

assert 'director_heal_due igw_socket_health "$IGW_SOCKET_HEALTH_SCAN_SECONDS"' in body
assert 'queue" -lt "$IGW_SOCKET_RX_QUEUE_THRESHOLD"' in body
assert 'age" -lt "$IGW_SOCKET_STALL_SECONDS"' in body
assert 'now - last_recovery' in body
assert 'IGW_SOCKET_RECOVERY_COOLDOWN_SECONDS' in body
assert 'map_effective_player_count "$map"' in body
assert 'core_map_is_reported_ready "$map"' in body
assert body.index('director_heal_set "$first_key" "$now"') < body.index('recover_deadlocked_core_map "$map"')

recover = text[text.index("recover_deadlocked_core_map()"):start]
assert recover.index('wait_for_core_map_ready "$container" "$partition"') < recover.index('publish_state_for_map "$map"')
assert 'docker logs --since "$started_at"' in recover
assert 'Server farm is READY .*partition ${partition}' in recover

loop = text.index("while true; do")
assert text.index("scan_core_igw_socket_health", loop) < text.index("scan_director_browser_state", loop)
PY

echo "autoscaler confirms saturated IGW queues before map-scoped recovery"
