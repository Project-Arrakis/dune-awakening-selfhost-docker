#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || { echo "SKIP: docker not found on PATH"; exit 0; }
command -v age >/dev/null 2>&1 || { echo "SKIP: age not found on PATH"; exit 0; }
command -v age-keygen >/dev/null 2>&1 || { echo "SKIP: age-keygen not found on PATH"; exit 0; }
python3 -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM" >/dev/null 2>&1 || {
  echo "SKIP: python3's 'cryptography' package not installed"
  exit 0
}
docker info >/dev/null 2>&1 || { echo "SKIP: docker daemon not reachable"; exit 0; }

# Regression coverage for the Postgres age-secrets upgrade path:
# reproduces the exact real-world upgrade path (an operator turning
# the age secrets backend on for a host that already has an existing,
# initialized Postgres data directory) against a real, disposable
# Postgres container and a real Docker network -- never against this
# repo's own live dune-postgres container or dune-net network.
# Everything here uses a dedicated, uniquely-named test
# network/container/volume and is torn down on exit regardless of
# outcome.

test_root="$(mktemp -d)"
test_container="dune-postgres-upgrade-test-$$"
test_network="dune-net-upgrade-test-$$"
test_volume="dune-postgres-data-upgrade-test-$$"
legacy_password="legacy-preexisting-password"

cleanup() {
  docker rm -f "$test_container" >/dev/null 2>&1 || true
  docker network rm "$test_network" >/dev/null 2>&1 || true
  docker volume rm "$test_volume" >/dev/null 2>&1 || true
  rm -rf "$test_root"
}
trap cleanup EXIT

docker network create "$test_network" >/dev/null

# --- Step 1: simulate a pre-existing install ---
# Start a real Postgres container the "legacy" way (plain
# POSTGRES_PASSWORD, no age backend involved at all) and let it
# initialize a real data directory, exactly like any install that
# predates this feature.
docker run -d \
  --name "$test_container" \
  --network "$test_network" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD="$legacy_password" \
  -e POSTGRES_DB=dune \
  -v "$test_volume":/var/lib/postgresql/data \
  postgres:17 >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "$test_container" pg_isready -h 127.0.0.1 -p 5432 -U postgres -d dune >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "test fixture Postgres container did not become ready in time"

# Confirm the data directory is genuinely initialized (not empty), so
# this test is a true "existing install" scenario, not a fresh one.
docker exec "$test_container" test -f /var/lib/postgresql/data/PG_VERSION \
  || fail "expected PG_VERSION to exist in the test fixture's data directory"

# --- Sanity check: confirm the pg_hba.conf `trust`-for-local false-pass
# trap (a real mistake made while developing this test) is actually
# present in this image, so this test's later network-based
# checks are not accidentally redundant with a meaningless localhost
# check. If a future base image changes this, the assertion below
# should fail loudly rather than let the rest of the test silently mean
# less than it claims to. ---
if ! docker exec -e PGPASSWORD="definitely-wrong-password" "$test_container" \
  psql -h 127.0.0.1 -U postgres -c "SELECT 1;" >/dev/null 2>&1; then
  fail "expected local trust auth to accept a wrong password (this test's network-based verification below assumes this pg_hba.conf behavior -- if the base image changed, this test needs revisiting, not silently passing for the wrong reason)"
fi

# --- Step 2: enable the age secrets backend for the first time,
# against this EXISTING data directory (the actual upgrade path). ---
identity_path="$test_root/age-identity.txt"
kek_path="$test_root/kek.age"
age-keygen -o "$identity_path" >/dev/null 2>&1
public_key="$(age-keygen -y "$identity_path")"

# shellcheck disable=SC1091
source runtime/scripts/lib/secrets.sh

kek_hex="$(dune_secrets_generate_dek)"
printf '%s' "$kek_hex" | age --encrypt -r "$public_key" -o "$kek_path"

cd "$test_root"
export DUNE_KEK_FILE="$kek_path"
export DUNE_AGE_IDENTITY_FILE="$identity_path"

dune_secrets_backend_configured || fail "expected backend_configured to be true with both env vars set"

# Generate-and-persist a brand-new password exactly as
# start-postgres.sh's age-backend branch does on first run.
new_password="$(dune_secrets_generate_dek)"
dune_secrets_write_secret "postgres-superuser-password" "$new_password"

# --- Step 3: without dune_secrets_sync_postgres_password,
# POSTGRES_PASSWORD_FILE would be silently ignored by Postgres's
# entrypoint on this existing data directory -- ONLY this function
# makes the live database actually match $new_password. Call it here
# exactly as start-postgres.sh's code path does. ---
dune_secrets_sync_postgres_password "$test_container" "postgres" "$new_password" \
  || fail "dune_secrets_sync_postgres_password reported failure -- expected success"

