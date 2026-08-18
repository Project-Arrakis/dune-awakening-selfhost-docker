#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

test_no=0

note() {
  printf '# %s\n' "$*"
}

ok() {
  test_no=$((test_no + 1))
  printf 'ok %02d - %s\n' "$test_no" "$*"
}

fail() {
  test_no=$((test_no + 1))
  printf 'not ok %02d - %s\n' "$test_no" "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  local label="$3"

  if grep -Fq -- "$expected" "$file"; then
    ok "$label"
    return 0
  fi

  echo "Expected to find: $expected" >&2
  echo "--- output ---" >&2
  cat "$file" >&2
  echo "--------------" >&2
  fail "$label"
}

assert_command_fails() {
  local output_file="$1"
  local label="$2"
  shift 2

  if "$@" >"$output_file" 2>&1; then
    echo "--- unexpected success output ---" >&2
    cat "$output_file" >&2
    echo "-------------------------------" >&2
    fail "$label"
  fi

  ok "$label"
}

show_output_block() {
  local title="$1"
  local file="$2"

  note "$title"
  sed 's/^/#   /' "$file"
}

echo "TAP version 13"
note "metrics-stack unit tests"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
mkdir -p "$tmpdir/bin"
ok "created isolated test harness directory"

cat >"$tmpdir/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  info)
    exit 0
    ;;
  compose)
    shift || true
    case "${1:-}" in
      version)
        echo "Docker Compose version v2.test"
        exit 0
        ;;
      -f)
        # Support: docker compose -f docker-compose.metrics.yml config
        if [ "${3:-}" = "config" ]; then
          echo "services: {}"
          exit 0
        fi
        # Support: docker compose -f docker-compose.metrics.yml up -d
        # (and restart's down/up pair) -- ensure_alert_relay_token()
        # regression tests below need `start`/`restart` to succeed
        # without a real Docker daemon.
        if [ "${3:-}" = "up" ] || [ "${3:-}" = "down" ]; then
          exit 0
        fi
        ;;
    esac
    echo "unexpected docker compose args: $*" >&2
    exit 1
    ;;
  ps)
    cat <<'PS'
NAMES                    STATUS                    PORTS
dune-prometheus          Up 1 minute               127.0.0.1:9090->9090/tcp
dune-cadvisor            Up 1 minute (healthy)     8080/tcp
dune-node-exporter       Up 1 minute               9100/tcp
dune-postgres-exporter   Up 1 minute               9187/tcp
PS
    exit 0
    ;;
  network)
    exit 0
    ;;
  *)
    echo "unexpected docker args: $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$tmpdir/bin/docker"
ok "installed fake docker command"

cat >"$tmpdir/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${FAKE_CURL_LOG:?FAKE_CURL_LOG is required}"
args=" $* "
mode="${FAKE_PROMETHEUS_MODE:-ok}"

if [[ "$args" == *"/-/healthy"* ]]; then
  echo "healthy"
  exit 0
fi

if [[ "$args" == *"/api/v1/targets"* ]]; then
  if [ "$mode" = "missing-target" ]; then
    cat <<'JSON'
{"status":"success","data":{"activeTargets":[
  {"labels":{"job":"dune-prometheus","instance":"dune-prometheus:9090"},"health":"up"},
  {"labels":{"job":"dune-cadvisor","instance":"dune-cadvisor:8080"},"health":"up"},
  {"labels":{"job":"dune-postgres","instance":"dune-postgres-exporter:9187"},"health":"up"}
]}}
JSON
  else
    cat <<'JSON'
{"status":"success","data":{"activeTargets":[
  {"labels":{"job":"dune-prometheus","instance":"dune-prometheus:9090"},"health":"up"},
  {"labels":{"job":"dune-node","instance":"dune-node-exporter:9100"},"health":"up"},
  {"labels":{"job":"dune-cadvisor","instance":"dune-cadvisor:8080"},"health":"up"},
  {"labels":{"job":"dune-postgres","instance":"dune-postgres-exporter:9187"},"health":"up"},
  {"labels":{"job":"dune-rabbitmq-admin","instance":"dune-rmq-admin:15692"},"health":"up"},
  {"labels":{"job":"dune-rabbitmq-game","instance":"dune-rmq-game:15692"},"health":"up"}
]}}
JSON
  fi
  exit 0
fi

if [[ "$args" == *"/api/v1/rules"* ]]; then
  cat <<'JSON'
{"status":"success","data":{"groups":[
  {"name":"dune-host","rules":[{"name":"DuneHostHighCpu"}]},
  {"name":"dune-containers","rules":[{"name":"DuneContainerMetricsMissing"}]},
  {"name":"dune-postgres","rules":[{"name":"DunePostgresDown"}]},
  {"name":"dune-rabbitmq","rules":[{"name":"DuneRabbitmqDown"}]},
  {"name":"dune-stack","rules":[]}
]}}
JSON
  exit 0
fi

if [[ "$args" == *"query=pg_up"* ]]; then
  cat <<'JSON'
{"status":"success","data":{"resultType":"vector","result":[
  {"metric":{"job":"dune-postgres","instance":"dune-postgres-exporter:9187"},"value":[1782798595.497,"1"]}
]}}
JSON
  exit 0
