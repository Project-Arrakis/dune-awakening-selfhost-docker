#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

test_root="$(mktemp -d)"
container="dune-postgres-bootstrap-test-$$"
sql_file="$test_root/bootstrap.sql"
test_password="bootstrap-test'password\\value"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$test_root"
}
trap cleanup EXIT

bash -n runtime/scripts/postgres-bootstrap-sql.sh runtime/scripts/start-postgres.sh

# Start with a valid PostgreSQL data directory that deliberately has neither
# the project role nor the game schema. This is the production failure shape:
# an existing/partial volume has already skipped the one-time init directory.
docker run -d --rm \
  --name "$container" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=dune \
  postgres:17-alpine >/dev/null

for _ in $(seq 1 60); do
  # The official entrypoint briefly starts a temporary server during initdb.
  # Wait for the second readiness marker so the test cannot race that server's
  # intentional shutdown before the final postgres process starts.
  ready_markers="$(docker logs "$container" 2>&1 | grep -c 'database system is ready to accept connections' || true)"
  if [ "$ready_markers" -ge 2 ] \
    && docker exec "$container" pg_isready -U postgres -d dune >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres -d dune >/dev/null

[ "$(docker exec "$container" psql -U postgres -d postgres -Atc "select count(*) from pg_roles where rolname = 'dune';" | tr -d '[:space:]')" = "0" ]
[ "$(docker exec "$container" psql -U postgres -d dune -Atc "select count(*) from pg_namespace where nspname = 'dune';" | tr -d '[:space:]')" = "0" ]

DUNE_DB_PASSWORD="$test_password" runtime/scripts/postgres-bootstrap-sql.sh >"$sql_file"
docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <"$sql_file" >/dev/null

[ "$(docker exec "$container" psql -U postgres -d postgres -Atc "select count(*) from pg_roles where rolname = 'dune' and rolcanlogin;" | tr -d '[:space:]')" = "1" ]
[ "$(docker exec "$container" psql -U postgres -d postgres -Atc "select pg_get_userbyid(datdba) from pg_database where datname = 'dune';" | tr -d '[:space:]')" = "dune" ]
[ "$(docker exec "$container" psql -U postgres -d dune -Atc "select count(*) from pg_namespace where nspname = 'dune';" | tr -d '[:space:]')" = "0" ]
docker exec -e PGPASSWORD="$test_password" "$container" \
  psql -h 127.0.0.1 -U dune -d dune -Atc 'select current_user;' \
  | grep -qx dune

# Reapplication must remain safe, including after migration has created the
# schema. It must not erase the schema or reset unrelated role attributes.
docker exec "$container" psql -U postgres -d dune -v ON_ERROR_STOP=1 \
  -c 'create schema dune authorization dune;' >/dev/null
docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <"$sql_file" >/dev/null
[ "$(docker exec "$container" psql -U postgres -d dune -Atc "select count(*) from pg_namespace where nspname = 'dune' and nspowner = (select oid from pg_roles where rolname = 'dune');" | tr -d '[:space:]')" = "1" ]

# Cluster readiness must not depend on the project database already existing.
# Prove the same bootstrap can restore a missing database without inventing the
# game schema that belongs to Funcom's migration.
docker exec "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'drop database dune with (force);' >/dev/null
docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <"$sql_file" >/dev/null
[ "$(docker exec "$container" psql -U postgres -d postgres -Atc "select pg_get_userbyid(datdba) from pg_database where datname = 'dune';" | tr -d '[:space:]')" = "dune" ]
[ "$(docker exec "$container" psql -U postgres -d dune -Atc "select count(*) from pg_namespace where nspname = 'dune';" | tr -d '[:space:]')" = "0" ]

grep -Fq 'psql -h 127.0.0.1 -p 5432 -U postgres -d postgres' runtime/scripts/start-postgres.sh
grep -Fq 'pg_isready -h 127.0.0.1 -p 5432 -U postgres -d postgres' runtime/scripts/start-postgres.sh
grep -Fq -- '-v ON_ERROR_STOP=1' runtime/scripts/start-postgres.sh
# The literal shell condition is the contract under test.
# shellcheck disable=SC2016
grep -Fq 'if [ "$schema_exists" = "1" ]' runtime/scripts/start-postgres.sh
if grep -Fq '/docker-entrypoint-initdb.d' runtime/scripts/start-postgres.sh; then
  echo "start-postgres.sh must not rely on PostgreSQL's one-time init directory." >&2
  exit 1
fi

python3 - <<'PY'
from pathlib import Path

script = Path("runtime/scripts/start-postgres.sh").read_text()
ready = script.index('if [ "$ready" != "1" ]')
bootstrap = script.index('echo "=== Ensuring dune database role and database ==="')
assert ready < bootstrap, "bootstrap must run only after PostgreSQL readiness"
PY

echo "PostgreSQL bootstrap repairs a partial data volume before migration."