# --- Step 4: verify over a REAL NETWORK CLIENT, not docker exec/
# localhost (which would give a false pass per the sanity check above).
# This is the actual upgrade-path regression check. ---
if ! docker run --rm --network "$test_network" -e PGPASSWORD="$new_password" postgres:17 \
  psql -h "$test_container" -U postgres -c "SELECT 1;" >/dev/null 2>&1; then
  fail "expected the NEW password to authenticate over the real network after dune_secrets_sync_postgres_password -- this is the exact upgrade-path regression this test exists to catch"
fi

# Also confirm the OLD (pre-upgrade) password no longer works over the
# network, proving the sync genuinely took effect rather than both
# passwords coincidentally working.
if docker run --rm --network "$test_network" -e PGPASSWORD="$legacy_password" postgres:17 \
  psql -h "$test_container" -U postgres -c "SELECT 1;" >/dev/null 2>&1; then
  fail "expected the OLD legacy password to no longer authenticate after the password sync, but it still did"
fi

# --- Step 5: confirm the failure path is real, not silently swallowed
# -- dune_secrets_sync_postgres_password must return non-zero against a
# container that doesn't exist / can't be reached. ---
if dune_secrets_sync_postgres_password "does-not-exist-$$" "postgres" "irrelevant" 2>/dev/null; then
  fail "expected dune_secrets_sync_postgres_password to fail against a nonexistent container, but it reported success"
fi

# --- Step 6: regression coverage guarding against
# dune_secrets_sync_postgres_password ever passing the password via
# `psql -c "ALTER USER ... '...'"`, which would put the plaintext
# password directly into that psql process's own argv -- visible via
# /proc/<pid>/cmdline (both on the host, for the `docker exec` client
# process, and from inside the container, for the actual psql process)
# for the process's entire lifetime. This is the exact
# GHSA-fc89-h24v-6j3x exposure class this whole feature exists to
# eliminate.
#
# A real ALTER USER completes in well under 200ms (measured), which
# makes polling /proc while the process is still alive too racy to
# trust as a regression test -- a fix that reintroduces the bug could
# still slip past a slow poller purely by timing luck. Instead, this
# uses `strace -f -e trace=execve` to deterministically capture the
# EXACT argv every child process is launched with, at the moment of
# `execve(2)` itself -- no race, no timing dependency. If the password
# ever appears in any traced execve's argument list, this is a real,
# unambiguous regression. ---
command -v strace >/dev/null 2>&1 || { echo "SKIP: strace not found on PATH -- cannot run the argv-exposure regression check"; exit 0; }

probe_password="ARGV_EXPOSURE_PROBE_$$_$(date +%s)"
strace_log="$test_root/argv-exposure-strace.log"

# The probe password is passed to the wrapper via an exported
# environment variable, not a positional argv element -- if it were
# passed as a `bash -c` argv element instead, THAT wrapper's own
# execve (which strace -f also captures, since it's the traced parent
# process) would falsely match the grep below, even though it has
# nothing to do with dune_secrets_sync_postgres_password's own
# behavior. Using an env var keeps the harness itself out of the
# result the grep below is checking.
# shellcheck disable=SC2016  # single quotes in the bash -c string below are intentional: $1/$2/$3/$DUNE_TEST_PROBE_PASSWORD must expand inside the nested bash -c, not in this outer shell.
DUNE_TEST_PROBE_PASSWORD="$probe_password" \
  strace -f -e trace=execve -s 4096 -o "$strace_log" -- \
  bash -c 'source "$1/runtime/scripts/lib/secrets.sh"; dune_secrets_sync_postgres_password "$2" "$3" "$DUNE_TEST_PROBE_PASSWORD"' \
  _ "$repo_root" "$test_container" "postgres" \
  || fail "dune_secrets_sync_postgres_password failed under strace -- cannot complete the argv-exposure regression check"

if grep -qF "$probe_password" "$strace_log"; then
  exposure_line="$(grep -F "$probe_password" "$strace_log" | head -1)"
  fail "CRITICAL: found the plaintext password in a real execve(2) argv list while dune_secrets_sync_postgres_password was running -- this is a GHSA-fc89-h24v-6j3x-class argv-exposure regression. The password must be piped to psql via stdin, never passed via -c. Offending execve: $exposure_line"
fi

# Restore the container's password back to the known value used by the
# rest of this test, since step 6 above changed it to $probe_password.
dune_secrets_sync_postgres_password "$test_container" "postgres" "$new_password" \
  || fail "failed to restore the test container's password after the argv-exposure probe"

echo "All Postgres secrets upgrade-path tests passed."
