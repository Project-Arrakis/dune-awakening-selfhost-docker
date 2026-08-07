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
grep -Fq 'pve_partition_id() {' "$SCRIPT" \
  || fail "the complementary PvE partition helper is missing"
grep -A6 -F 'pve_partition_id() {' "$SCRIPT" | grep -Fq '[ -n "$secondary" ] || return 0' \
  || fail "single Deep Desert mode is incorrectly reported as having a PvE sibling"
grep -Fq 'Single Deep Desert configuration: partition ${primary:-unavailable} is ${single_state:-UNKNOWN}.' "$SCRIPT" \
  || fail "disabled status does not report the remaining single partition clearly"
grep -A12 -F 'pvp_partition_id() {' "$SCRIPT" | grep -Fq 'managed_selector_from_override ManagedPvpPartition' \
  || fail "repairs no longer preserve the managed PvP partition"
grep -Fq 'primary_state" = "PVP"' "$SCRIPT" \
  || fail "first enable no longer preserves an existing primary PvP role"
grep -Fq 'map-unset DeepDesert_1 force_pvp_all_partitions' "$SCRIPT" \
  || fail "the legacy map-scoped force-PvP flag is not removed"
grep -Fq 'map-set Global force_pvp_all_partitions False' "$SCRIPT" \
  || fail "the verified Global force-PvP flag is not written"
grep -Fq 'map-set Global global_pvp_enabled_partition_add "$pvp"' "$SCRIPT" \
  || fail "the selected Deep Desert PvP partition is not added to the Global selector"
if grep -Fq 'map-set Global global_pve_enabled_partition_add' "$SCRIPT"; then
  fail "Dual Deep Desert must not write an explicit PvE selector"
fi
grep -Fq "set label = 'DualDeepDesert_' || partition_id::text" "$SCRIPT" \
  || fail "partition role reversal can hit the unique label constraint without temporary labels"
enable_apply_count="$(awk '/^enable_dual\(\)/,/^disable_dual\(\)/' "$SCRIPT" | grep -c '^  apply_usergame$')"
[ "$enable_apply_count" = "1" ] \
  || fail "Dual Deep Desert enable must materialize UserGame settings exactly once"

early_cleanup_line="$(grep -n 'remove_dual_usergame_selectors "$pvp" "$pve"' "$SCRIPT" | head -n1 | cut -d: -f1)"
early_remove_line="$(grep -n 'rm -f "$OVERRIDE_FILE"' "$SCRIPT" | head -n1 | cut -d: -f1)"
[ -n "$early_cleanup_line" ] && [ -n "$early_remove_line" ] \
  || fail "could not locate the missing-row cleanup path"
[ "$early_cleanup_line" -lt "$early_remove_line" ] \
  || fail "selector ownership is deleted before the missing-row cleanup can use it"

# The new map-unset operation is required to converge installations that previously received
# the map-scoped force flag. Prove it removes only that field and leaves adjacent map settings.
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
profile="$tmpdir/gameplay-profile.ini"
cat > "$profile" <<'EOF'
[Map:DeepDesert_1:/Script/DuneSandbox.PvpPveSettings]
m_bShouldForceEnablePvpOnAllPartitions=False
bIsServerPVE=True

[Global:/Script/DuneSandbox.PvpPveSettings]
m_bShouldForceEnablePvpOnAllPartitions=False
+m_PvpEnabledPartitions=8
+m_PveEnabledPartitions=40
EOF
DUNE_GAMEPLAY_PROFILE="$profile" DUNE_USERSETTINGS_CONFIG="$tmpdir/usersettings.json" \
  python3 runtime/scripts/usersettings.py map-unset DeepDesert_1 force_pvp_all_partitions
