#!/usr/bin/env bash

# One way to reach the stack's database from a shell script.
#
# Every query used to be its own `docker exec dune-postgres psql ...`. That is
# fine for a one-shot CLI command but ruinous for the autoscaler, which runs
# sixteen scan functions plus four log-follower loops against the database
# forever: each exec spawns two conmon processes that linger for the engine's
# exit delay, and each one rewrites the container's ExecIDs array in the
# engine's own state database. On a busy Battlegroup that alone produced tens
# of megabytes per second of writes with no game state behind it.
#
# So this seam prefers a plain TCP connection to the port `start-postgres.sh`
# publishes on loopback, and falls back to `docker exec` where no `psql` client
# exists. The split is not a heuristic dressed up as a policy: `psql` ships in
# the orchestrator image and nowhere else, and every container built from that
# image (dune-orchestrator, dune-autoscaler, dune-coriolis-coordinator) runs
# with `--network host`, so whenever the client is present 127.0.0.1 really is
# the host's loopback and really does reach the published port. On the host
# itself -- the `dune` CLI, start-all.sh -- there is usually no client, and the
# exec path is the same code that has always run there.
#
# The engine is addressed as `docker` throughout, which on a Podman host is the
# podman-docker shim; nothing here depends on Docker specifically.

# shellcheck source=runtime/scripts/lib/ports.sh
source runtime/scripts/lib/ports.sh

# How start-postgres.sh provisions the server. The TCP path has to authenticate
# where the exec path did not, so these are stated once and consumed by both
# this library and the script that creates the container.
# shellcheck disable=SC2034 # DUNE_PG_DATABASE is read by start-postgres.sh.
DUNE_PG_SUPERUSER="postgres"
DUNE_PG_SUPERUSER_PASSWORD="postgres"
DUNE_PG_DATABASE="dune"
DUNE_PG_CONTAINER="dune-postgres"

# `auto` (or unset) picks the transport from the environment. An explicit `tcp`
# or `exec` pins it, which is how the tests exercise both paths.
case "${DUNE_PSQL_TRANSPORT:-auto}" in
  auto)
    # type -P, not command -v: command -v would also match a shell function
    # named psql, and this repo used to carry one (deepdesert.sh) whose whole
    # body was a docker exec. Only a real client on PATH means TCP is possible.
    if type -P psql >/dev/null 2>&1; then
      DUNE_PSQL_TRANSPORT="tcp"
    else
      DUNE_PSQL_TRANSPORT="exec"
    fi
    ;;
  tcp|exec) ;;
  *)
    printf '%s\n' "Invalid DUNE_PSQL_TRANSPORT=$DUNE_PSQL_TRANSPORT; expected auto, tcp or exec." >&2
    return 1
    ;;
esac

# Resolved once per process rather than per query: the autoscaler asks for it
# thousands of times an hour and the answer cannot change while it runs.
DUNE_PG_PORT="$(resolve_postgres_port)"

# Run psql against the stack's database as the superuser, passing through any
# psql arguments. Callers supply their own -c/-At/-F flags exactly as they did
# when they spelled out the docker exec.
#
# Both paths read from /dev/null. Many callers run this inside `while read`
# loops, and a psql started over TCP is a direct child that would otherwise
# inherit -- and, given a bare invocation, drain -- the loop's stdin. `docker
# exec` without -i never attached stdin, so redirecting keeps the TCP path
# behaving exactly like the exec path it replaces.
dune_psql() {
  if [ "$DUNE_PSQL_TRANSPORT" = "tcp" ]; then
    PGPASSWORD="$DUNE_PG_SUPERUSER_PASSWORD" command psql \
      -h 127.0.0.1 \
      -p "$DUNE_PG_PORT" \
      -U "$DUNE_PG_SUPERUSER" \
      -d "$DUNE_PG_DATABASE" \
      "$@" </dev/null
  else
    docker exec "$DUNE_PG_CONTAINER" psql \
      -U "$DUNE_PG_SUPERUSER" \
      -d "$DUNE_PG_DATABASE" \
      "$@" </dev/null
  fi
}

# The overwhelmingly common shape: one SQL statement, unaligned tuples only.
psql_value() {
  dune_psql -Atc "$1"
}
