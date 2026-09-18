#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
override="$tmpdir/director-deepdesert-layout.ini"

cat > "$override" <<'EOF'
; ManagedInstanceCount=3
[DeepDesert_1]
NumExtraServers=2
MinServers=0
EOF

status="$(DUNE_DEEPDESERT_OVERRIDE_FILE="$override" runtime/scripts/deepdesert.sh layout configured)"
grep -Fq 'configured for 3 instance(s)' <<< "$status"

if DUNE_DEEPDESERT_OVERRIDE_FILE="$override" runtime/scripts/deepdesert.sh layout set 4 >"$tmpdir/invalid.out" 2>&1; then
  echo "FAIL: four Deep Desert instances were accepted" >&2
  exit 1
fi
grep -Fq 'must be 1, 2, or 3' "$tmpdir/invalid.out"

grep -Fq 'NumExtraServers=$((count - 1))' runtime/scripts/deepdesert.sh
grep -Fq 'for target_dimension in 1..$((count - 1)) loop' runtime/scripts/deepdesert.sh
grep -Fq 'Cannot remove Deep Desert instance' runtime/scripts/deepdesert.sh
grep -Fq 'Change the Deep Desert layout from $current to $target instance(s)?' runtime/scripts/deepdesert.sh
grep -Fq 'DB_BACKUP_ORIGIN=restore-safety runtime/scripts/db.sh backup' runtime/scripts/deepdesert.sh
grep -Fq 'drop table if exists dune.event_log_p${partition_id}' runtime/scripts/deepdesert.sh
grep -Fq 'ManagedPrimaryDisplayNameBase64' runtime/scripts/deepdesert.sh
grep -Fq 'ManagedThirdRole=$third_role' runtime/scripts/deepdesert.sh
grep -Fq 'ManagedOriginalGlobalServerPVE=$original_global_server_pve' runtime/scripts/deepdesert.sh
grep -Fq 'global_pvp_enabled_partition_add "$third"' runtime/scripts/deepdesert.sh
grep -Fq 'map-set Global server_pve False' runtime/scripts/deepdesert.sh
grep -Fq 'restore_original_global_server_pve' runtime/scripts/deepdesert.sh
grep -Fq 'publish-deepdesert-overrides.sh stop' runtime/scripts/deepdesert.sh
grep -Fq 'require_empty_deepdesert' runtime/scripts/deepdesert.sh
grep -Fq 'runtime/scripts/start-director.sh' runtime/scripts/deepdesert.sh
if grep -Eq '^[[:space:]]*runtime/scripts/restart-director\.sh' runtime/scripts/deepdesert.sh; then
  echo "FAIL: Deep Desert layout still uses the Director recovery path that restarts Hagga Basin" >&2
  exit 1
fi
enable_body="$(awk '/^enable_layout\(\)/,/^enable_dual\(\)/' runtime/scripts/deepdesert.sh)"
for expected in \
  'ensure_partitions "$count"' \
  'configure_sietch_dimensions "$count"' \
  'apply_partition_labels "$count" "$third_role"' \
  'write_director_override "$count" "$original_display_name" "$third_role"' \
  'apply_usergame "$count" "$third_role"' \
  'restart_director_if_running' \
  'activate_sietch_dimensions "$count"'
do
  grep -Fq "$expected" <<< "$enable_body"
done
python3 - "$enable_body" <<'PY'
import sys

body = sys.argv[1]
ordered = [
    'ensure_partitions "$count"',
    'configure_sietch_dimensions "$count"',
    'apply_partition_labels "$count" "$third_role"',
    'write_director_override "$count" "$original_display_name" "$third_role"',
    'apply_usergame "$count" "$third_role" "$previous_partition_ids" "$previous_count" "$previous_third_role"',
    'restart_director_if_running',
    'activate_sietch_dimensions "$count"',
    'prime_changed_dynamic_deepdesert_roles "$count" "$third_role" "$previous_partition_ids" "$previous_count" "$previous_third_role"',
]
positions = [body.index(token) for token in ordered]
if positions != sorted(positions):
    raise SystemExit("Deep Desert configuration is not persisted before activation")
PY
grep -Fq 'prune_sietch_dimension_config "$target" "${removed_ids[@]}"' runtime/scripts/deepdesert.sh
grep -Fq 'Deep Desert Layout' console/web/src/features/maps/MapsPanel.tsx
grep -Fq '([1, 2, 3] as const)' console/web/src/features/maps/MapsPanel.tsx
grep -Fq 'Third Instance' console/web/src/features/maps/MapsPanel.tsx

echo "PASS: Triple Deep Desert layout is bounded, persisted, backed up, and represented in the Console"
