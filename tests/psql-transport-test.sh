#!/usr/bin/env bash
set -euo pipefail

# runtime/scripts/lib/postgres.sh is the one place the runtime scripts reach the
# database from. What matters is that it picks the right transport, builds the
# right command line for each one, and otherwise behaves exactly like the
# container exec it replaces -- including not eating the stdin of the loops it
# is called from.

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

# Two PATHs, because the library chooses its transport by whether a psql client
# exists. Each holds only what the library and the stubs shell out to, so the
# runner's own postgresql-client (GitHub's images ship one) cannot decide the
# answer for us.
mkdir -p "$test_root/with-psql" "$test_root/without-psql"
for tool in bash cat grep; do
  for dir in with-psql without-psql; do
    ln -s "$(command -v "$tool")" "$test_root/$dir/$tool"
  done
done

# The stubs record their argv one element per line -- so an argument containing
# a space cannot masquerade as two -- and drain stdin, which is what the real
# psql does and what makes the `while read` case below meaningful.
write_stub() {
  cat > "$1" <<'STUB'
#!/usr/bin/env bash
printf 'argc=%s\n' "$#" >> "$DUNE_PSQL_TEST_LOG"
printf '%s\n' "$@" >> "$DUNE_PSQL_TEST_LOG"
printf 'PGPASSWORD=%s\n' "${PGPASSWORD-<unset>}" >> "$DUNE_PSQL_TEST_LOG"
cat >/dev/null 2>&1 || true
STUB
  chmod +x "$1"
}
write_stub "$test_root/with-psql/psql"
write_stub "$test_root/with-psql/docker"
write_stub "$test_root/without-psql/docker"

log="$test_root/calls.log"
pre=":"
snippet=":"

