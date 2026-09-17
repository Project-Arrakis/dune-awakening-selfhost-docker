#!/usr/bin/env bash
# shellcheck disable=SC1090,SC2016,SC2034,SC2317
# Regression coverage for periodic Sietch state publication. RabbitMQ route
# maintenance must not block Survival state long enough for Director to mark
# otherwise-ready Sietches offline.
set -euo pipefail

cd "$(dirname "$0")/../.."

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  grep -Fq -- "$pattern" "$file" || fail "$file missing: $pattern"
}

SCRIPT="runtime/scripts/publish-sietch-overrides.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Valid cached credentials remain in use until RabbitMQ rejects them. Refreshing
# them solely because they are five minutes old caused the observed cadence.
assert_contains "$SCRIPT" 'if [ -r "$RMQ_CREDS_FILE" ]; then'
assert_contains "$SCRIPT" 'rm -f "$RMQ_CREDS_FILE"'
if grep -Fq 'RMQ_CREDS_TTL_SECONDS' "$SCRIPT"; then
  fail "$SCRIPT must retain valid cached RabbitMQ credentials until a command rejects them"
fi

CACHED_CREDS="$TMP_DIR/cached-rmq-creds"
printf '%s\n' "cached-user" "cached-password" >"$CACHED_CREDS"
touch -d '2 hours ago' "$CACHED_CREDS"

CREDENTIAL_RESULT="$(
  source "$SCRIPT"
  RMQ_CREDS_FILE="$CACHED_CREDS"
  ensure_text_router_log() {
    fail "valid cached credentials unexpectedly triggered a log scan"
  }
  load_rmq_admin_creds
)"

[ "$CREDENTIAL_RESULT" = $'cached-user\ncached-password' ] \
  || fail "expected valid cached credentials to remain usable regardless of age"

# Routine route verification fails at its first RabbitMQ error and never purges
# the active source queue. A purge is allowed only during initial setup.
assert_contains "$SCRIPT" 'local purge_existing="${1:-false}"'
assert_contains "$SCRIPT" 'if [ "$purge_existing" = "true" ]; then'
assert_contains "$SCRIPT" 'rmq_admin purge queue name="$SOURCE_FILTER_QUEUE" >/dev/null || return 1'
assert_contains "$SCRIPT" 'ensure_route true'
assert_contains "$SCRIPT" 'ensure_route false >>"$LOG_FILE" 2>&1 || true'
assert_contains "$SCRIPT" 'route_refresh_at=$(( $(date +%s) + ROUTE_REFRESH_SECONDS ))'

if grep -Fq 'rmq_admin purge queue name="$SOURCE_FILTER_QUEUE" >/dev/null || true' "$SCRIPT"; then
  fail "$SCRIPT must not ignore a failed initialization purge"
fi

ROUTE_RESULT="$(
  source "$SCRIPT"
  route_calls=""
  rmq_admin() {
    route_calls="${route_calls}|$*"
    [ "$1 $2" != "declare queue" ]
  }
  rmq_delete_binding_exact() {
    route_calls="${route_calls}|delete $*"
  }
  if ensure_route false; then
    fail "failed route declaration unexpectedly succeeded"
  fi
  printf '%s\n' "$route_calls"
)"

case "$ROUTE_RESULT" in
  *"declare exchange"*"declare queue"*) ;;
  *) fail "route verification did not reach the simulated queue failure" ;;
esac
case "$ROUTE_RESULT" in
  *"declare binding"*|*"purge queue"*|*"|delete "*)
    fail "route verification continued after its first failure: $ROUTE_RESULT"
    ;;
esac

# A failed quiet rabbitmqadmin call returns an empty response. It must leave the
# batch loop quietly rather than feeding invalid data to the JSON transformer.
assert_contains "$SCRIPT" 'if ! messages="$(rmq_admin --format=raw_json get queue="$SOURCE_FILTER_QUEUE" count=20 ackmode=ack_requeue_false)"; then'
assert_contains "$SCRIPT" '[ -n "$messages" ] && [ "$messages" != "[]" ] || return 1'

EMPTY_READ_RESULT="$(
  source "$SCRIPT"
  rmq_admin() {
    return 1
  }
  if forward_batch_once 2>&1; then
    fail "failed RabbitMQ read unexpectedly produced a batch"
  fi
)"

[ -z "$EMPTY_READ_RESULT" ] \
  || fail "failed RabbitMQ read emitted output instead of returning quietly: $EMPTY_READ_RESULT"

echo "PASS: Sietch state publication remains responsive during RabbitMQ maintenance failures"
