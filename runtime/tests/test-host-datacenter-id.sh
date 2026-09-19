#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

# shellcheck source=runtime/scripts/runtime-env.sh
source runtime/scripts/runtime-env.sh

# Isolate resolver precedence from this checkout's real .env file.
config_value() { return 1; }

assert_equal() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [ "$actual" != "$expected" ]; then
    printf 'FAIL: %s (expected %s, got %s)\n' "$message" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_equal "ping.example.com" "$(HOST_DATACENTER_ID=ping.example.com SERVER_PROVIDER=legacy-provider resolve_host_datacenter_id)" "dedicated value wins"
assert_equal "legacy-provider" "$(HOST_DATACENTER_ID='' SERVER_PROVIDER=legacy-provider resolve_host_datacenter_id)" "legacy Provider remains an upgrade fallback"
assert_equal "dune-docker" "$(HOST_DATACENTER_ID='' SERVER_PROVIDER='' resolve_host_datacenter_id)" "default remains backward compatible"

if HOST_DATACENTER_ID='https://bad.example.com' SERVER_PROVIDER='' resolve_host_datacenter_id >/dev/null 2>&1; then
  echo "FAIL: URL was accepted as a Datacenter ID" >&2
  exit 1
fi

for script in start-director.sh start-server-gateway.sh start-text-router.sh; do
  # shellcheck disable=SC2016 # These are literal source-code assertions.
  grep -Fq 'HOST_DATACENTER_ID_VALUE="$(resolve_host_datacenter_id)"' "runtime/scripts/$script"
  # shellcheck disable=SC2016 # These are literal source-code assertions.
  grep -Fq -- '-e "HOST_DATACENTER_ID=$HOST_DATACENTER_ID_VALUE"' "runtime/scripts/$script"
done

grep -Fq 'use a hostname whose' .env.example
grep -Fq 'IPv4 A record points directly to SERVER_IP' .env.example
grep -Fq 'A Datacenter ID hostname resolving to the advertised public IP gives FLS a concrete ping target.' runtime/scripts/ping-diagnostics.sh

echo "Host Datacenter ID tests passed."
