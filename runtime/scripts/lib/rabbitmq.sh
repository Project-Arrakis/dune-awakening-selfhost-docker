#!/usr/bin/env bash

# Two transports for the RabbitMQ management API, for the same reason
# lib/postgres.sh has two for Postgres.
#
# `rabbitmqadmin` is itself nothing but an HTTP client for that API, so running
# it through `docker exec dune-rmq-admin` buys no capability -- it only adds a
# container exec, and each of those leaves a conmon pair resident for the
# engine's --exit-delay. The publishers do this on their hot paths:
# publish-sietch-overrides.sh polls a queue every FORWARD_POLL_SECONDS whether
# or not there is anything to forward, and both publishers publish once per
# payload. Speaking to the same endpoints with curl removes the exec and changes
# nothing else -- same protocol, same API, same delivery semantics.
#
# Only the two hot verbs are translated. `declare`, `delete`, `purge` and `list`
# run every ROUTE_REFRESH_SECONDS at most, where one exec costs nothing, so they
# keep the exec path and this file returns RMQ_HTTP_UNSUPPORTED for them. The
# dividing line is how often a call runs, exactly as in lib/postgres.sh.
#
# DUNE_RMQ_TRANSPORT selects the behaviour: `auto` (default) tries HTTP and
# falls back permanently once it sees the port is not listening, `http` and
# `exec` pin one leg for tests and diagnostics.

# shellcheck source=runtime/scripts/lib/ports.sh
source "$(dirname "${BASH_SOURCE[0]}")/ports.sh"

# Distinct from any real failure: the verb is not one this seam translates, so
# the caller should run it through rabbitmqadmin. 66 is outside curl's range.
RMQ_HTTP_UNSUPPORTED=66

# Resolved lazily, not at source time: a caller may source this before it has
# read .env, and the resolution depends on RMQ_ADMIN_HTTP_PORT.
_dune_rmq_transport=""

dune_rmq_transport() {
  if [ -z "$_dune_rmq_transport" ]; then
    case "${DUNE_RMQ_TRANSPORT:-auto}" in
      http) _dune_rmq_transport="http" ;;
      exec) _dune_rmq_transport="exec" ;;
      auto)
        # `type -P` deliberately, not `command -v`: a shell function named curl
        # would satisfy the latter without there being a client to run.
        if type -P curl >/dev/null 2>&1; then
          _dune_rmq_transport="http"
        else
          _dune_rmq_transport="exec"
        fi
        ;;
      *)
        printf '%s\n' "Invalid DUNE_RMQ_TRANSPORT=${DUNE_RMQ_TRANSPORT}; expected auto, http or exec." >&2
        return 1
        ;;
    esac
  fi
  printf '%s' "$_dune_rmq_transport"
}

# A management API request. Success prints the response body.
#
# A failure to reach the port at all demotes the transport, because an
# unpublished management port is a property of the deployment rather than of the
# call. That demotion only sticks as far as the shell it happens in: the publish
# path calls this directly and keeps it, but forward_batch_once reads its result
# through a command substitution, so its subshell re-learns the same thing next
# tick. That is deliberate rather than papered over with a state file -- a
# refused local connection costs one curl and no exec, which is the whole point
# of the exercise, and an operator who wants even that gone can pin
# DUNE_RMQ_TRANSPORT=exec.
#
# An HTTP error is a plain failure instead, so the caller's retry can refresh
# credentials and try again.
_dune_rmq_http() {
  local user="$1" password="$2" path="$3" body="$4"
  local body_file code rc

  body_file="$(mktemp)" || return 1
  printf '%s' "$body" >"$body_file"

  local out_file
  out_file="$(mktemp)" || { rm -f "$body_file"; return 1; }

  # Credentials go in on stdin rather than argv, where `ps` would show them.
  code="$(printf 'user = "%s:%s"\n' "$user" "$password" | curl \
    --silent --show-error --config - \
    --max-time "${RMQ_HTTP_TIMEOUT_SECONDS:-${RMQ_TIMEOUT_SECONDS:-15}}" \
    --header 'content-type: application/json' \
    --data-binary "@$body_file" \
    --output "$out_file" \
    --write-out '%{http_code}' \
    "http://127.0.0.1:$(resolve_rmq_admin_http_port)${path}" 2>/dev/null)"
  rc=$?
  rm -f "$body_file"

  if [ "$rc" -ne 0 ]; then
    _dune_rmq_transport="exec"
    rm -f "$out_file"
    return "$RMQ_HTTP_UNSUPPORTED"
  fi

  case "$code" in
    2*) cat "$out_file"; rm -f "$out_file"; return 0 ;;
    *)  rm -f "$out_file"; return 1 ;;
  esac
}

