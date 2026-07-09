#!/bin/bash
set -e

mkdir -p /srv/dune/server /srv/dune/steam /srv/dune/generated /srv/dune/cache /home/dune/.steam

if ! getent group docker >/dev/null 2>&1; then
  echo "[entrypoint] docker group not found in container, Docker socket access may fail" >&2
elif ! id -nG | tr ' ' '\n' | grep -qx docker; then
  echo "[entrypoint] WARNING: current user is not in the docker group" >&2
  echo "[entrypoint] Docker socket access may fail unless DOCKER_SOCKET_GID is set in compose" >&2
fi

if ! touch /srv/dune/.write-test 2>/dev/null; then
  echo "[entrypoint] WARNING: /srv/dune is not writable (UID $(id -u), GID $(id -g))" >&2
else
  rm -f /srv/dune/.write-test
fi

exec "$@"
