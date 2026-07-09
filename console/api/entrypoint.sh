#!/bin/bash
set -e

if [ "$(id -u)" = "0" ]; then
  target_uid="${DUNE_HOST_UID:-1000}"
  target_gid="${DUNE_HOST_GID:-1000}"

  if [ -d /repo ]; then
    chown -R "${target_uid}:${target_gid}" /repo 2>/dev/null || true
  fi

  chown -R "${target_uid}:${target_gid}" /app 2>/dev/null || true

  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u node -- "$@"
  fi
  if command -v gosu >/dev/null 2>&1; then
    exec gosu node "$@"
  fi
  exec su -s /bin/bash node -c 'exec "$@"' -- "$@"
fi

if ! touch /repo/.dune-write-test 2>/dev/null; then
  echo "[entrypoint] WARNING: /repo is not writable (UID $(id -u), GID $(id -g))" >&2
else
  rm -f /repo/.dune-write-test
fi

exec "$@"
