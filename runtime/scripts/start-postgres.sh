#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/host-paths.sh
source runtime/scripts/runtime-env.sh
source runtime/scripts/image-tags.sh
# shellcheck disable=SC1091
source runtime/scripts/lib/secrets.sh
POSTGRES_IMAGE_TAG="$(resolve_postgres_image_tag)"
IMAGE="registry.funcom.com/funcom/self-hosting/igw-postgres:${POSTGRES_IMAGE_TAG}"
POSTGRES_PORT="$(resolve_postgres_port)"

mkdir -p runtime/postgres/initdb

dune_db_password="${DUNE_DB_PASSWORD:-dune}"
dune_db_password_sql="$(printf '%s' "$dune_db_password" | sed "s/'/''/g")"

cat > runtime/postgres/initdb/01-create-dune-user.sql <<SQL
DO
\$\$
BEGIN
   IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_roles WHERE rolname = 'dune'
   ) THEN
      CREATE ROLE dune LOGIN PASSWORD '$dune_db_password_sql';
   END IF;
END
\$\$;

ALTER DATABASE dune OWNER TO dune;
GRANT ALL PRIVILEGES ON DATABASE dune TO dune;
SQL

# GHSA-fc89-h24v-6j3x follow-on (issue #128, design doc section 11 item
# 10): this file is generated fresh on every run and previously had no
# explicit permission set, defaulting to the umask's usual 644 --
# world-readable, containing the dune role's password in plaintext SQL.
# Tighten to 600 immediately after writing, regardless of umask.
chmod 600 runtime/postgres/initdb/01-create-dune-user.sql

docker network create dune-net 2>/dev/null || true

docker rm -f dune-postgres 2>/dev/null || true

docker volume create dune-postgres-data >/dev/null

# Postgres superuser credential: previously a hardcoded, fixed
# literal value passed via -e POSTGRES_PASSWORD=..., visible in full
# via `docker inspect --format '{{.Config.Env}}'` to anyone with
# Docker socket access. Resolved via the shared secrets seam (section 4
# of the design doc): if age-based secrets are configured
# (dune_secrets_backend_configured), read/generate-and-persist a real
# random superuser password through that path; otherwise, fall back to
# the exact previous default value so an operator who has never run
# `dune secrets setup` sees zero behavior change -- per section 7.1,
# this remains strictly opt-in.
postgres_superuser_password_render="runtime/generated/.pg-superuser-password-runtime"
mkdir -p runtime/generated
if dune_secrets_backend_configured; then
  # This secret has no pre-existing flat-file convention to fall back
  # to (unlike funcom-token.txt etc., which already existed before this
  # feature) -- so dune_secrets_read_secret's generic legacy-file
  # fallback is deliberately NOT used here. Reading directly via
  # dune_secrets_read_encrypted instead avoids a real bug: passing
  # /dev/null as a "legacy path" would make dune_secrets_read_secret
  # treat a readable-but-empty /dev/null as a successful read of an
  # empty-string password on first run, silently skipping generation of
  # a real one.
  if ! postgres_superuser_password="$(dune_secrets_read_encrypted "postgres-superuser-password" 2>/dev/null)"; then
    postgres_superuser_password="$(dune_secrets_generate_dek)"
    dune_secrets_write_secret "postgres-superuser-password" "$postgres_superuser_password"
  fi
else
  postgres_superuser_password="postgres"
fi

# Render to a short-lived, 0600, non-git-tracked file for the sole
# purpose of the bind-mount below -- never the same file as the
# age-encrypted form (runtime/secrets/postgres-superuser-password.enc),
# and deleted immediately after the container is started, per section 3
# of the design doc's flow chart.
umask 077
printf '%s' "$postgres_superuser_password" > "$postgres_superuser_password_render"
chmod 600 "$postgres_superuser_password_render"

docker run -d \
  "${DUNE_DOCKER_LOG_ARGS[@]}" \
  --name dune-postgres \
  --network dune-net \
  --restart unless-stopped \
  -p "127.0.0.1:${POSTGRES_PORT}:5432" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password \
  -e POSTGRES_DB=dune \
  -v dune-postgres-data:/var/lib/postgresql/data \
  -v "$(host_path "$PWD/runtime/postgres/initdb"):/docker-entrypoint-initdb.d:ro" \
  -v "$(host_path "$PWD/$postgres_superuser_password_render"):/run/secrets/postgres-password:ro" \
  "$IMAGE"

rm -f "$postgres_superuser_password_render"

echo "Waiting for Postgres..."
ready=0
for i in $(seq 1 60); do
  if docker exec dune-postgres pg_isready -h 127.0.0.1 -p 5432 -U postgres -d dune >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done

if [ "$ready" != "1" ]; then
  echo "Postgres did not become ready in time."
  echo
  echo "=== Postgres logs ==="
  docker logs --tail 200 dune-postgres || true
  exit 1
fi

docker exec dune-postgres pg_isready -h 127.0.0.1 -p 5432 -U postgres -d dune

echo
echo "=== Normalizing dune schema ownership and privileges ==="
docker exec -i dune-postgres psql -h 127.0.0.1 -p 5432 -U postgres -d dune <<'SQL'
ALTER DATABASE dune OWNER TO dune;
ALTER SCHEMA dune OWNER TO dune;
GRANT ALL PRIVILEGES ON DATABASE dune TO dune;
GRANT USAGE, CREATE ON SCHEMA dune TO dune;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA dune TO dune;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA dune TO dune;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA dune TO dune;
ALTER DEFAULT PRIVILEGES IN SCHEMA dune GRANT ALL PRIVILEGES ON TABLES TO dune;
ALTER DEFAULT PRIVILEGES IN SCHEMA dune GRANT ALL PRIVILEGES ON SEQUENCES TO dune;
ALTER DEFAULT PRIVILEGES IN SCHEMA dune GRANT ALL PRIVILEGES ON FUNCTIONS TO dune;

DO
$$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ext') THEN
    GRANT USAGE ON SCHEMA ext TO dune;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ext TO dune;
    ALTER DEFAULT PRIVILEGES IN SCHEMA ext GRANT EXECUTE ON FUNCTIONS TO dune;
  END IF;
END
$$;

DO
$$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT quote_ident(n.nspname) AS schema_name,
           quote_ident(c.relname) AS object_name,
           c.relkind AS relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'dune'
      AND c.relkind IN ('r','p','S','v','m','f')
      AND pg_get_userbyid(c.relowner) <> 'dune'
  LOOP
    EXECUTE format(
      'ALTER %s %s.%s OWNER TO dune',
      CASE obj.relkind
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE'
        ELSE 'TABLE'
      END,
      obj.schema_name,
      obj.object_name
    );
  END LOOP;
END
$$;
SQL

echo
echo "=== Databases ==="
docker exec dune-postgres psql -h 127.0.0.1 -p 5432 -U postgres -d dune -c '\l'

echo
echo "=== Roles ==="
docker exec dune-postgres psql -h 127.0.0.1 -p 5432 -U postgres -d dune -c '\du'

echo
echo "=== Container ==="
docker ps --filter "name=dune-postgres" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