# Converge a previous explicit PvP/PvE pair to the verified single-selector layout used by
# apply_usergame(). This fixture represents a preserved PvE primary / PvP secondary assignment.
for partition_id in 8 40; do
  DUNE_GAMEPLAY_PROFILE="$profile" DUNE_USERSETTINGS_CONFIG="$tmpdir/usersettings.json" \
    python3 runtime/scripts/usersettings.py map-set Global global_pvp_enabled_partition_remove "$partition_id"
  DUNE_GAMEPLAY_PROFILE="$profile" DUNE_USERSETTINGS_CONFIG="$tmpdir/usersettings.json" \
    python3 runtime/scripts/usersettings.py map-set Global global_pve_enabled_partition_remove "$partition_id"
done
DUNE_GAMEPLAY_PROFILE="$profile" DUNE_USERSETTINGS_CONFIG="$tmpdir/usersettings.json" \
  python3 runtime/scripts/usersettings.py map-set Global force_pvp_all_partitions False
DUNE_GAMEPLAY_PROFILE="$profile" DUNE_USERSETTINGS_CONFIG="$tmpdir/usersettings.json" \
  python3 runtime/scripts/usersettings.py map-set Global global_pvp_enabled_partition_add 40
grep -Fq 'bIsServerPVE=True' "$profile" \
  || fail "map-unset removed an adjacent Deep Desert setting"
if awk '/^\[Map:DeepDesert_1:/{inside=1; next} /^\[/{inside=0} inside' "$profile" \
  | grep -Fq 'm_bShouldForceEnablePvpOnAllPartitions'; then
  fail "map-unset left the legacy map-scoped force-PvP flag behind"
fi
awk '/^\[Global:/{inside=1; next} /^\[/{inside=0} inside' "$profile" \
  | grep -Fq 'm_bShouldForceEnablePvpOnAllPartitions=False' \
  || fail "map-unset touched the Global force-PvP flag"
awk '/^\[Global:/{inside=1; next} /^\[/{inside=0} inside' "$profile" \
  | grep -Fqx '+m_PvpEnabledPartitions=40' \
  || fail "the verified layout did not select dimension 1 as PvP"
if grep -Fq '+m_PvpEnabledPartitions=8' "$profile" || grep -Fq 'm_PveEnabledPartitions=' "$profile"; then
  fail "legacy PvP/PvE selectors survived convergence to the verified layout"
fi

# HomeDimension must replace only Deep Desert's default matchmaking rule. It must not clear
# other maps from the shared global array, and disabling Dual Deep Desert must remove only the
# two exact entries owned by this feature.
cat >> "$profile" <<'EOF'

[Global:/Script/DuneSandbox.MatchmakerEventsSettings]
+m_BattlegroupsAllMapSettings=(MapName="Overmap",MapSettings=(SelectionRule="FirstOfGroup",MaxPlayerCapacity=100,IsStartingMap=False))
EOF
DUNE_GAMEPLAY_PROFILE="$profile" DUNE_USERSETTINGS_CONFIG="$tmpdir/usersettings.json" \
  python3 runtime/scripts/usersettings.py dual-deepdesert-matchmaker enable
grep -Fqx -- '-m_BattlegroupsAllMapSettings=(MapName="DeepDesert_1",MapSettings=(SelectionRule="FirstOfGroup",MaxPlayerCapacity=100,IsStartingMap=False))' "$profile" \
  || fail "Dual Deep Desert did not remove the default FirstOfGroup rule"
grep -Fqx -- '+m_BattlegroupsAllMapSettings=(MapName="DeepDesert_1",MapSettings=(SelectionRule="HomeDimension",MaxPlayerCapacity=100,IsStartingMap=False))' "$profile" \
  || fail "Dual Deep Desert did not add the HomeDimension routing rule"
DUNE_GAMEPLAY_PROFILE="$profile" DUNE_USERSETTINGS_CONFIG="$tmpdir/usersettings.json" \
  python3 runtime/scripts/usersettings.py dual-deepdesert-matchmaker disable
if grep -Fq 'MapName="DeepDesert_1"' "$profile"; then
  fail "disabling Dual Deep Desert left its matchmaking override behind"
fi
grep -Fq 'MapName="Overmap"' "$profile" \
  || fail "Dual Deep Desert matchmaking management removed another map's entry"

echo "PASS: Dual Deep Desert selector cleanup remains exact and survives a missing extra partition row"
