#!/usr/bin/env bash
set -euo pipefail

# A forced remove sends SIGKILL to PostgreSQL and makes every ordinary
# Battlegroup restart run crash recovery. Let PostgreSQL finish its shutdown
# before removing the container; keep it in place if shutdown fails.
container="$(docker ps -a --filter 'name=^/dune-postgres$' --format '{{.Names}}')"
if [ "$container" != "dune-postgres" ]; then
  exit 0
fi

if [ "$(docker inspect -f '{{.State.Running}}' dune-postgres)" = "true" ]; then
  docker stop --time 120 dune-postgres >/dev/null
fi
docker rm dune-postgres >/dev/null
