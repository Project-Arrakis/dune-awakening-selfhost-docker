#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

export DUNE_COMPOSE_PROJECT_NAME=test-rmq-host-resolution
# shellcheck disable=SC1091
source runtime/scripts/runtime-env.sh

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

configured_game_host=""
configured_admin_host=""
bind_ip="192.168.1.22"
advertised_ip="203.0.113.10"
docker_operating_system="Native Linux"
reachable_endpoints=""

config_value() {
  local _file="$1"
  local key="$2"
  case "$key" in
    DUNE_RMQ_GAME_HOST) [ -n "$configured_game_host" ] && printf '%s' "$configured_game_host" ;;
    DUNE_RMQ_ADMIN_HOST) [ -n "$configured_admin_host" ] && printf '%s' "$configured_admin_host" ;;
    *) return 1 ;;
  esac
}

docker() {
  [ "${1:-}" = "info" ] || return 1
  printf '%s\n' "$docker_operating_system"
}

resolve_game_listen_ip() {
  printf '%s' "$bind_ip"
}

resolve_advertised_ip() {
  printf '%s' "$advertised_ip"
}

tcp_endpoint_reachable() {
  local endpoint="$1:$2"
  case " $reachable_endpoints " in
    *" $endpoint "*) return 0 ;;
    *) return 1 ;;
  esac
}

assert_value() {
  local expected="$1"
  local actual="$2"
  local description="$3"
  [ "$actual" = "$expected" ] || fail "$description: expected $expected, got $actual"
}

unset DUNE_RMQ_GAME_HOST DUNE_RMQ_ADMIN_HOST

configured_game_host="10.0.0.9"
assert_value "10.0.0.9" "$(resolve_rmq_game_host)" "an explicit game broker host wins"

configured_game_host=""
reachable_endpoints="127.0.0.1:31982"
assert_value "127.0.0.1" "$(resolve_rmq_game_host)" "reachable loopback remains the native default"

reachable_endpoints="192.168.1.22:31982"
assert_value "192.168.1.22" "$(resolve_rmq_game_host)" "an unreachable loopback falls back to the bind address"

reachable_endpoints=""
assert_value "192.168.1.22" "$(resolve_rmq_game_host)" "a warming broker still uses the native bind-address fallback"

configured_admin_host="10.0.0.10"
assert_value "10.0.0.10" "$(resolve_rmq_admin_host)" "an explicit admin broker host wins"

configured_admin_host=""
assert_value "127.0.0.1" "$(resolve_rmq_admin_host)" "native admin broker routing remains loopback-only"

docker_operating_system="Docker Desktop"
assert_value "203.0.113.10" "$(resolve_rmq_game_host)" "Docker Desktop keeps its advertised game broker route"
assert_value "203.0.113.10" "$(resolve_rmq_admin_host)" "Docker Desktop keeps its existing admin broker route"

printf 'PASS: RabbitMQ host resolution handles loopback-incompatible Docker hosts\n'