fi

if [[ "$args" == *"query=up"* ]]; then
  cat <<'JSON'
{"status":"success","data":{"resultType":"vector","result":[
  {"metric":{"job":"dune-postgres","instance":"dune-postgres-exporter:9187"},"value":[1782798595.478,"1"]},
  {"metric":{"job":"dune-cadvisor","instance":"dune-cadvisor:8080"},"value":[1782798595.478,"1"]},
  {"metric":{"job":"dune-rabbitmq-admin","instance":"dune-rmq-admin:15692"},"value":[1782798595.478,"1"]},
  {"metric":{"job":"dune-rabbitmq-game","instance":"dune-rmq-game:15692"},"value":[1782798595.478,"1"]},
  {"metric":{"job":"dune-prometheus","instance":"dune-prometheus:9090"},"value":[1782798595.478,"1"]},
  {"metric":{"job":"dune-node","instance":"dune-node-exporter:9100"},"value":[1782798595.478,"1"]}
]}}
JSON
  exit 0
fi

echo "unexpected curl args: $*" >&2
exit 1
EOF
chmod +x "$tmpdir/bin/curl"
ok "installed fake curl/Prometheus command"

export PATH="$tmpdir/bin:$PATH"
export FAKE_CURL_LOG="$tmpdir/curl.log"
ok "wired fake commands into PATH"

note "running happy-path metrics validation"
pass_output="$tmpdir/pass.out"
: >"$FAKE_CURL_LOG"
METRICS_PROMETHEUS_PORT=9090 bash runtime/scripts/metrics-stack.sh validate >"$pass_output"
show_output_block "happy-path validator output" "$pass_output"
assert_contains "$pass_output" "OK   Prometheus health" "validator reports Prometheus health"
assert_contains "$pass_output" "active_targets=6" "validator counts all six active targets"
assert_contains "$pass_output" "dune-rabbitmq-admin" "validator includes RabbitMQ admin target"
assert_contains "$pass_output" "dune-rabbitmq-game" "validator includes RabbitMQ game target"
assert_contains "$pass_output" "rule_groups=5" "validator reports loaded rule groups"
assert_contains "$pass_output" "pg_up=1" "validator confirms Postgres exporter connectivity"
assert_contains "$pass_output" "READY: metrics validation passed." "validator returns READY on healthy fixtures"
assert_contains "$FAKE_CURL_LOG" "--data-urlencode query=up" "validator URL-encodes the up query"
assert_contains "$FAKE_CURL_LOG" "--data-urlencode query=pg_up" "validator URL-encodes the pg_up query"

note "running required-target failure validation"
missing_output="$tmpdir/missing.out"
assert_command_fails "$missing_output" "validator fails when required target is missing" \
  env FAKE_PROMETHEUS_MODE=missing-target METRICS_PROMETHEUS_PORT=9090 bash runtime/scripts/metrics-stack.sh validate
show_output_block "missing-target validator output" "$missing_output"
assert_contains "$missing_output" "Missing required jobs: dune-node" "validator names missing required target"
assert_contains "$missing_output" "FAIL: metrics validation failed." "validator prints failure summary"

# yacketrj/arrakis-control-panel#167: `dune metrics start`/`restart` must
# auto-provision runtime/secrets/alert-relay-token.txt (bind-mounted into
# the dune-alertmanager container, see docker-compose.metrics.yml) rather
# than fail because the bind-mount target doesn't exist -- an existing
# operator upgrading to this change must not have their metrics stack
# suddenly refuse to start. This test runs against this real repo
# checkout's own runtime/secrets/ (the same way this file's other tests
# already run `metrics-stack.sh validate` against the real checkout), so
# it must clean up its own generated file afterward regardless of pass
# or fail -- extending the existing tmpdir cleanup trap to do so.
#
# Both this secret's and dune-awakening-selfhost-docker#307's Grafana
# password's pre-existence must be checked HERE, before either test
# block below calls `metrics-stack.sh start` even once -- both
# ensure_alert_relay_token() and ensure_grafana_password() run
# unconditionally on every `start`/`restart`, so checking
# grafana_password_preexisted only right before that block's own test
# would incorrectly see a file this alert-relay-token block's OWN
# `start` calls already created moments earlier on a genuinely fresh
# checkout, causing that block to wrongly skip itself as "pre-existing."
alert_relay_token_file="runtime/secrets/alert-relay-token.txt"
alert_relay_token_preexisted=0
[ -f "$alert_relay_token_file" ] && alert_relay_token_preexisted=1
grafana_password_file="runtime/secrets/grafana-admin-password.txt"
grafana_password_preexisted=0
[ -f "$grafana_password_file" ] && grafana_password_preexisted=1
cleanup_alert_relay_token() {
  if [ "$alert_relay_token_preexisted" = "0" ]; then
    rm -f "$alert_relay_token_file"
  fi
}
cleanup_grafana_password() {
  if [ "$grafana_password_preexisted" = "0" ]; then
    rm -f "$grafana_password_file"
  fi
}
trap 'cleanup_grafana_password; cleanup_alert_relay_token; rm -rf "$tmpdir"' EXIT

