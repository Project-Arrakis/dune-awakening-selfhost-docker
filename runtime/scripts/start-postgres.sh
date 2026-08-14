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
# This whole block (KEK read/generate, render, docker run, cleanup) is
# wrapped in a dedicated flock so two overlapping invocations of this
# script (e.g. two concurrent `dune restart` calls, a real scenario
# this workstream's own operating docs explicitly warn about) cannot
# race on the single shared render-file path below -- confirmed via a
# Requirement 20 Layer 2 audit that reproduced exactly this race
# (instance A's docker run binding instance B's password, or A's
# cleanup deleting the file out from under B) with no lock in place.
postgres_lock_file="runtime/generated/.pg-superuser-password.lock"
mkdir -p runtime/generated

(
  flock -x 9

  postgres_superuser_password_render="runtime/generated/.pg-superuser-password-runtime"
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
    #
    # Requirement 20 Layer 3 audit fix (DBA finding): a bare
    # `2>/dev/null` here previously suppressed EVERY diagnostic from
    # dune_secrets_read_encrypted, not just the legitimate "no .enc
    # file yet" case -- including "wrong KEK", "corrupted .enc file",
    # and "not a recognized enc:v2: payload", all of which indicate a
    # real misconfiguration, not a first run. Left unaddressed, any of
    # those real errors would silently regenerate-and-overwrite the
    # encrypted store with a brand-new random password with zero
    # operator-visible signal -- directly contradicting this same
    # file's own fail-loud discipline everywhere else (see the FATAL
    # block below). Distinguish the two cases explicitly: only treat
    # "the .enc file does not exist yet" as the legitimate
    # first-run/generate path; any other failure is a real error and
    # must be surfaced, not silently swallowed.
    postgres_superuser_password_enc_path="$(dune_secrets_encrypted_path "postgres-superuser-password")"
    if [ ! -e "$postgres_superuser_password_enc_path" ]; then
      postgres_superuser_password="$(dune_secrets_generate_dek)"
      dune_secrets_write_secret "postgres-superuser-password" "$postgres_superuser_password"
    elif ! postgres_superuser_password="$(dune_secrets_read_encrypted "postgres-superuser-password")"; then
      echo "FATAL: $postgres_superuser_password_enc_path exists but could not be" >&2
      echo "decrypted (wrong DUNE_AGE_IDENTITY_FILE/DUNE_KEK_FILE, or the file" >&2
      echo "is corrupted). Refusing to silently generate a replacement" >&2
      echo "password, which would discard whatever is actually stored." >&2
      exit 1
    fi
  else
    postgres_superuser_password="postgres"
  fi

  # Render to a 0600, non-git-tracked file for the sole purpose of the
  # bind-mount below -- never the same file as the age-encrypted form
  # (runtime/secrets/postgres-superuser-password.enc).
  #
  # CRITICAL, corrected after a real production incident (issue #258):
  # this file is intentionally NOT deleted once the container starts,
  # and there is deliberately no `trap ... EXIT` here anymore. An
  # earlier version of this script did delete it immediately after
  # `docker run` (via an EXIT trap, itself added to fix an earlier,
  # narrower problem -- an orphaned file if `docker run` failed) --
  # that broke `docker cp`/the Docker archive API for the ENTIRE
  # container, not just this file, confirmed live on a production
  # server: deleting a bind-mounted regular file's host-side source
  # while the mount is still active leaves the file unlinked
  # (`stat` inside the container showed `Links: 0`) but still resolvable
  # through the mount, and that unlinked-but-mounted state corrupts
  # Docker's own tar/archive-walking logic (`mkdirat run/secrets/...:
  # file exists`) for every subsequent `docker cp`/backup attempt
  # against that container, for as long as it keeps running.
  #
  # Corrected lifecycle: any STALE render file from a previous run is
  # removed at the TOP of this block (see rm -f above the write below),
  # before a fresh one is written -- never after `docker run` starts a
  # new container that might still reference it. This is safe by
  # construction: `docker rm -f dune-postgres` (earlier in this script,
  # before this locked block even begins) has already removed any
  # container that could have this file bind-mounted, so no live mount
  # can exist at the point this stale-file cleanup runs. The file does
  # persist on disk between the moment a container starts and the next
  # `start-postgres.sh` invocation -- this is an accepted, bounded
  # tradeoff (mode 0600, never git-tracked, contents are the Postgres
  # superuser password which is itself rotatable) in exchange for never
  # breaking the container's own backup path again.
  #
  # The actual security boundary is the rendered file's own 0600 mode,
  # not runtime/generated/'s containing-directory mode (which may
  # already be looser, e.g. 0755, for unrelated reasons on some hosts).
  #
  # dune_secrets_render_plaintext_file (secrets.sh) is used here rather
  # than a plain `rm -f && printf && chmod` sequence specifically
  # because it defends against a real, reproduced production incident
  # (issue #259): a stray non-file (e.g. a directory Docker itself left
  # behind at this exact path under an earlier failure condition --
  # issue #258) makes a naive `rm -f` exit non-zero, which aborts this
  # script under `set -euo pipefail` BEFORE `docker run` ever executes
  # -- confirmed live, this left dune-postgres down. See secrets.sh's
  # own docstring for the self-healing behavior and why it lives there,
  # not duplicated inline in every script that renders a short-lived
  # bind-mount file like this one.
  dune_secrets_render_plaintext_file "$postgres_superuser_password_render" "$postgres_superuser_password" 600

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

  echo "Waiting for Postgres..."
  ready=0
  # shellcheck disable=SC2034  # loop counter only used to bound retries, not read -- pre-existing, predates this PR
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

  # Issue #260 fix: POSTGRES_PASSWORD_FILE is only applied by Postgres's
  # own docker-entrypoint.sh during first-time initdb. On an existing
  # data directory -- the real upgrade path: an operator turning the
  # age backend on for a host that already has a live cluster -- the
  # file's value is silently ignored by Postgres and the actual live
  # superuser password remains whatever it was at original initdb time.
  # Left unaddressed, this means the encrypted secrets store can end up
  # holding a password that does NOT match what Postgres will actually
  # accept, with no error surfaced at the point the bad value is
  # written. Confirmed via a real reproduction against a pre-existing
  # data directory (see issue #260 for the full repro, including the
  # pg_hba.conf `trust`-for-local false-pass trap hit during
  # verification -- do not "verify" this fix via `docker exec`/
  # 127.0.0.1, since password auth is not actually enforced on that
  # path; verify over the real dune-net network instead).
  #
  # Fix: explicitly force the live superuser password to match
  # $postgres_superuser_password via dune_secrets_sync_postgres_password
  # (secrets.sh), which runs `ALTER USER ... WITH PASSWORD ...` over the
  # local connection pg_hba.conf grants `trust` to regardless of which
  # password is currently set (confirmed during the #260 reproduction).
  # This runs on every startup when the age backend is configured, not
  # only "first time" -- so the live password and the encrypted store
  # can never silently diverge, whether this is a fresh install, an
  # upgrade of an existing install, or a manual secret rotation.
  #
  # If this fails, the script must NOT report success: the encrypted
  # store may now hold a value that doesn't match the live database,
  # which is exactly the silent-failure mode issue #260 exists to
  # prevent. Fail loudly instead of continuing.
  if dune_secrets_backend_configured; then
    if ! dune_secrets_sync_postgres_password "dune-postgres" "postgres" "$postgres_superuser_password"; then
      echo "FATAL: could not set the Postgres superuser password." >&2
      echo >&2
      echo "The dune-postgres container is running, but its password may" >&2
      echo "not match what is stored in your encrypted secrets. Do NOT" >&2
      echo "assume the server is working correctly." >&2
      echo >&2
      echo "What to do next:" >&2
      echo "  1. Run this command again -- if the failure was transient," >&2
      echo "     re-running will usually fix it." >&2
      echo "  2. If it keeps failing, check 'docker logs dune-postgres'" >&2
      echo "     for the underlying database error." >&2
      echo "  3. Back up your data (dune db backup) before troubleshooting" >&2
      echo "     further." >&2
      echo "  4. If you need help, reference issue #260 in this project's" >&2
      echo "     GitHub repository." >&2
      exit 1
    fi
  fi
) 9>"$postgres_lock_file"

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
