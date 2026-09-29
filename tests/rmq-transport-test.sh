#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

lib="runtime/scripts/lib/rabbitmq.sh"
bash -n "$lib"

# The management port has to actually be published, or the seam can only ever
# fall back. lib/ports.sh owns the default alongside its siblings.
grep -Fq -- '-p "127.0.0.1:${RMQ_ADMIN_HTTP_PORT}:15672/tcp"' runtime/scripts/start-rabbitmq.sh
grep -Fq 'RMQ_ADMIN_HTTP_PORT="$(resolve_rmq_admin_http_port)"' runtime/scripts/start-rabbitmq.sh
grep -Fq 'resolve_rmq_admin_http_port() { port_env_value RMQ_ADMIN_HTTP_PORT 32574; }' runtime/scripts/lib/ports.sh

# Both publishers must route through the seam rather than straight to the exec.
for publisher in publish-deepdesert-overrides.sh publish-sietch-overrides.sh; do
  grep -Fq 'source runtime/scripts/lib/rabbitmq.sh' "runtime/scripts/$publisher"
  grep -Fq 'dune_rmq_http_try "$rmq_user" "$rmq_password" "$@"' "runtime/scripts/$publisher"
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# A curl that records what it was asked to send and answers 200 with a canned
# body, so the assertions below are about the request the seam builds.
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
out=""; url=""; body=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --data-binary) body="$(cat "${2#@}")"; shift 2 ;;
    http://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
cat > "$CURL_STDIN_CAPTURE"
printf '%s\n' "$url" > "$CURL_URL_CAPTURE"
printf '%s\n' "$body" > "$CURL_BODY_CAPTURE"
[ -n "$out" ] && printf '%s' "${CURL_RESPONSE_BODY:-[]}" > "$out"
printf '%s' "${CURL_HTTP_CODE:-200}"
STUB
chmod +x "$work/bin/curl"
PATH="$work/bin:$PATH"

export CURL_STDIN_CAPTURE="$work/stdin" CURL_URL_CAPTURE="$work/url" CURL_BODY_CAPTURE="$work/body"

# shellcheck source=runtime/scripts/lib/rabbitmq.sh
source "$lib"

fail() { echo "FAIL: $1" >&2; exit 1; }

# --- publish ------------------------------------------------------------------
# A payload with a quote and a backslash: the body is built with json.dumps, so
# this must survive as data rather than breaking the JSON.
payload='{"partitionId":1,"label":"say \"hi\"\\"}'
dune_rmq_http_try user pass publish \
  exchange='dune.filter' \
  routing_key='server_state' \
  properties='{"content_type":"Content","type":"server_state"}' \
  payload="$payload" \
  || fail "publish returned $?"

grep -Fq '/api/exchanges/%2F/dune.filter/publish' "$work/url" \
  || fail "publish URL wrong: $(cat "$work/url")"

RMQ_EXPECT_PAYLOAD="$payload" python3 - "$work/body" <<'PY' || fail "publish body wrong"
import json, os, sys
body = json.load(open(sys.argv[1]))
assert body["routing_key"] == "server_state", body
assert body["payload_encoding"] == "string", body
assert body["payload"] == os.environ["RMQ_EXPECT_PAYLOAD"], body["payload"]
assert body["properties"] == {"content_type": "Content", "type": "server_state"}, body
PY

# Credentials must travel on stdin, never in argv where ps would show them.
grep -Fq 'user = "user:pass"' "$work/stdin" || fail "credentials not passed on stdin"

# --- get ----------------------------------------------------------------------
# raw_json is the response body verbatim, which is what the forwarder parses.
export CURL_RESPONSE_BODY='[{"payload":"{}"}]'
got="$(dune_rmq_http_try user pass --format=raw_json get \
  queue='dune.sietch.filter' count=20 ackmode=ack_requeue_false)" \
  || fail "get returned $?"
[ "$got" = '[{"payload":"{}"}]' ] || fail "get did not return the body verbatim: $got"

grep -Fq '/api/queues/%2F/dune.sietch.filter/get' "$work/url" \
  || fail "get URL wrong: $(cat "$work/url")"

python3 - "$work/body" <<'PY' || fail "get body wrong"
import json, sys
body = json.load(open(sys.argv[1]))
assert body["count"] == 20, body
assert body["ackmode"] == "ack_requeue_false", body
assert body["encoding"] == "auto", body
# A truncated payload would not survive the forwarder's json.loads.
assert "truncate" not in body, body
PY

# --- what the seam deliberately does not translate ----------------------------
expect_unsupported() {
  local label="$1"; shift
  local rc=0
  dune_rmq_http_try user pass "$@" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq "$RMQ_HTTP_UNSUPPORTED" ] \
    || fail "$label should have been unsupported (got $rc), so the caller cannot fall back"
}

# Route setup runs at most every ROUTE_REFRESH_SECONDS, so it stays on the exec.
# These are turned away by the argument loop, because each carries a key the seam
# does not translate (name=, source=, destination=).
expect_unsupported 'declare exchange' declare exchange name=dune.filter type=direct durable=true
expect_unsupported 'declare binding'  declare binding source=a destination=b destination_type=queue
expect_unsupported 'delete binding'   delete binding source=a destination=b
expect_unsupported 'purge queue'      purge queue name=dune.sietch.filter
# An argument the seam does not understand must never be silently dropped, even
# on a verb it does translate: publishing to the wrong vhost would look like
# success while the message went somewhere else.
expect_unsupported 'unknown argument' publish exchange=x payload=y vhost=/other

# These reach the verb switch itself, every argument having been understood, and
# it is the verb that has to turn them away. Without a case like this the
# switch's default branch is never exercised -- the argument loop rejects the
# route-setup calls above long before the verb is looked at.
expect_unsupported 'list, a verb with no fast leg' list queue=q
# get without raw_json would need rabbitmqadmin's own table rendering.
expect_unsupported 'get, table format' get queue=q count=1 ackmode=ack_requeue_false

# --- failure handling ---------------------------------------------------------
# An HTTP error is a real failure the caller retries with fresh credentials, not
# an unsupported verb -- returning 66 here would exec instead of re-reading them.
rc=0
CURL_HTTP_CODE="401" dune_rmq_http_try user pass publish exchange=x payload=y >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail "a 401 was treated as success"
[ "$rc" -ne "$RMQ_HTTP_UNSUPPORTED" ] || fail "a 401 was reported as unsupported instead of a failure"

# A refused connection is the deployment lacking the published port: the caller
# must be told to exec.
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
cat > /dev/null
exit 7
STUB
chmod +x "$work/bin/curl"
_dune_rmq_transport=""
rc=0
dune_rmq_http_try user pass publish exchange=x payload=y >/dev/null 2>&1 || rc=$?
[ "$rc" -eq "$RMQ_HTTP_UNSUPPORTED" ] \
  || fail "an unreachable management port must fall back to the exec (got $rc)"

# --- pinning ------------------------------------------------------------------
_dune_rmq_transport=""
rc=0
DUNE_RMQ_TRANSPORT="exec" dune_rmq_http_try user pass publish exchange=x payload=y >/dev/null 2>&1 || rc=$?
[ "$rc" -eq "$RMQ_HTTP_UNSUPPORTED" ] || fail "DUNE_RMQ_TRANSPORT=exec did not pin the exec leg"

_dune_rmq_transport=""
DUNE_RMQ_TRANSPORT="nonsense" dune_rmq_transport >/dev/null 2>&1 \
  && fail "an invalid DUNE_RMQ_TRANSPORT was accepted"

echo "rabbitmq seam translates publish and get to the management API and falls back for everything else"
