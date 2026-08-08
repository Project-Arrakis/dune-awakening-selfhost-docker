#!/usr/bin/env bash
set -euo pipefail

# Root-only host mutation helper. It manages exactly one project-owned swap
# file and marked fstab/sysctl entries; unrelated host swap is never changed.

SWAP_DIR="/var/lib/dune-awakening"
SWAP_FILE="$SWAP_DIR/swapfile"
STATE_FILE="$SWAP_DIR/memory-swap.env"
FSTAB="/etc/fstab"
SYSCTL_FILE="/etc/sysctl.d/99-dune-memory-swap.conf"
FSTAB_BEGIN="# BEGIN dune-awakening-memory-swap"
FSTAB_END="# END dune-awakening-memory-swap"

require_root() {
  [ "$(id -u)" -eq 0 ] || { echo "Memory Swap host changes require root." >&2; exit 1; }
}

validate_pool() {
  if ! printf '%s' "$1" | grep -Eq '^[0-9]+$' || [ "$1" -gt 32 ]; then
    echo "Swap pool must be a whole number from 0 to 32 GiB." >&2
    exit 1
  fi
}

validate_swappiness() {
  if ! printf '%s' "$1" | grep -Eq '^[0-9]+$' || [ "$1" -gt 100 ]; then
    echo "Swappiness must be a whole number from 0 to 100." >&2
    exit 1
  fi
}

remove_marked_block() {
  local file="$1" begin="$2" end="$3" tmp
  [ -e "$file" ] || return 0
  tmp="${file}.dune-swap.$$"
  awk -v begin="$begin" -v end="$end" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

active_swap() {
  awk -v file="$SWAP_FILE" 'NR > 1 && $1 == file { found = 1 } END { exit !found }' /proc/swaps
}

safe_disk_check() {
  local pool_gib="$1" available_kib total_kib reserve_kib required_kib
  read -r total_kib available_kib < <(df -Pk "$SWAP_DIR" | awk 'NR == 2 { print $2, $4 }')
  reserve_kib=$((25 * 1024 * 1024))
  if [ $((total_kib / 10)) -gt "$reserve_kib" ]; then reserve_kib=$((total_kib / 10)); fi
  required_kib=$((pool_gib * 1024 * 1024))
  if [ -f "$SWAP_FILE" ]; then
    required_kib=$((required_kib - $(du -k "$SWAP_FILE" | awk '{print $1}')))
    [ "$required_kib" -gt 0 ] || required_kib=0
  fi
  if [ $((available_kib - required_kib)) -lt "$reserve_kib" ]; then
    echo "Not enough safe disk space for a ${pool_gib} GiB swap file." >&2
    echo "Memory Swap preserves at least 25 GiB or 10% of this filesystem, whichever is larger." >&2
    exit 1
  fi
}

enable_swap() {
  local pool_gib="$1" swappiness="$2" fs_type original_swappiness
  validate_pool "$pool_gib"
  validate_swappiness "$swappiness"
  mkdir -p "$SWAP_DIR"
  chmod 700 "$SWAP_DIR"
  if [ "$pool_gib" -gt 0 ]; then
    fs_type="$(findmnt -n -o FSTYPE --target "$SWAP_DIR" 2>/dev/null || true)"
    case "$fs_type" in
      ext2|ext3|ext4|xfs) ;;
      *) echo "Memory Swap does not automatically create swap files on ${fs_type:-this filesystem}. Use ext4/xfs or configure host swap manually." >&2; exit 1 ;;
    esac
    safe_disk_check "$pool_gib"
  fi

  if active_swap; then swapoff "$SWAP_FILE"; fi
  rm -f "$SWAP_FILE"
  remove_marked_block "$FSTAB" "$FSTAB_BEGIN" "$FSTAB_END"
  if [ "$pool_gib" -gt 0 ]; then
    if command -v fallocate >/dev/null 2>&1; then
      fallocate -l "${pool_gib}G" "$SWAP_FILE"
    else
      dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$((pool_gib * 1024))" status=progress
    fi
    chmod 600 "$SWAP_FILE"
    mkswap "$SWAP_FILE" >/dev/null
    swapon "$SWAP_FILE"
    cat >> "$FSTAB" <<EOF
$FSTAB_BEGIN
$SWAP_FILE none swap sw 0 0
$FSTAB_END
EOF
  fi

  original_swappiness="$(sysctl -n vm.swappiness 2>/dev/null || echo 60)"
  if [ -r "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE"
    original_swappiness="${DUNE_MEMORY_SWAP_ORIGINAL_SWAPPINESS:-$original_swappiness}"
  fi
  cat > "$STATE_FILE" <<EOF
DUNE_MEMORY_SWAP_POOL_GIB=$pool_gib
DUNE_MEMORY_SWAP_ORIGINAL_SWAPPINESS=$original_swappiness
DUNE_MEMORY_SWAP_CONFIGURED_SWAPPINESS=$swappiness
EOF
  chmod 600 "$STATE_FILE"
  printf 'vm.swappiness = %s\n' "$swappiness" > "$SYSCTL_FILE"
  sysctl -w "vm.swappiness=$swappiness" >/dev/null
  if [ "$pool_gib" -gt 0 ]; then
    echo "Memory Swap host pool enabled: ${pool_gib} GiB at $SWAP_FILE with swappiness ${swappiness}."
  else
    echo "Memory Swap is using existing host swap with swappiness ${swappiness}; no project swap file was created."
  fi
}

disable_swap() {
  local original_swappiness="" configured_swappiness=""
  if [ -r "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE"
    original_swappiness="${DUNE_MEMORY_SWAP_ORIGINAL_SWAPPINESS:-}"
    configured_swappiness="${DUNE_MEMORY_SWAP_CONFIGURED_SWAPPINESS:-10}"
  fi
  if active_swap; then swapoff "$SWAP_FILE"; fi
  rm -f "$SWAP_FILE" "$SYSCTL_FILE" "$STATE_FILE"
  remove_marked_block "$FSTAB" "$FSTAB_BEGIN" "$FSTAB_END"
  if printf '%s' "$original_swappiness" | grep -Eq '^[0-9]+$' && printf '%s' "$configured_swappiness" | grep -Eq '^[0-9]+$' && [ "$(sysctl -n vm.swappiness 2>/dev/null || true)" = "$configured_swappiness" ]; then
    sysctl -w "vm.swappiness=$original_swappiness" >/dev/null || true
  fi
  rmdir "$SWAP_DIR" 2>/dev/null || true
  echo "Project-managed Memory Swap host pool disabled."
}

require_root
case "${1:-}" in
  enable) enable_swap "${2:-}" "${3:-10}" ;;
  disable) disable_swap ;;
  *) echo "Usage: memory-swap-host.sh enable <pool-gib> <swappiness> | disable" >&2; exit 2 ;;
esac