# Translate one rabbitmqadmin invocation, in the argument shape the publishers
# already use. Anything this does not understand comes back as
# RMQ_HTTP_UNSUPPORTED so the caller can exec it unchanged.
dune_rmq_http_try() {
  local user="$1" password="$2"
  shift 2

  [ "$(dune_rmq_transport)" = http ] || return "$RMQ_HTTP_UNSUPPORTED"

  local verb="$1" raw_json=false
  if [ "$verb" = "--format=raw_json" ]; then
    raw_json=true
    shift
    verb="$1"
  fi
  shift || return "$RMQ_HTTP_UNSUPPORTED"

  local key value exchange="" routing_key="" properties="" payload=""
  local queue="" count="" ackmode=""
  for key in "$@"; do
    value="${key#*=}"
    case "${key%%=*}" in
      exchange)    exchange="$value" ;;
      routing_key) routing_key="$value" ;;
      properties)  properties="$value" ;;
      payload)     payload="$value" ;;
      queue)       queue="$value" ;;
      count)       count="$value" ;;
      ackmode)     ackmode="$value" ;;
      *)           return "$RMQ_HTTP_UNSUPPORTED" ;;
    esac
  done

  case "$verb" in
    publish)
      [ -n "$exchange" ] || return "$RMQ_HTTP_UNSUPPORTED"
      # payload_encoding=string matches what rabbitmqadmin sends for a payload
      # given on the command line. The routed flag in the response is ignored
      # here because the exec path ignored it too.
      _dune_rmq_http "$user" "$password" \
        "/api/exchanges/%2F/$(_dune_rmq_urlencode "$exchange")/publish" \
        "$(_dune_rmq_publish_body "$routing_key" "$properties" "$payload")" >/dev/null
      ;;
    get)
      [ -n "$queue" ] || return "$RMQ_HTTP_UNSUPPORTED"
      # Only the raw_json shape is translated: it is the response body verbatim,
      # which is what the caller parses. Any other --format is rabbitmqadmin's
      # own table rendering and is not worth reimplementing.
      [ "$raw_json" = true ] || return "$RMQ_HTTP_UNSUPPORTED"
      # truncate is deliberately omitted. rabbitmqadmin defaults it to 50000,
      # and a truncated payload does not survive the json.loads the forwarder
      # does with it -- so not sending it is both simpler and strictly safer.
      _dune_rmq_http "$user" "$password" \
        "/api/queues/%2F/$(_dune_rmq_urlencode "$queue")/get" \
        "$(_dune_rmq_get_body "${count:-1}" "${ackmode:-ack_requeue_true}")"
      ;;
    *)
      return "$RMQ_HTTP_UNSUPPORTED"
      ;;
  esac
}

_dune_rmq_urlencode() {
  RMQ_RAW="$1" python3 -c 'import os, urllib.parse; print(urllib.parse.quote(os.environ["RMQ_RAW"], safe=""), end="")'
}

# Bodies are built by python3 rather than string-pasted, so a quote or backslash
# in a payload cannot break out and produce invalid JSON.
_dune_rmq_publish_body() {
  RMQ_ROUTING_KEY="$1" RMQ_PROPERTIES="$2" RMQ_PAYLOAD="$3" python3 -c '
import json, os
properties = os.environ.get("RMQ_PROPERTIES") or "{}"
print(json.dumps({
    "properties": json.loads(properties),
    "routing_key": os.environ.get("RMQ_ROUTING_KEY", ""),
    "payload": os.environ.get("RMQ_PAYLOAD", ""),
    "payload_encoding": "string",
}), end="")'
}

_dune_rmq_get_body() {
  RMQ_COUNT="$1" RMQ_ACKMODE="$2" python3 -c '
import json, os
print(json.dumps({
    "count": int(os.environ["RMQ_COUNT"]),
    "ackmode": os.environ["RMQ_ACKMODE"],
    "encoding": "auto",
}), end="")'
}

# --- the game broker's connection list ------------------------------------

