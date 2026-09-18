#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

mkdir -p runtime/generated

LIFECYCLE_LOCK_FILE="${DUNE_BATTLEGROUP_LIFECYCLE_LOCK_FILE:-runtime/generated/battlegroup-lifecycle.lock}"
if [ "${DUNE_BATTLEGROUP_LIFECYCLE_LOCK_HELD:-0}" != "1" ]; then
  if flock -n -E 75 -o "$LIFECYCLE_LOCK_FILE" env DUNE_BATTLEGROUP_LIFECYCLE_LOCK_HELD=1 "$0" "$@"; then
    exit 0
  else
    rc=$?
    [ "$rc" -ne 75 ] || echo "Another battlegroup lifecycle operation is already running." >&2
    exit "$rc"
  fi
fi

if [ "${DUNE_MANUAL_STOP:-0}" = "1" ]; then
  boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)"
  {
    echo "DUNE_MANUAL_STOP=1"
    echo "DUNE_MANUAL_STOP_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "DUNE_MANUAL_STOP_BOOT_ID=$boot_id"
  } > runtime/generated/manual-stop.env
fi

echo "=== Stopping autoscaler ==="
runtime/scripts/autoscaler-control.sh stop || true

echo
echo "=== Stopping Coriolis coordinator ==="
docker rm -f dune-coriolis-coordinator 2>/dev/null || true

echo
echo "=== Stopping sietch override publisher ==="
runtime/scripts/publish-sietch-overrides.sh stop || true
pkill -f "publish-sietch-overrides.sh loop" 2>/dev/null || true

echo
echo "=== Stopping Spice Field override reconciler ==="
runtime/scripts/spicefield-overrides.sh stop || true
pkill -f "spicefield-overrides.sh loop" 2>/dev/null || true

echo
echo "=== Stopping Deep Desert warm-up publisher ==="
runtime/scripts/publish-deepdesert-overrides.sh stop || true
pkill -f "publish-deepdesert-overrides.sh loop" 2>/dev/null || true

echo
echo "=== Stopping network server-state publisher ==="
runtime/scripts/publish-network-server-state-overrides.sh stop || true
pkill -f "publish-network-server-state-overrides.sh loop" 2>/dev/null || true

echo
echo "=== Stopping game servers first ==="
runtime/scripts/recycle-world-game-servers.sh stop-all || true

echo
echo "=== Stopping gateway/director/router ==="
docker rm -f dune-server-gateway dune-director dune-text-router 2>/dev/null || true

echo
echo "=== Stopping RabbitMQ ==="
docker rm -f dune-rmq-game dune-rmq-admin 2>/dev/null || true

echo
echo "=== Stopping Postgres ==="
docker rm -f dune-postgres 2>/dev/null || true

echo
echo "=== Remaining dune containers ==="
docker ps --filter "name=dune-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
