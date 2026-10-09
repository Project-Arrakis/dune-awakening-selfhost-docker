#!/usr/bin/env bash
set -euo pipefail

# Regression coverage for dune-awakening-selfhost-docker#1118: reload_console()
# in runtime/scripts/console.sh recreates the Console container, so it must hand
# the hosted-bot wizard's Discord OAuth client secret to the new container the
# way restart_console() does. Reached from POST /api/console/reload and the
# Settings restore wizard through a detached helper that cannot read the age
# identity, where the resolver fails closed.
#
# console.sh is not run as a whole (it persists compose project state and talks
# to Docker). The two functions are extracted and run against a stubbed `docker`
# and a stubbed resolver library in a throwaway directory. The real resolver is
# covered by test-secrets-stage3.sh.

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
console_sh="${CONSOLE_SH_UNDER_TEST:-$repo_root/runtime/scripts/console.sh}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fn_file="$test_root/functions.sh"
for fn in running_console_env_value reload_console; do
  sed -n "/^${fn}() {/,/^}/p" "$console_sh" >>"$fn_file"
  grep -q "^${fn}() {" "$fn_file" || fail "could not extract ${fn}() from console.sh"
done

secret_with_equals='s3cr3t=value==with-equals'

# run_reload <resolver-mode> <running-console-secret-or-empty>
# resolver-mode: fail (helper container: fails closed), value:<v> (host: resolves <v>), none (never configured)
run_reload() {
  local mode="$1" running="$2"
  local work="$test_root/work-$RANDOM"
  mkdir -p "$work/bin" "$work/runtime/scripts/lib"
  : >"$work/compose-secret-seen"
  : >"$work/compose-called"

  # The REAL resolver library, with only the two lowest-level secret reads stubbed. An earlier version
  # replaced the whole export function with a stub that did an explicit `return 1`, which the real
  # function never does (it swallows a failed resolver under `||`), so the test passed while the
  # warnings could never print.
  cp "$repo_root/runtime/scripts/lib/console-secrets-env.sh" "$work/runtime/scripts/lib/console-secrets-env.sh"
  : >"$work/runtime/scripts/lib/secrets.sh"  # sourced by the real library; its leaf functions are stubbed below
  case "$mode" in
    fail)  # migrated but unreadable (the detached helper cannot read the age identity)
      read_stub='dune_secrets_read_secret() { echo "dune secrets: refusing plaintext fallback" >&2; return 1; }
dune_secrets_has_migration_artifacts() { return 0; }'
      ;;
    value:*)  # the host can read it
      read_stub="dune_secrets_read_secret() { printf '%s' $(printf '%q' "${mode#value:}"); }
dune_secrets_has_migration_artifacts() { return 0; }"
      ;;
    none)  # never configured: nothing to read and no migration history
      read_stub='dune_secrets_read_secret() { return 1; }
dune_secrets_has_migration_artifacts() { return 1; }'
      ;;
  esac

  # Stub docker: `inspect` prints the running container's env but, like the real
  # thing, answers nothing once `docker rm` has removed the container (so a
  # reload that removes the container BEFORE reading the secret loses it);
  # `compose ... up` records what the secret looked like in ITS environment.
  cat >"$work/bin/docker" <<EOF
#!/usr/bin/env bash
case "\$1" in
  inspect)
    [ -e "$work/rm-called" ] && exit 1
    echo "PATH=/usr/bin"
    if [ -n "$running" ]; then echo "DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET=$running"; fi
    echo "OTHER=x"
    ;;
  rm)
    : >"$work/rm-called"
    ;;
  compose)
    for a in "\$@"; do [ "\$a" = up ] && echo called >>"$work/compose-called"; done
    echo "\${DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET-<unset>}" >>"$work/compose-secret-seen"
    ;;
esac
exit 0
EOF
  chmod +x "$work/bin/docker"

  # A separate bash process with the same `set -euo pipefail` console.sh runs
  # under. (A subshell on the left of `||` would silently disable errexit and
  # hide exactly the abort this test exists to catch.)
  cat >"$work/run.sh" <<EOF2
set -euo pipefail
cd "$work"
export PATH="$work/bin:\$PATH"
unset DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET
WEB_SERVICE="redblink-dune-docker-console"
WEB_COMPOSE="docker-compose.web.yml"
PROJECT_NAME="p"
MAIN_PROJECT_NAME="m"
HOST_ROOT="$work"
require_compose() { :; }
prepare_docker_socket_gid() { :; }
prepare_host_user_ids() { :; }
print_url() { :; }
$read_stub
. "$fn_file"
reload_console
EOF2
  bash "$work/run.sh" >"$work/out" 2>&1 || { cat "$work/out" >&2; fail "reload_console aborted (mode=$mode)"; }

  last_dir="$work"
}

# --- Test 1: helper container -- resolver fails closed, secret comes from the running Console
run_reload fail "$secret_with_equals"
[ -s "$last_dir/compose-called" ] || fail "Test 1: the Console was never recreated"
seen="$(cat "$last_dir/compose-secret-seen")"
[ "$seen" = "$secret_with_equals" ] || fail "Test 1: recreated Console did not receive the running secret intact (got '$seen')"
if grep -qF "$secret_with_equals" "$last_dir/out"; then fail "Test 1: the secret was printed (Requirement 24)"; fi
grep -q "could not be read from the secrets store; reusing the value from the running Console" "$last_dir/out" \
  || fail "Test 1: reusing the running Console's secret was silent (a rotated secret would be revived unannounced)"
echo "PASS: Test 1 (resolver fails closed, secret forwarded from the running Console, value with '=' intact, not printed, fallback announced)"

# --- Test 2: host run -- the resolved secret wins over a stale running value
run_reload "value:resolved-on-host" "stale-running-value"
seen="$(cat "$last_dir/compose-secret-seen")"
[ "$seen" = "resolved-on-host" ] || fail "Test 2: expected the host-resolved secret, got '$seen'"
if grep -q "^Warning:" "$last_dir/out"; then fail "Test 2: warned although the secret resolved normally"; fi
echo "PASS: Test 2 (host-resolved secret wins over the running container's value, no warning)"

# --- Test 3: never configured anywhere -- nothing exported, reload still happens
run_reload none ""
[ -s "$last_dir/compose-called" ] || fail "Test 3: the Console was never recreated"
seen="$(cat "$last_dir/compose-secret-seen")"
[ "$seen" = "<unset>" ] || fail "Test 3: a secret was exported for a never-configured install (got '$seen')"
if grep -q "^Warning:" "$last_dir/out"; then fail "Test 3: warned on an install that never configured hosted-bot OAuth (noise on every reload)"; fi
echo "PASS: Test 3 (never configured: nothing exported, reload completes, stays silent)"

# --- Test 4: resolver fails closed AND the running Console has none -- reload must still complete
run_reload fail ""
[ -s "$last_dir/compose-called" ] || fail "Test 4: a failed resolver aborted the reload before recreating the Console"
seen="$(cat "$last_dir/compose-secret-seen")"
[ "$seen" = "<unset>" ] || fail "Test 4: unexpected secret '$seen'"
grep -q "the recreated Console will start without it" "$last_dir/out" \
  || fail "Test 4: an unresolvable secret with nothing to forward was silent (hosted-bot OAuth would stop unannounced)"
echo "PASS: Test 4 (resolver failure never aborts the reload, and the loss is announced)"

echo "All console reload OAuth-secret tests passed."