# ready.sh and status.sh answer "is a game server connected and running?" with
# `docker exec dune-rmq-game rabbitmqctl list_connections user state`. On a
# quiet Battlegroup that is the largest standing source of container execs in
# the stack: ready.sh runs it on the autoscaler's 30-second dynamic-ready heal
# scan and retries it once, and every exec leaves a conmon pair resident for the
# engine's exit delay. The management API answers the same question over the
# loopback port start-rabbitmq.sh already publishes for it.
#
# Unlike the admin verbs above, this one needs credentials -- rabbitmqctl
# authenticates with the Erlang cookie, the HTTP API does not -- and finding
# them must not itself cost an exec, or the trade is a wash. So the lookup is
# read-only: it parses the director log the publishers already keep current
# (publish-network-server-state-overrides.sh and publish-sietch-overrides.sh
# both refresh it on their loops) and never runs ensure_text_router_log or
# `docker logs` to produce one. Where that log is absent or stale this returns
# RMQ_HTTP_UNSUPPORTED and the caller runs the exec it ran before, which is also
# what happens if the port is unreachable or answers anything but 2xx.
#
# The same two-line parse lives in four publishers as load_rmq_admin_creds.
# Those copies refresh the log first and so cannot simply call this one; folding
# them together is worth doing separately from the exec they are not on.
_dune_rmq_admin_user=""
_dune_rmq_admin_password=""
_dune_rmq_admin_creds_tried=""

_dune_rmq_admin_creds() {
  [ -z "$_dune_rmq_admin_creds_tried" ] || {
    [ -n "$_dune_rmq_admin_user" ] || return 1
    return 0
  }
  _dune_rmq_admin_creds_tried=1

  local parsed
  parsed="$(python3 - <<'PY' || true
from pathlib import Path
import re

log_path = Path("runtime/text-router/director-current.log")
patterns = [
    re.compile(r'Generated new admin credentials:\s*(bgd\.[^/\s]+\.admin)\s*/\s*([A-Za-z0-9+/=]+)'),
    re.compile(r'(bgd\.[^/\s]+\.admin)/([A-Za-z0-9+/=]+) => allow administrator'),
]
text = log_path.read_text(errors="ignore") if log_path.exists() else ""
matches = []
for pattern in patterns:
    matches = pattern.findall(text)
    if matches:
        break
if matches:
    print(matches[-1][0])
    print(matches[-1][1])
PY
)"

  _dune_rmq_admin_user="$(printf '%s' "$parsed" | sed -n 1p)"
  _dune_rmq_admin_password="$(printf '%s' "$parsed" | sed -n 2p)"
  [ -n "$_dune_rmq_admin_user" ] && [ -n "$_dune_rmq_admin_password" ]
}

# One connection per line, user and state separated by a tab -- the columns and
# the order `rabbitmqctl list_connections user state` prints, minus its header,
# which neither caller's awk wanted. Success prints the list, which may be
# legitimately empty when no game server has connected yet.
dune_rmq_game_connections() {
  [ "$(dune_rmq_transport)" = http ] || return "$RMQ_HTTP_UNSUPPORTED"
  _dune_rmq_admin_creds || return "$RMQ_HTTP_UNSUPPORTED"

  local out_file code rc
  out_file="$(mktemp)" || return "$RMQ_HTTP_UNSUPPORTED"

  # Credentials go in on stdin rather than argv, where `ps` would show them.
  code="$(printf 'user = "%s:%s"\n' "$_dune_rmq_admin_user" "$_dune_rmq_admin_password" | curl \
    --silent --show-error --config - \
    --max-time "${RMQ_HTTP_TIMEOUT_SECONDS:-${RMQ_TIMEOUT_SECONDS:-15}}" \
    --get \
    --data-urlencode 'columns=user,state' \
    --output "$out_file" \
    --write-out '%{http_code}' \
    "http://127.0.0.1:$(resolve_rmq_game_local_http_port)/api/connections" 2>/dev/null)"
  rc=$?

  # Unlike _dune_rmq_http, a failure here does not demote the transport. The
  # two legs answer on different ports, and this one is published only by a
  # start-rabbitmq.sh new enough to have the loopback mapping -- so an
  # unreachable game management port says nothing about the admin broker the
  # publishers use, and must not switch them back to execing.
  if [ "$rc" -ne 0 ]; then
    rm -f "$out_file"
    return "$RMQ_HTTP_UNSUPPORTED"
  fi

  case "$code" in
    2*) ;;
    # Including 401: the credentials in the log have been rotated out from under
    # us, and the caller's exec -- which authenticates with the Erlang cookie
    # instead -- is the one that still works.
    *)  rm -f "$out_file"; return "$RMQ_HTTP_UNSUPPORTED" ;;
  esac

  RMQ_CONN_FILE="$out_file" python3 -c '
import json, os, sys
path = os.environ["RMQ_CONN_FILE"]
try:
    with open(path) as handle:
        rows = json.load(handle)
except Exception:
    sys.exit(1)
for row in rows:
    print("%s\t%s" % (row.get("user", ""), row.get("state", "")))
'
  rc=$?
  rm -f "$out_file"
  return "$rc"
}
