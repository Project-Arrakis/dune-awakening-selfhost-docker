#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || { echo "SKIP: git not available"; exit 0; }

test_root="$(mktemp -d)"
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"

# Fake `docker`: apply-discord-adapter-env's dispatch path only needs `docker
# ps` (the access check), `docker rm -f` and `docker compose ... up -d
# --force-recreate` to succeed. Passing the service name explicitly as the
# command's second argument (below) means web_console_service_name() -- which
# would otherwise shell out to `docker compose ... config --services` -- is
# never invoked, so this fake does not need to emulate that too.
cat > "$fake_bin/docker" <<'SH'
#!/bin/sh
case "$1" in
  ps) exit 0 ;;
  rm) exit 0 ;;
  compose) exit 0 ;;
  *) exit 1 ;;
esac
SH
chmod +x "$fake_bin/docker"

# Fake `curl`: succeeds immediately so the health-check retry loop only needs
# one iteration -- keeps this test fast without also needing to fake `sleep`.
cat > "$fake_bin/curl" <<'SH'
#!/bin/sh
exit 0
SH
chmod +x "$fake_bin/curl"

# Exercise a real, isolated checkout of the current tree (same technique
# tests/release-gate-test.sh already uses for full end-to-end runs) rather
# than the real working directory, since self-update.sh resolves its own
# repo root from its own script path and writes real files (.env,
# runtime/generated/...) relative to it.
fresh_root="$test_root/fresh"
mkdir -p "$fresh_root"
git archive --format=tar HEAD | tar -x -C "$fresh_root"

# --- Bug reproduction: a manual/CLI invocation of apply-discord-adapter-env
# with no DUNE_SELF_UPDATE_RUN_ID set (self_update_status_enabled() is false)
# must not crash. verify_discord_adapter_health()'s discord_health_ok append
# used to run unconditionally after the guarded, no-op self_update_write_status
# call, so with status tracking disabled the target directory was never
# created and the append failed under `set -euo pipefail`, taking down the
# whole script even though the container recreate and health check had both
# already succeeded. ---
if ! env -u DUNE_SELF_UPDATE_RUN_ID \
  PATH="$fake_bin:$PATH" \
  DUNE_COMPOSE_PROJECT_NAME=test-discord-adapter-guard \
  "$fresh_root/runtime/scripts/self-update.sh" apply-discord-adapter-env redblink-dune-docker-console \
  >"$test_root/no-run-id.out" 2>"$test_root/no-run-id.err"
then
  cat "$test_root/no-run-id.err" >&2
  fail "apply-discord-adapter-env crashed with no DUNE_SELF_UPDATE_RUN_ID set -- the discord_health_ok status append must be guarded by self_update_status_enabled() like every other status write in this file"
fi
[ ! -e "$fresh_root/runtime/generated/self-update-status" ] \
  || fail "a status directory was created even though status tracking was not enabled for this run"

# --- Regression check: with a valid DUNE_SELF_UPDATE_RUN_ID set (status
# tracking enabled), discord_health_ok must still actually be recorded. ---
run_id="11111111-1111-4111-8111-111111111111"
if ! env PATH="$fake_bin:$PATH" \
  DUNE_COMPOSE_PROJECT_NAME=test-discord-adapter-guard \
  DUNE_SELF_UPDATE_RUN_ID="$run_id" \
  "$fresh_root/runtime/scripts/self-update.sh" apply-discord-adapter-env redblink-dune-docker-console \
  >"$test_root/with-run-id.out" 2>"$test_root/with-run-id.err"
then
  cat "$test_root/with-run-id.err" >&2
  fail "apply-discord-adapter-env failed with a valid DUNE_SELF_UPDATE_RUN_ID set"
fi
status_file="$fresh_root/runtime/generated/self-update-status/$run_id.env"
[ -f "$status_file" ] || fail "expected status file was not created: $status_file"
grep -qx 'discord_health_ok=1' "$status_file" \
  || fail "discord_health_ok was not recorded in the status file when status tracking was enabled"

echo "OK: apply-discord-adapter-env does not crash when status tracking is disabled, and still records discord_health_ok when it is enabled"
