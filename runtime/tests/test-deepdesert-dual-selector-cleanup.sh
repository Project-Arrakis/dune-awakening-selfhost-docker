#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

SCRIPT="runtime/scripts/deepdesert.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

grep -Fq '; ManagedPvpPartition=$pvp' "$SCRIPT" \
  || fail "the managed override no longer records the PvP selector it owns"
grep -Fq '; ManagedPvePartition=$pve' "$SCRIPT" \
  || fail "the managed override no longer records the PvE selector it owns"
grep -Fq 'pve="$(managed_selector_from_override ManagedPvePartition)"' "$SCRIPT" \
  || fail "disable no longer recovers the PvE selector after its database row disappears"

early_cleanup_line="$(grep -n 'remove_dual_usergame_selectors "$pvp" "$pve"' "$SCRIPT" | head -n1 | cut -d: -f1)"
early_remove_line="$(grep -n 'rm -f "$OVERRIDE_FILE"' "$SCRIPT" | head -n1 | cut -d: -f1)"
[ -n "$early_cleanup_line" ] && [ -n "$early_remove_line" ] \
  || fail "could not locate the missing-row cleanup path"
[ "$early_cleanup_line" -lt "$early_remove_line" ] \
  || fail "selector ownership is deleted before the missing-row cleanup can use it"

echo "PASS: Dual Deep Desert selector cleanup remains exact and survives a missing extra partition row"
