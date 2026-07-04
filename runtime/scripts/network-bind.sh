#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
source runtime/scripts/runtime-env.sh

usage() {
  cat <<'EOF'
Usage: runtime/scripts/network-bind.sh <status|fix>

Commands:
  status  Show whether public NAT socket binding is at risk.
  fix     Set net.ipv4.ip_nonlocal_bind=0 only when that public NAT risk exists.
EOF
}

public_nat_nonlocal_bind_risk() {
  local mode advertised_ip bind_ip nonlocal_bind

  mode="$(resolve_server_ip_mode 2>/dev/null || true)"
  advertised_ip="$(resolve_advertised_ip)"
  bind_ip="$(resolve_bind_ip)"
  nonlocal_bind="$(read_ipv4_ip_nonlocal_bind 2>/dev/null || true)"

  [ "$mode" = "public" ] || return 1
  is_ipv4 "$advertised_ip" || return 1
  is_ipv4 "$bind_ip" || return 1
  is_private_ipv4 "$bind_ip" || return 1
  [ "$advertised_ip" != "$bind_ip" ] || return 1
  [ "$nonlocal_bind" = "1" ] || return 1
}

print_status() {
  local mode advertised_ip bind_ip nonlocal_bind

  mode="$(resolve_server_ip_mode 2>/dev/null || true)"
  advertised_ip="$(resolve_advertised_ip)"
  bind_ip="$(resolve_bind_ip)"
  nonlocal_bind="$(read_ipv4_ip_nonlocal_bind 2>/dev/null || echo "unavailable")"

  printf 'server_ip_mode=%s\n' "${mode:-unknown}"
  printf 'server_ip=%s\n' "${advertised_ip:-unknown}"
  printf 'server_bind_ip=%s\n' "${bind_ip:-unknown}"
  printf 'ip_nonlocal_bind=%s\n' "$nonlocal_bind"

  if public_nat_nonlocal_bind_risk; then
    echo "status=risk"
    echo "Public NAT mode is at risk: game sockets may bind to SERVER_IP instead of SERVER_BIND_IP."
    echo "Fix: sudo sysctl -w net.ipv4.ip_nonlocal_bind=0"
  else
    echo "status=ok"
    echo "No public NAT non-local bind risk detected."
  fi
}

set_ip_nonlocal_bind_zero() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
    sysctl -w net.ipv4.ip_nonlocal_bind=0
    return $?
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo sysctl -w net.ipv4.ip_nonlocal_bind=0
    return $?
  fi

  echo "Cannot change net.ipv4.ip_nonlocal_bind automatically: this command needs root or sudo." >&2
  return 1
}

cmd="${1:-status}"
case "$cmd" in
  status)
    print_status
    ;;
  fix)
    if ! public_nat_nonlocal_bind_risk; then
      print_status
      echo "No change made."
      exit 0
    fi
    echo "Fixing public NAT socket binding risk..."
    set_ip_nonlocal_bind_zero
    print_status
    echo "Restart the battlegroup so game sockets bind to SERVER_BIND_IP."
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
