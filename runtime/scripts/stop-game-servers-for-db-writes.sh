#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

# A full battlegroup restart normally removes PostgreSQL immediately after the
# game servers. Keep PostgreSQL alive for this short, explicit phase so the
# Console can safely apply queued base and vehicle writes before shutdown.
echo "=== Pausing automatic map management ==="
runtime/scripts/autoscaler-control.sh stop || true

echo "=== Stopping always-on map servers ==="
runtime/scripts/stop-server-survival-1.sh
runtime/scripts/stop-server-overmap.sh

echo "=== Stopping dynamic map servers ==="
runtime/scripts/recycle-world-game-servers.sh stop-all
