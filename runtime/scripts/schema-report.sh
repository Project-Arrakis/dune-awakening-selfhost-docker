#!/usr/bin/env bash
# Reports the current state of the game's PostgreSQL schema, so that claims in
# docs/architecture/DATABASE.md can be re-verified after a game update.
#
# Read-only: this script never writes to the database.
set -euo pipefail

cd "$(dirname "$0")/../.."

POSTGRES_CONTAINER="${DUNE_POSTGRES_CONTAINER:-dune-postgres}"
POSTGRES_ROLE="${DUNE_POSTGRES_ROLE:-dune}"
POSTGRES_DB="${DUNE_POSTGRES_DB:-dune}"

# Errors are deliberately NOT swallowed here. A drift report that silently
# prints empty sections because it could not reach the database is worse than
# no report at all -- section 5 would announce "no drift" on a failed connection.
run_query() {
  docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_ROLE" -d "$POSTGRES_DB" -Atc "$1"
}

preflight() {
  if ! docker inspect -f '{{.State.Running}}' "$POSTGRES_CONTAINER" 2>/dev/null | grep -qx true; then
    echo "error: container '$POSTGRES_CONTAINER' is not running." >&2
    echo "       Set DUNE_POSTGRES_CONTAINER if it is named differently here." >&2
    exit 1
  fi
  if ! run_query 'select 1' >/dev/null 2>&1; then
    echo "error: cannot query database '$POSTGRES_DB' as role '$POSTGRES_ROLE'." >&2
    echo "       Set DUNE_POSTGRES_ROLE / DUNE_POSTGRES_DB if they differ here." >&2
    exit 1
  fi
}

preflight

echo "=== Schema report: $POSTGRES_DB (role $POSTGRES_ROLE) ==="
echo

echo "--- 1. Vintage (the game's own patch log) ---"
# dune.get_schema_version() exists but returns the sentinel 999999, so the
# applied_patches log is the only usable vintage marker.
run_query "select name || '  ' || date from dune.applied_patches order by date desc limit 5"
echo

echo "--- 2. Object counts in schema dune ---"
run_query "
select 'tables      ' || count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='dune' and c.relkind='r'
union all
select 'views       ' || count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='dune' and c.relkind='v'
union all
select 'functions   ' || count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='dune' and p.prokind='f'
union all
select 'procedures  ' || count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='dune' and p.prokind='p'
order by 1"
echo

echo "--- 3. Notify channels (channel, call sites) ---"
run_query "
select ch || '  ' || count(*) from (
  select (regexp_matches(p.prosrc, 'pg_notify\(''([a-z_]+)''', 'g'))[1] as ch
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='dune'
) s
group by ch
order by count(*) desc, ch"
echo

echo "--- 4. Non-internal triggers (trigger, table) ---"
run_query "
select t.tgname || '  ' || c.relname
from pg_trigger t
join pg_class c on c.oid=t.tgrelid
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='dune' and not t.tgisinternal
order by t.tgname"
echo

echo "--- 5. Drift: dune.* referenced in console/api/src but absent from the database ---"

# The grep pattern constrains names to [a-z_0-9]+, so they are safe to inline.
referenced=$(grep -rhoE "dune\.[A-Za-z_0-9]+" console/api/src --include='*.js' | sed 's/^dune\.//' | tr '[:upper:]' '[:lower:]' | sort -u || true)

if [ -z "$referenced" ]; then
  echo "error: found no dune.* references in console/api/src -- has the layout moved?" >&2
  exit 1
fi

# One round trip, not three per name. Functions are matched on proname rather
# than to_regprocedure('name()'), which would only ever match zero-argument
# functions and would falsely flag every function that takes parameters.
mapfile -t referenced_names <<< "$referenced"
values=$(printf "('%s')," "${referenced_names[@]}" | sed 's/,$//')

run_query "
select v.n
from (values $values) v(n)
where to_regclass('dune.' || v.n) is null
  and to_regtype('dune.' || v.n) is null
  and not exists (
    select 1 from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'dune' and p.proname = v.n
  )
order by v.n"

echo
echo "A name listed above is either correctly guarded by a capability probe"
echo "(tableExists / functionExists in console/api/src/duneDb.js), created"
echo "lazily on first use, or a latent bug. Check which before acting."
echo
echo "Note: the extraction is textual, so a 'dune.<word>' written in a comment"
echo "or an error string is reported too. Confirm a name is really used in a"
echo "query before treating it as drift."
