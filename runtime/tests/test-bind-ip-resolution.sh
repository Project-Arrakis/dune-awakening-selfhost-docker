#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

export DUNE_COMPOSE_PROJECT_NAME=test-bind-ip-resolution
# shellcheck disable=SC1091
source runtime/scripts/runtime-env.sh

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

configured_bind_ip=""
survival_pod_ip=""
overmap_pod_ip=""
dynamic_pod_ip=""
detected_bind_ip="192.168.1.145"
assigned_bind_ips="192.168.1.145"

config_value() {
  local _file="$1"
  local key="$2"
  [ "$key" = "SERVER_BIND_IP" ] || return 1
  [ -n "$configured_bind_ip" ] || return 1
  printf '%s' "$configured_bind_ip"
}

container_env_value_any_state() {
  local container="$1"
  local key="$2"
  [ "$key" = "POD_IP" ] || return 1
  case "$container" in
    dune-server-survival-1) [ -n "$survival_pod_ip" ] && printf '%s' "$survival_pod_ip" ;;
    dune-server-overmap) [ -n "$overmap_pod_ip" ] && printf '%s' "$overmap_pod_ip" ;;
    *) return 1 ;;
  esac
}

any_container_env_value_matching() {
  local _pattern="$1"
  local key="$2"
  [ "$key" = "POD_IP" ] || return 1
  [ -n "$dynamic_pod_ip" ] || return 1
  printf '%s' "$dynamic_pod_ip"
}

bind_ip_is_assigned() {
  local candidate="$1"
  case " $assigned_bind_ips " in
    *" $candidate "*) return 0 ;;
    *) return 1 ;;
  esac
}

detect_bind_ip() {
  printf '%s' "$detected_bind_ip"
}

assert_bind_ip() {
  local expected="$1"
  local description="$2"
  local actual
  actual="$(resolve_bind_ip)"
  [ "$actual" = "$expected" ] || fail "$description: expected $expected, got $actual"
}

configured_bind_ip="192.168.1.145"
survival_pod_ip="172.23.138.108"
assert_bind_ip "192.168.1.145" "an assigned explicit bind address wins"

configured_bind_ip=""
assert_bind_ip "192.168.1.145" "a stale Survival POD_IP falls back to host detection"

survival_pod_ip=""
overmap_pod_ip="192.168.1.145"
detected_bind_ip="10.0.0.25"
assert_bind_ip "192.168.1.145" "an assigned existing POD_IP remains stable"

overmap_pod_ip=""
dynamic_pod_ip="172.23.138.108"
assigned_bind_ips="10.0.0.25"
assert_bind_ip "10.0.0.25" "a stale dynamic-map POD_IP falls back to host detection"

printf 'PASS: bind address resolution rejects stale container POD_IP values\n'