if [ "$alert_relay_token_preexisted" = "1" ]; then
  note "skipping alert-relay-token auto-provision test: $alert_relay_token_file already exists in this checkout (not overwriting a real operator secret)"
else
  note "running alert-relay-token auto-provision test"
  start_output="$tmpdir/start.out"
  METRICS_PROMETHEUS_PORT=9090 bash runtime/scripts/metrics-stack.sh start >"$start_output" 2>&1 || true
  show_output_block "start command output" "$start_output"
  if [ -s "$alert_relay_token_file" ]; then
    ok "runtime/secrets/alert-relay-token.txt was auto-created by 'dune metrics start'"
  else
    fail "runtime/secrets/alert-relay-token.txt was auto-created by 'dune metrics start'"
  fi
  actual_mode="$(stat -c '%a' "$alert_relay_token_file" 2>/dev/null || stat -f '%Lp' "$alert_relay_token_file" 2>/dev/null || echo unknown)"
  if [ "$actual_mode" = "600" ]; then
    ok "alert-relay-token.txt is created with mode 600"
  else
    fail "alert-relay-token.txt is created with mode 600 (got: $actual_mode)"
  fi
  token_size="$(wc -c <"$alert_relay_token_file" | tr -d '[:space:]')"
  if [ "$token_size" = "65" ]; then
    ok "alert-relay-token.txt contains a 32-byte hex token plus trailing newline (65 bytes)"
  else
    fail "alert-relay-token.txt contains a 32-byte hex token plus trailing newline (65 bytes, got: $token_size)"
  fi

  note "running idempotency check: a second start must not regenerate the token"
  first_token="$(cat "$alert_relay_token_file")"
  METRICS_PROMETHEUS_PORT=9090 bash runtime/scripts/metrics-stack.sh start >/dev/null 2>&1 || true
  second_token="$(cat "$alert_relay_token_file")"
  if [ "$first_token" = "$second_token" ]; then
    ok "a second 'dune metrics start' does not regenerate an already-existing token"
  else
    fail "a second 'dune metrics start' does not regenerate an already-existing token"
  fi
fi

# dune-awakening-selfhost-docker#307: `dune metrics start`/`restart` must
# auto-provision runtime/secrets/grafana-admin-password.txt and export it
# as METRICS_GRAFANA_PASSWORD, the same way ensure_alert_relay_token()
# already does for the Alertmanager relay token -- Grafana's own
# GF_SECURITY_ADMIN_PASSWORD previously had a static, checked-in "admin"
# default with no generation mechanism at all. Pre-existence was already
# checked above, before the alert-relay-token block's own `start` calls
# could have created this file as a side effect.
if [ "$grafana_password_preexisted" = "1" ]; then
  note "skipping grafana-admin-password auto-provision test: $grafana_password_file already exists in this checkout (not overwriting a real operator secret)"
else
  note "running grafana-admin-password auto-provision test"
  start_output="$tmpdir/start-grafana.out"
  METRICS_PROMETHEUS_PORT=9090 bash runtime/scripts/metrics-stack.sh start >"$start_output" 2>&1 || true
  show_output_block "start command output (grafana password)" "$start_output"
  if [ -s "$grafana_password_file" ]; then
    ok "runtime/secrets/grafana-admin-password.txt was auto-created by 'dune metrics start'"
  else
    fail "runtime/secrets/grafana-admin-password.txt was auto-created by 'dune metrics start'"
  fi
  actual_mode="$(stat -c '%a' "$grafana_password_file" 2>/dev/null || stat -f '%Lp' "$grafana_password_file" 2>/dev/null || echo unknown)"
  if [ "$actual_mode" = "600" ]; then
    ok "grafana-admin-password.txt is created with mode 600"
  else
    fail "grafana-admin-password.txt is created with mode 600 (got: $actual_mode)"
  fi
  password_size="$(wc -c <"$grafana_password_file" | tr -d '[:space:]')"
  if [ "$password_size" = "33" ]; then
    ok "grafana-admin-password.txt contains a 16-byte hex password plus trailing newline (33 bytes)"
  else
    fail "grafana-admin-password.txt contains a 16-byte hex password plus trailing newline (33 bytes, got: $password_size)"
  fi
  if grep -qx "admin" "$grafana_password_file"; then
    fail "generated grafana-admin-password.txt must not be the literal string 'admin'"
  else
    ok "generated grafana-admin-password.txt is not the old static 'admin' default"
  fi

  note "running idempotency check: a second start must not regenerate the password"
  first_password="$(cat "$grafana_password_file")"
  METRICS_PROMETHEUS_PORT=9090 bash runtime/scripts/metrics-stack.sh start >/dev/null 2>&1 || true
  second_password="$(cat "$grafana_password_file")"
  if [ "$first_password" = "$second_password" ]; then
    ok "a second 'dune metrics start' does not regenerate an already-existing grafana password"
  else
    fail "a second 'dune metrics start' does not regenerate an already-existing grafana password"
  fi
fi

echo "1..$test_no"
note "metrics-stack unit tests completed"
