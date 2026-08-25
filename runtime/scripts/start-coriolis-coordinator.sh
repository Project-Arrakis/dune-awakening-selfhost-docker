#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ "${DUNE_RUNTIME_PERMISSIONS_REPAIRED:-0}" != "1" ]; then
  runtime/scripts/repair-host-runtime-permissions.sh
  export DUNE_RUNTIME_PERMISSIONS_REPAIRED=1
fi

[ -f .env ] && . ./.env
source runtime/scripts/host-paths.sh
source runtime/scripts/runtime-env.sh

CONTAINER_NAME="dune-coriolis-coordinator"
IMAGE="dune-orchestrator:dev"
REPO_UID="$(stat -c '%u' .)"
REPO_GID="$(stat -c '%g' .)"
HOST_UID="${DUNE_HOST_UID:-$REPO_UID}"
HOST_GID="${DUNE_HOST_GID:-$REPO_GID}"
DOCKER_SOCK_GID="${DOCKER_SOCKET_GID:-}"
CONTAINER_REPO_ROOT="/repo"
HOST_REPO_ROOT="$(host_path "$PWD")"

if [ "${DUNE_CORIOLIS_COORDINATOR_ENABLED:-1}" = "0" ]; then
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  echo "Coriolis coordinator is disabled."
  exit 0
fi
if [ "$HOST_UID" = "0" ] && [ "$REPO_UID" != "0" ]; then HOST_UID="$REPO_UID"; fi
if [ "$HOST_GID" = "0" ] && [ "$REPO_GID" != "0" ]; then HOST_GID="$REPO_GID"; fi
if [ -z "$DOCKER_SOCK_GID" ] && [ -S /var/run/docker.sock ]; then
  DOCKER_SOCK_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)"
fi

mkdir -p runtime/generated runtime/logs
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Coriolis coordinator already running: $CONTAINER_NAME"
  exit 0
fi
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "Cannot start Coriolis coordinator: Docker image not found: $IMAGE" >&2
  exit 1
}

group_args=()
if [ -n "$DOCKER_SOCK_GID" ]; then group_args+=(--group-add "$DOCKER_SOCK_GID"); fi

docker run -d \
  "${DUNE_DOCKER_LOG_ARGS[@]}" \
  --name "$CONTAINER_NAME" \
  --network host \
  --restart unless-stopped \
  --user "${HOST_UID}:${HOST_GID}" \
  "${group_args[@]}" \
  --entrypoint bash \
  -e "DUNE_CONTAINER_REPO_ROOT=$CONTAINER_REPO_ROOT" \
  -e "DUNE_HOST_REPO_ROOT=$HOST_REPO_ROOT" \
  -e "DUNE_HOST_UID=$HOST_UID" \
  -e "DUNE_HOST_GID=$HOST_GID" \
  -e DUNE_RUNTIME_PERMISSIONS_REPAIRED=1 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOST_REPO_ROOT:$CONTAINER_REPO_ROOT" \
  -w "$CONTAINER_REPO_ROOT" \
  "$IMAGE" \
  runtime/scripts/coriolis-coordinator.sh monitor >/dev/null

echo "Coriolis coordinator started: $CONTAINER_NAME"
