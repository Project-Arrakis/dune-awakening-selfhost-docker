#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

check_order() {
  local script="$1"
  local stop_pattern="$2"
  local stop_line materialize_line
  stop_line="$(grep -F -n -m1 "$stop_pattern" "$script" | cut -d: -f1)"
  materialize_line="$(grep -F -n -m1 'usersettings.py materialize ' "$script" | cut -d: -f1)"
  if [ -z "$stop_line" ] || [ -z "$materialize_line" ] || [ "$materialize_line" -le "$stop_line" ]; then
    echo "FAIL: $script must materialize ServerCustomSettings.ini after stopping the old game container." >&2
    exit 1
  fi
}

check_order runtime/scripts/start-server-survival-1.sh 'docker rm -f dune-server-survival-1'
check_order runtime/scripts/start-server-overmap.sh 'docker rm -f dune-server-overmap'
check_order runtime/scripts/spawn-server.sh 'docker rm -f'

grep -Fq 'Saved/Config/LinuxServer' runtime/scripts/repair-map-settings-permissions.sh \
  || { echo "FAIL: dynamic-map permission repair does not cover ServerCustomSettings.ini" >&2; exit 1; }
grep -Fq 'Saved/Config/LinuxServer' runtime/scripts/repair-host-runtime-permissions.sh \
  || { echo "FAIL: host permission migration does not cover ServerCustomSettings.ini" >&2; exit 1; }

echo "PASS: game settings are materialized after the old container stops"
