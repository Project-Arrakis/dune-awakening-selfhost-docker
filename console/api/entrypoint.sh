#!/bin/bash
set -e

# Running as non-root (USER dune in Dockerfile). Docker handles UID mapping
# via the compose user: field — the host UID maps to dune's UID 1000 in the
# container. We just verify the mounted /repo is writable.

if ! touch /repo/.dune-write-test 2>/dev/null; then
  echo "[entrypoint] ERROR: /repo is not writable (UID $(id -u), GID $(id -g))" >&2
  echo "[entrypoint] This usually means the host directory is owned by a different UID." >&2
  echo "[entrypoint] Fix: chown -R \$(id -u):\$(id -g) <repo-dir> on the host, or set DUNE_HOST_UID/DUNE_HOST_GID to match the owner." >&2
  exit 1
fi
rm -f /repo/.dune-write-test

exec "$@"
