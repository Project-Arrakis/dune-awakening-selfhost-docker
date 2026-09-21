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
grep -Fq 'IGW_SOCKET_RECOVERY_COOLDOWN_SECONDS="${DUNE_AUTOSCALER_IGW_SOCKET_RECOVERY_COOLDOWN_SECONDS:-600}"' "$script"
grep -Fq 'docker exec -i "$orchestrator_container" python3 -' runtime/scripts/extract-server-catalog.sh
grep -Fq 'docker exec -i "$orchestrator_container" python3 -' runtime/scripts/extract-partition-catalog.sh
! grep -Fq 'docker compose exec' runtime/scripts/extract-server-catalog.sh
! grep -Fq 'docker compose exec' runtime/scripts/extract-partition-catalog.sh

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
assert 'battlegroup_effective_player_count' in body
assert 'core_map_is_reported_ready "$map"' in body
assert 'DEFER deadlocked core' in body
assert 'online_players=$players action=coordinated-game-farm-restart' in body
assert "docker inspect -f '{{.State.Running}}' dune-coriolis-coordinator" in body
assert 'docker exec -d dune-coriolis-coordinator' in body
assert 'restart-game-farm.sh igw-socket-deadlock' in body
assert 'director_heal_set "$recovery_key" "$now"' in body
assert 'recover_deadlocked_core_map' not in text
assert 'action=map-restart' not in body
assert 'start-server-survival-1.sh' not in body
assert 'start-server-overmap.sh' not in body
assert body.index('battlegroup_effective_player_count') < body.index('docker exec -d dune-coriolis-coordinator')

loop = text.index("while true; do")
assert text.index("scan_core_igw_socket_health", loop) < text.index("scan_director_browser_state", loop)
PY

echo "autoscaler recovers saturated IGW queues through a zero-player coordinated game-farm restart"
