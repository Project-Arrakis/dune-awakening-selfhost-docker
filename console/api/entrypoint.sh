#!/bin/bash
set -e

# Running as non-root (USER dune in Dockerfile). Docker handles UID mapping
# via the compose user: field — the host UID maps to dune's UID 1000 in the
# container. We just verify the mounted /repo is writable.

console_home="${HOME:-/tmp/dune-console-home}"
docker_config="${DOCKER_CONFIG:-${console_home}/.docker}"

if ! mkdir -p "$console_home" "$docker_config" 2>/dev/null; then
  echo "[entrypoint] ERROR: The Console home directory is not writable: $console_home" >&2
  echo "[entrypoint] Docker commands cannot run without a writable home directory." >&2
  exit 1
fi
chmod 700 "$console_home" "$docker_config" 2>/dev/null || true

if ! touch "$docker_config/.dune-write-test" 2>/dev/null; then
  echo "[entrypoint] ERROR: The Docker configuration directory is not writable: $docker_config" >&2
  exit 1
fi
rm -f "$docker_config/.dune-write-test"

if ! touch /repo/.dune-write-test 2>/dev/null; then
  echo "[entrypoint] ERROR: /repo is not writable (UID $(id -u), GID $(id -g))" >&2
  echo "[entrypoint] The host directory is owned by a different UID." >&2
  echo "[entrypoint] Fix: chown -R $(id -u):$(id -g) <host-repo-path>" >&2
  echo "[entrypoint] Or set DUNE_HOST_UID and DUNE_HOST_GID to match the directory owner." >&2
  exit 1
fi
rm -f /repo/.dune-write-test

# The updater that installs this image may come from an older release and
# cannot know about services introduced by the files it has just installed.
# Reconcile the coordinator from the newly built image so direct upgrades from
# any supported older release converge during that same update.
if [ -x /repo/runtime/scripts/start-coriolis-coordinator.sh ]; then
  (
    cd /repo
    runtime/scripts/start-coriolis-coordinator.sh --if-stack-running
  ) || echo "[entrypoint] WARNING: The Coriolis Coordinator could not be started." >&2
fi

exec "$@"
