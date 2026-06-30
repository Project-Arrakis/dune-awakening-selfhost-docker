#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

. runtime/scripts/runtime-env.sh

set_env_file_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local mode="${4:-644}"
  local dir tmp

  dir="$(dirname "$file")"
  mkdir -p "$dir"

  if [ -e "$file" ] && [ ! -w "$file" ]; then
    echo "Cannot update $file because it is not writable by $(id -un)." >&2
    echo "Repair ownership from the repo root, then retry:" >&2
    echo "  sudo chown \"\$USER:\$USER\" $file" >&2
    echo "  chmod u+rw $file" >&2
    return 13
  fi

  touch "$file"
  tmp="$(mktemp "$dir/.${key}.XXXXXX")"
  awk -F= -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $1 == key {
      print key "=" value
      found = 1
      next
    }
    { print }
    END {
      if (!found) print key "=" value
    }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
  chmod "$mode" "$file" 2>/dev/null || true
}

sync_public_ip_on_start() {
  local mode current configured generated

  if [ "${DUNE_START_AUTO_PUBLIC_IP_SYNC:-1}" = "0" ]; then
    echo "Public IP auto-sync skipped: disabled by DUNE_START_AUTO_PUBLIC_IP_SYNC=0."
    return 0
  fi

  mode="$(resolve_server_ip_mode 2>/dev/null || true)"
  if [ "$mode" != "public" ]; then
    echo "Public IP auto-sync skipped: SERVER_IP_MODE is ${mode:-unknown}, not public."
    return 0
  fi

  current="${DUNE_DETECTED_PUBLIC_IP_OVERRIDE:-}"
  if [ -z "$current" ]; then
    current="$(detect_public_ip 2>/dev/null || true)"
  fi
  if ! is_ipv4 "$current"; then
    echo "Public IP auto-sync skipped: could not detect current public IPv4."
    return 0
  fi

  configured="$(config_value .env SERVER_IP 2>/dev/null || true)"
  generated="$(config_value runtime/generated/battlegroup.env SERVER_IP 2>/dev/null || true)"

  if [ "$configured" = "$current" ]; then
    if [ -f runtime/generated/battlegroup.env ] && [ "$generated" != "$current" ]; then
      set_env_file_value runtime/generated/battlegroup.env SERVER_IP "$current" 664
      set_env_file_value runtime/generated/battlegroup.env SERVER_IP_MODE public 664
      echo "Public IP auto-sync: refreshed generated SERVER_IP=$current."
    else
      echo "Public IP auto-sync: SERVER_IP is current ($current)."
    fi
    return 0
  fi

  set_env_file_value .env SERVER_IP "$current" 644
  set_env_file_value .env SERVER_IP_MODE public 644
  if [ -f runtime/generated/battlegroup.env ]; then
    set_env_file_value runtime/generated/battlegroup.env SERVER_IP "$current" 664
    set_env_file_value runtime/generated/battlegroup.env SERVER_IP_MODE public 664
  fi

  echo "Public IP auto-sync: SERVER_IP ${configured:-unset} -> $current."
}

case "${1:-sync}" in
  sync|start)
    sync_public_ip_on_start
    ;;
  *)
    echo "Usage: $0 [sync]" >&2
    exit 2
    ;;
esac