# Source the library in a pristine environment and run a snippet against it.
# $pre runs before the source, for the cases that have to influence detection.
seam() {
  local path_dir="$1"; shift
  : > "$log"
  env -i \
    PATH="$test_root/$path_dir" \
    HOME="$test_root" \
    DUNE_PSQL_TEST_LOG="$log" \
    "$@" \
    bash -c "set -euo pipefail; cd '$repo_root'; $pre; source runtime/scripts/lib/postgres.sh; $snippet" </dev/null
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# --- transport detection --------------------------------------------------

# The library resolves on the first query, not when it is sourced, so the
# detection cases have to ask it to.
snippet='dune_psql_init; printf "%s\n" "$DUNE_PSQL_TRANSPORT"'
[ "$(seam with-psql)" = "tcp" ] || fail "a psql client on PATH must select TCP"
[ "$(seam without-psql)" = "exec" ] || fail "no psql client must select the exec path"

# A shell function named psql is not a client. deepdesert.sh used to define one
# whose entire body was a container exec, and `command -v` would have found it.
pre='psql() { :; }'
[ "$(seam without-psql)" = "exec" ] || fail "a psql shell function was mistaken for a client"
pre=":"

# An explicit setting wins over detection, in both directions.
[ "$(seam with-psql DUNE_PSQL_TRANSPORT=exec)" = "exec" ] || fail "DUNE_PSQL_TRANSPORT=exec ignored"
[ "$(seam without-psql DUNE_PSQL_TRANSPORT=tcp)" = "tcp" ] || fail "DUNE_PSQL_TRANSPORT=tcp ignored"

# A typo is a configuration error, not a silent fallback.
seam with-psql DUNE_PSQL_TRANSPORT=tpc 2>"$test_root/err" \
  && fail "an invalid DUNE_PSQL_TRANSPORT was accepted"
grep -q 'Invalid DUNE_PSQL_TRANSPORT=tpc' "$test_root/err"

# --- command lines --------------------------------------------------------

snippet='dune_psql -At -F "|" -c "select 1;"'

seam without-psql >/dev/null
diff -u - "$log" <<'EXPECTED'
argc=12
exec
dune-postgres
psql
-U
postgres
-d
dune
-At
-F
|
-c
select 1;
PGPASSWORD=<unset>
EXPECTED

seam with-psql >/dev/null
diff -u - "$log" <<'EXPECTED'
argc=13
-h
127.0.0.1
-p
15432
-U
postgres
-d
dune
-At
-F
|
-c
select 1;
PGPASSWORD=postgres
EXPECTED

# psql_value is the -Atc shorthand that eight scripts each spelled out by hand.
snippet='psql_value "select count(*) from dune.world_partition;"'
seam without-psql >/dev/null
diff -u - "$log" <<'EXPECTED'
argc=9
exec
dune-postgres
psql
-U
postgres
-d
dune
-Atc
select count(*) from dune.world_partition;
PGPASSWORD=<unset>
EXPECTED

# --- the published port ---------------------------------------------------

# A multi-server host reassigns POSTGRES_PORT, and the TCP path has to follow
# it; an unusable value is refused rather than quietly defaulted away.
snippet='dune_psql -c "select 1;"'
seam with-psql POSTGRES_PORT=25432 >/dev/null
grep -qx '25432' "$log" || fail "POSTGRES_PORT was not used for the TCP connection"
seam with-psql POSTGRES_PORT=99999 2>"$test_root/err" \
  && fail "an out-of-range POSTGRES_PORT was accepted"
grep -q 'Invalid POSTGRES_PORT=99999' "$test_root/err"

# --- configuration read after the library is sourced ----------------------

# spawn-server.sh sources this library in its prologue but reads .env thirty
# lines later, and start-all.sh exports .env after its own sources. Settling the
# port or the transport at source time would pin the defaults for both of them,
# and no amount of configuration in .env would move them.
printf 'POSTGRES_PORT=26432\n' > "$test_root/late-port.env"
snippet='. '"$test_root"'/late-port.env; dune_psql -c "select 1;"'
seam with-psql >/dev/null
grep -qx '26432' "$log" || fail "a POSTGRES_PORT read after the source was ignored"

printf 'DUNE_PSQL_TRANSPORT=exec\n' > "$test_root/late-transport.env"
snippet='. '"$test_root"'/late-transport.env; dune_psql -c "select 1;"'
seam with-psql >/dev/null
grep -qx 'dune-postgres' "$log" \
  || fail "a DUNE_PSQL_TRANSPORT read after the source was ignored"

# --- the caller's stdin survives ------------------------------------------

# Many callers query inside `while read` loops. A psql opened over TCP is a
# direct child that would inherit and drain the loop's stdin, ending the loop
# after one row; the container exec never could. Both must see three rows.
printf 'a\nb\nc\n' > "$test_root/rows"
snippet='n=0; while IFS= read -r _row; do dune_psql -Atc "select 1;"; n=$((n+1)); done < '"$test_root"'/rows; printf "%s\n" "$n"'
[ "$(seam without-psql)" = "3" ] || fail "the exec path consumed the caller's stdin"
[ "$(seam with-psql)" = "3" ] || fail "the TCP path consumed the caller's stdin"

# --- the password does not escape the psql invocation ---------------------

snippet='dune_psql -Atc "select 1;"; printf "PGPASSWORD=%s\n" "${PGPASSWORD-<unset>}"'
[ "$(seam with-psql)" = "PGPASSWORD=<unset>" ] || fail "PGPASSWORD leaked into the calling shell"

# --- no script has drifted back to its own exec ---------------------------

cd "$repo_root"

# Everything that reaches Postgres from a shell statement. Each one sources the
# library and must not spell out an exec of its own again.
shell_converted=(
  runtime/scripts/autoscaler.sh
  runtime/scripts/deepdesert.sh
  runtime/scripts/deferred-reconcile.sh
  runtime/scripts/despawn-server.sh
  runtime/scripts/farm-readiness.sh
  runtime/scripts/landsraad-instance-cleanup.sh
  runtime/scripts/map-modes.sh
  runtime/scripts/publish-network-server-state-overrides.sh
  runtime/scripts/publish-sietch-overrides.sh
  runtime/scripts/recycle-world-game-servers.sh
  runtime/scripts/repair-chat-exchanges.sh
  runtime/scripts/restart-schedule.sh
  runtime/scripts/sietches.sh
  runtime/scripts/spawn-server.sh
  runtime/scripts/spicefield-overrides.sh
  runtime/scripts/start-server-overmap.sh
  runtime/scripts/start-server-survival-1.sh
)

# Everything that reaches Postgres from an embedded `python3 - <<PY` block, via
# the module twin. publish-sietch-overrides.sh appears in both lists: its
# readiness checks are shell and its snapshots are Python.
python_converted=(
  runtime/scripts/publish-deepdesert-overrides.sh
  runtime/scripts/publish-deepdesert-state.sh
  runtime/scripts/publish-sietch-overrides.sh
  runtime/scripts/validate-sietch-state.sh
)

# -i included: a script that pipes SQL in over stdin is reopening the same exec.
raw_exec_re='docker exec (-i )?dune-postgres psql'

for script in "${shell_converted[@]}" "${python_converted[@]}"; do
  ! grep -qE "$raw_exec_re" "$script" \
    || fail "$script queries Postgres through a container exec again"
done

for script in "${shell_converted[@]}"; do
  grep -qx 'source runtime/scripts/lib/postgres.sh' "$script" \
    || fail "$script does not source the Postgres library"
done

for script in "${python_converted[@]}"; do
  grep -q 'dune_psql\.query_tsv(' "$script" \
    || fail "$script does not query through runtime/scripts/dune_psql.py"
done

# The library's own exec is the one the seam is allowed to build in shell, and
# the module's is the only one allowed in Python. This is the check that was
# missing: four publishers spelled the exec as a Python argv list -- ["docker",
# "exec", "dune-postgres", "psql", ...] -- so no grep for the shell string could
# ever see them, and they kept running roughly two execs a second in production
# while this file reported success.
argv_builders="$(grep -rlE '"docker",[[:space:]]*"exec"' runtime/scripts/ || true)"
[ "$argv_builders" = "runtime/scripts/dune_psql.py" ] \
  || fail "a docker exec argv list is built outside the Postgres seam: $argv_builders"

# And the other half of that defect: the module reads its configuration from the
# environment, so a script whose queries run in Python has to export the two
# variables. Sourcing .env alone leaves them invisible to the python3 child, and
# the queries would silently dial the default port whatever the operator set.
for script in "${python_converted[@]}"; do
  grep -qx 'export POSTGRES_PORT DUNE_PSQL_TRANSPORT' "$script" \
    || fail "$script runs Python queries without exporting the seam's settings"
done

# Every remaining raw exec, named. The criterion is how often a script runs, not
# who starts it: these are operator-invoked one-shots, bootstrap and patch
# scripts, probes and update flows, where a single exec costs nothing, several
# of them pipe a .sql file in over stdin, and start-postgres.sh has to work
# before there is a published port to connect to.
#
# network-addresses.sh is the one entry that is not operator-only --
# autoscaler.sh reconciles through it in publish_state_for_map, and
# spawn-server.sh, start-all.sh, start-server-*.sh and config.sh all call it
# too. It stays on the list because every one of those sites is event-driven
# (a demand event, a spawn, a heal past its grace period), not per-tick, so it
# does not accumulate conmon the way a polling loop does. If it ever moves onto
# a timer, it belongs on the seam instead.
#
# The list is exhaustive on purpose -- a new script that opens its own exec
# fails here until someone adds it deliberately, which is how an unattended
# loop ends up on the seam instead of in this list by accident.
may_exec=(
  db-orphan-audit.sh
  db.sh
  doctor.sh
  heal-core-ready.sh
  init-database.sh
  lib/postgres.sh
  manager.sh
  network-addresses.sh
  patch-blueprint-array-bounds.sh
  patch-coriolis-base-backups.sh
  patch-vehicle-recovery-guard.sh
  ping-diagnostics.sh
  probe-autoscaler-signals.sh
  probe-db-partitions.sh
  ready.sh
  reconcile-world-partitions.sh
  servers.sh
  start-postgres.sh
  status.sh
  stop-server-overmap.sh
  stop-server-survival-1.sh
  update-db.sh
  update.sh
)

diff -u \
  <(printf '%s\n' "${may_exec[@]}" | sort) \
  <(grep -rlE "$raw_exec_re" runtime/scripts/ | sed 's|^runtime/scripts/||' | sort) \
  || fail "the set of scripts holding a raw Postgres exec has changed"

# --- the images that run the loops ship a client --------------------------

# The seam takes the TCP path only where a psql client exists, and it does not
# complain when there is none: on the host there is no client and the exec path
# is the right answer. That silence is what let the console image run the
# once-a-second DeepDesert publisher through a container exec per statement for
# months while everything here reported success.
# Matched against the install list rather than the whole file: both Dockerfiles
# name the package in a comment explaining why it is there, and a guard that
# accepted the comment would pass a file that had dropped the package itself.
for dockerfile in orchestrator/Dockerfile console/api/Dockerfile; do
  grep -vE '^[[:space:]]*#' "$dockerfile" | grep -qE '(^|[[:space:]])postgresql-client([[:space:]]|\\|$)' \
    || fail "$dockerfile runs publisher loops but installs no psql client"
done

# --- the two seams state the same facts -----------------------------------

# The shell library and the Python module each carry their own copy of how
# start-postgres.sh provisions the server, because neither language can read the
# other's. A silent disagreement would send one of them to the wrong database or
# authenticate it with the wrong password, so they are compared here.
python3 - <<'PY' || fail "the shell and Python seams disagree"
import re
import sys
from pathlib import Path

sys.path.insert(0, "runtime/scripts")
import dune_psql

shell = Path("runtime/scripts/lib/postgres.sh").read_text()


def shell_value(name):
    match = re.search(rf'^{name}="([^"]*)"$', shell, re.MULTILINE)
    assert match, f"{name} is no longer stated in lib/postgres.sh"
    return match.group(1)


def shell_default_port():
    ports = Path("runtime/scripts/lib/ports.sh").read_text()
    match = re.search(r'port_env_value POSTGRES_PORT (\d+)', ports)
    assert match, "the default Postgres port is no longer stated in lib/ports.sh"
    return int(match.group(1))


pairs = [
    ("DUNE_PG_SUPERUSER", shell_value("DUNE_PG_SUPERUSER"), dune_psql.SUPERUSER),
    ("DUNE_PG_SUPERUSER_PASSWORD", shell_value("DUNE_PG_SUPERUSER_PASSWORD"), dune_psql.SUPERUSER_PASSWORD),
    ("DUNE_PG_DATABASE", shell_value("DUNE_PG_DATABASE"), dune_psql.DATABASE),
    ("DUNE_PG_CONTAINER", shell_value("DUNE_PG_CONTAINER"), dune_psql.CONTAINER),
    ("default port", shell_default_port(), dune_psql.DEFAULT_PORT),
]

for name, in_shell, in_python in pairs:
    if in_shell != in_python:
        print(f"{name}: lib/postgres.sh says {in_shell!r}, dune_psql.py says {in_python!r}", file=sys.stderr)
        raise SystemExit(1)
PY

# --- the library is still the only definition of the helper ---------------

# The library exists to end eight identical copies of this helper. Anything
# that defines its own again has quietly reopened that duplication.
definers="$(grep -rl '^psql_value() {' runtime/scripts/ || true)"
[ "$definers" = "runtime/scripts/lib/postgres.sh" ] \
  || fail "psql_value is defined outside the library: $definers"

echo "psql transport checks passed."
