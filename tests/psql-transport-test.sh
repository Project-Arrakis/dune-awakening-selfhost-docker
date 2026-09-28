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

snippet='printf "%s\n" "$DUNE_PSQL_TRANSPORT"'
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

converted=(
  runtime/scripts/autoscaler.sh
  runtime/scripts/deepdesert.sh
  runtime/scripts/despawn-server.sh
  runtime/scripts/map-modes.sh
  runtime/scripts/publish-network-server-state-overrides.sh
  runtime/scripts/publish-sietch-overrides.sh
  runtime/scripts/recycle-world-game-servers.sh
  runtime/scripts/sietches.sh
  runtime/scripts/spawn-server.sh
  runtime/scripts/start-server-overmap.sh
  runtime/scripts/start-server-survival-1.sh
)

for script in "${converted[@]}"; do
  ! grep -q 'docker exec dune-postgres psql' "$script" \
    || fail "$script queries Postgres through a container exec again"
  grep -qx 'source runtime/scripts/lib/postgres.sh' "$script" \
    || fail "$script does not source the Postgres library"
done

# The library exists to end eight identical copies of this helper. Anything
# that defines its own again has quietly reopened that duplication.
definers="$(grep -rl '^psql_value() {' runtime/scripts/ || true)"
[ "$definers" = "runtime/scripts/lib/postgres.sh" ] \
  || fail "psql_value is defined outside the library: $definers"

echo "psql transport checks passed."
