#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

DOCKER_BIN="${DUNE_DOCKER_BIN:-docker}"
DIRECTOR_START_SCRIPT="${DUNE_DIRECTOR_START_SCRIPT:-runtime/scripts/start-director.sh}"
SURVIVAL_START_SCRIPT="${DUNE_SURVIVAL_START_SCRIPT:-runtime/scripts/start-server-survival-1.sh}"
SPICEFIELD_SCRIPT="${DUNE_SPICEFIELD_SCRIPT:-runtime/scripts/spicefield-overrides.sh}"
SIETCH_PUBLISH_SCRIPT="${DUNE_SIETCH_PUBLISH_SCRIPT:-runtime/scripts/publish-sietch-overrides.sh}"

container_running() {
  "$DOCKER_BIN" inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -qx true
}

# Survival_1 does not reliably republish its state after the Director process is
# replaced. Remember its state before the restart so an intentionally stopped
# primary map stays stopped.
survival_was_running=0
if container_running dune-server-survival-1; then
  survival_was_running=1
fi

"$DIRECTOR_START_SCRIPT"

if [ "$survival_was_running" = "1" ]; then
  echo
  echo "Restarting Survival_1 so it registers with the new Director..."
  "$SURVIVAL_START_SCRIPT"
  "$SPICEFIELD_SCRIPT" apply || true
  "$SIETCH_PUBLISH_SCRIPT" restart || true
  "$SIETCH_PUBLISH_SCRIPT" once || true
else
  echo "Survival_1 was not running; leaving it stopped."
fi
