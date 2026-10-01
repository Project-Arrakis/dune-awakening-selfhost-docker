#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

script="runtime/scripts/autoscaler.sh"
evidence_lib="runtime/scripts/lib/igw-socket-health.sh"

bash -n "$script"
bash -n "$evidence_lib"

grep -Fq 'IGW_SOCKET_STALL_SECONDS="${DUNE_AUTOSCALER_IGW_SOCKET_STALL_SECONDS:-120}"' "$script"
grep -Fq 'IGW_SOCKET_RX_QUEUE_THRESHOLD="${DUNE_AUTOSCALER_IGW_SOCKET_RX_QUEUE_THRESHOLD:-1048576}"' "$script"
grep -Fq 'IGW_SOCKET_DROP_GRACE_SECONDS="${DUNE_AUTOSCALER_IGW_SOCKET_DROP_GRACE_SECONDS:-30}"' "$script"
grep -Fq 'cat /proc/net/udp /proc/net/udp6' "$evidence_lib"
grep -Fq 'igw_socket_table "$container"' "$script"
# The sample must not open its own exec any more -- see igw_socket_table.
! grep -Fq 'docker exec "$container" sh -c' "$script"
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
assert 'igw_socket_evidence_decision' in body
assert 'IGW_SOCKET_DROP_GRACE_SECONDS' in body
assert 'now - last_recovery' in body
assert 'IGW_SOCKET_RECOVERY_COOLDOWN_SECONDS' in body
assert 'battlegroup_effective_player_count' in body
assert 'core_container_igw_port "$container"' in body
assert 'core_map_is_reported_ready "$map" "$port"' in body
assert 'DEFER confirmed IGW socket deadlock' in body
assert 'online_players=$players action=coordinated-game-farm-restart' in body
assert "docker inspect -f '{{.State.Running}}' dune-coriolis-coordinator" in body
assert 'docker exec -d dune-coriolis-coordinator' in body
assert 'restart-game-farm.sh igw-socket-deadlock' in body
assert 'director_heal_set "$recovery_key" "$now"' in body
assert 'record_igw_socket_evidence RECOVERING' in body
assert 'recover_deadlocked_core_map' not in text
assert 'action=map-restart' not in body
assert 'start-server-survival-1.sh' not in body
assert 'start-server-overmap.sh' not in body
assert body.index('battlegroup_effective_player_count') < body.index('docker exec -d dune-coriolis-coordinator')
assert body.index('decision" != "recover"') < body.index('battlegroup_effective_player_count')

port_fn = text[text.index("core_container_igw_port()"):text.index("core_map_is_reported_ready()")]
assert '.Config.Cmd' in port_fn
assert 'IGWPort=' in port_fn

ready_fn = text[text.index("core_map_is_reported_ready()"):text.index("clear_igw_socket_observation()")]
assert 'and igw_port = $port' in ready_fn

loop = text.index("while true; do")
assert text.index("scan_core_igw_socket_health", loop) < text.index("scan_director_browser_state", loop)
PY

# Exercise the decision function directly. A large queue without newly dropped
# datagrams must never request recovery, regardless of how long it persists.
# shellcheck source=runtime/scripts/lib/igw-socket-health.sh
source "$evidence_lib"

assert_decision() {
  local expected="$1"
  shift
  local actual
  actual="$(igw_socket_evidence_decision "$@")"
  if [ "$actual" != "$expected" ]; then
    echo "expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

threshold=1048576
assert_decision 'baseline||' "$threshold" 120 30 100 '' '' '' '' 2097152 0
assert_decision 'baseline||' "$threshold" 120 30 400 '' '' 2097152 0 2097152 0
assert_decision 'draining||' "$threshold" 120 30 110 100 100 2097152 10 1048576 11
assert_decision 'observe|110|110' "$threshold" 120 30 110 '' '' 2097152 10 2097152 11
assert_decision 'observe|110|110' "$threshold" 120 30 230 110 110 2097152 11 2097152 11
assert_decision 'recover|110|230' "$threshold" 120 30 230 110 220 2097152 11 2097152 12
assert_decision 'clear||' "$threshold" 120 30 230 110 220 2097152 11 1024 12

echo "autoscaler requires a non-draining saturated IGW queue with ongoing packet drops before recovery"

# Exercise igw_socket_table's transport choice with a stub engine. The point of
# the host-namespace branch is that it opens no exec at all, so assert on what
# the stub was asked to do rather than on the sample it returned.
table_root="$(mktemp -d)"
trap 'rm -rf "$table_root"' EXIT
mkdir -p "$table_root/bin"
cat > "$table_root/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS"
case "$1" in
  inspect) printf '%s\n' "$DOCKER_NETWORK_MODE" ;;
  exec)    printf 'exec-table\n' ;;
esac
STUB
chmod +x "$table_root/bin/docker"
PATH="$table_root/bin:$PATH"

assert_table_transport() {
  local label="$1" network_mode="$2" want_exec="$3"
  local calls

  DOCKER_CALLS="$table_root/calls" DOCKER_NETWORK_MODE="$network_mode" \
    igw_socket_table dune-server-survival-1 >/dev/null 2>&1 || true
  calls="$(cat "$table_root/calls")"
  rm -f "$table_root/calls"

  if [ "$want_exec" = yes ]; then
    grep -q '^exec ' <<<"$calls" \
      || { echo "$label: expected a fallback exec, got: $calls" >&2; exit 1; }
  else
    ! grep -q '^exec ' <<<"$calls" \
      || { echo "$label: opened an exec it did not need: $calls" >&2; exit 1; }
  fi
}

# Host networking is what the stack actually runs, and is the case that has to
# stay exec-free -- this is the per-map, per-scan cost the change removes.
assert_table_transport 'host networking' host no
# Anything else has its own socket table, which the host cannot see: the port
# filter would match nothing and the watchdog would silently read an empty
# queue, so the exec has to come back.
assert_table_transport 'bridge networking' dune-net yes
assert_table_transport 'unknown network mode' '' yes

echo "igw_socket_table reads the host UDP table under host networking and execs only when the namespace differs"
