#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

OVERRIDE_FILE="${DUNE_DEEPDESERT_OVERRIDE_FILE:-runtime/generated/director-deepdesert-dual.ini}"

usage() {
  cat <<'EOF'
Usage:
  dune deepdesert layout status
  dune deepdesert layout configured
  dune deepdesert layout set <1|2|3> [--third-role <pve|pvp>] [--yes] [--force]
  dune deepdesert layout repair
  dune deepdesert dual status
  dune deepdesert dual configured
  dune deepdesert dual enable [--yes]
  dune deepdesert dual disable [--force] [--no-despawn] [--yes]
  dune deepdesert dual bootstrap [--yes]
  dune deepdesert dual repair
EOF
}

configured_instance_count() {
  local extras
  if [ -s "$OVERRIDE_FILE" ]; then
    extras="$(sed -n 's/^NumExtraServers=\([0-9][0-9]*\)[[:space:]]*$/\1/p' "$OVERRIDE_FILE" | tail -n1)"
    if [[ "${extras:-}" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$((extras + 1))"
      return 0
    fi
  fi
  echo 1
}

layout_configured() {
  local count
  count="$(configured_instance_count)"
  [ "$count" -ge 1 ] && [ "$count" -le 3 ]
}

dual_configured() {
  [ "$(configured_instance_count)" -ge 2 ]
}

require_postgres() {
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres; then
    echo "dune-postgres is not running."
    exit 1
  fi
}

confirm() {
  local prompt="$1" answer
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  read -r -p "$prompt [y/N]: " answer
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

psql() {
  docker exec dune-postgres psql -U postgres -d dune "$@"
}

psql_value() {
  docker exec dune-postgres psql -U postgres -d dune -At -c "$1"
}

deepdesert_mode() {
  if [ -x runtime/scripts/map-modes.sh ]; then
    runtime/scripts/map-modes.sh mode DeepDesert_1 2>/dev/null | awk '{print $2}'
  else
    echo "dynamic"
  fi
}

recycle_idle_deepdesert_servers() {
  local existing_partition_ids="${1:-}" rows partition_id server_id connected_players mode
  [ -n "$existing_partition_ids" ] || return 0
  mode="$(deepdesert_mode)"
  rows="$(docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
    select
      wp.partition_id,
      coalesce(wp.server_id, ''),
      coalesce(fs.connected_players, 0)
    from dune.world_partition wp
    left join dune.farm_state fs on fs.server_id = wp.server_id
    where wp.map = 'DeepDesert_1'
      and coalesce(wp.server_id, '') <> ''
    order by wp.dimension_index, wp.partition_id;
  " 2>/dev/null || true)"

  [ -n "$rows" ] || return 0

  while IFS='|' read -r partition_id server_id connected_players; do
    [ -n "${partition_id:-}" ] || continue
    grep -Fxq "$partition_id" <<< "$existing_partition_ids" || continue
    if [ "${connected_players:-0}" != "0" ]; then
      echo "Skipping DeepDesert_1 partition $partition_id recycle because connected_players=$connected_players."
      continue
    fi
    if [ "$mode" = "dynamic" ]; then
      echo "Despawning idle dynamic DeepDesert_1 partition $partition_id so it remains offline until player demand."
      runtime/scripts/despawn-server.sh "$partition_id" --force >/dev/null
      continue
    fi
    echo "Recycling idle DeepDesert_1 partition $partition_id so it republishes fresh state..."
    runtime/scripts/despawn-server.sh "$partition_id" --force >/dev/null
    runtime/scripts/spawn-server.sh "$partition_id" >/dev/null
  done <<< "$rows"
}

despawn_idle_dynamic_deepdesert_servers() {
  local mode rows partition_id server_id connected_players
  mode="$(deepdesert_mode)"
  [ "$mode" = "dynamic" ] || return 0
  rows="$(docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
    select
      wp.partition_id,
      coalesce(wp.server_id, ''),
      coalesce(fs.connected_players, 0)
    from dune.world_partition wp
    left join dune.farm_state fs on fs.server_id = wp.server_id
    where wp.map = 'DeepDesert_1'
      and coalesce(wp.server_id, '') <> ''
    order by wp.dimension_index, wp.partition_id;
  " 2>/dev/null || true)"
  [ -n "$rows" ] || return 0

  while IFS='|' read -r partition_id server_id connected_players; do
    [ -n "${partition_id:-}" ] || continue
    [ -n "$(printf '%s' "${server_id:-}" | tr -d '[:space:]')" ] || continue
    if [ "${connected_players:-0}" != "0" ]; then
      echo "Skipping DeepDesert_1 partition $partition_id cleanup because connected_players=$connected_players."
      continue
    fi
    echo "Despawning idle dynamic DeepDesert_1 partition $partition_id after dual-mode change."
    runtime/scripts/despawn-server.sh "$partition_id" --force >/dev/null
  done <<< "$rows"
}

restart_director_if_running() {
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-director; then
    echo "Reloading dune-director so DeepDesert_1 config changes take effect..."
    # Deep Desert instances are recycled below and therefore register with the
    # replacement Director themselves. Do not use restart-director.sh here: its
    # general recovery path also restarts Survival_1, which would disconnect
    # every Hagga Basin player for a Deep Desert-only configuration change.
    runtime/scripts/start-director.sh >/dev/null
    echo "dune-director restarted."
  else
    echo "dune-director is not running. The new DeepDesert_1 config will apply on next start."
  fi
}

status_dual() {
  local pvp pve primary state_json single_state override_state max_dimensions active_dimensions configured_count
  require_postgres
  configured_count="$(configured_instance_count)"
  pvp="$(pvp_partition_id)"
  pve="$(pve_partition_id)"
  max_dimensions="$(python3 - <<'PY'
import json
from pathlib import Path

path = Path("runtime/generated/sietch-config.json")
if not path.exists():
    print("")
    raise SystemExit
data = json.loads(path.read_text())
cfg = data.get("maps", {}).get("DeepDesert_1", {})
print(cfg.get("max_dimensions", ""))
PY
)"
  active_dimensions="$(python3 - <<'PY'
import json
from pathlib import Path

path = Path("runtime/generated/sietch-config.json")
if not path.exists():
    print("")
    raise SystemExit
data = json.loads(path.read_text())
cfg = data.get("maps", {}).get("DeepDesert_1", {})
print(cfg.get("active_dimensions", ""))
PY
)"
  echo "=== DeepDesert_1 partitions ==="
  psql -P pager=off -c "
    select
      wp.dimension_index,
      wp.partition_id,
      coalesce(wp.label, '') as label,
      coalesce(wp.server_id, '') as server_id,
      coalesce(fs.alive::text, '') as alive,
      coalesce(fs.ready::text, '') as ready
    from dune.world_partition wp
    left join dune.farm_state fs on fs.server_id = wp.server_id
    where wp.map = 'DeepDesert_1'
    order by wp.dimension_index, wp.partition_id;
  "
  echo
  if [ -n "$pvp" ]; then
    if [ -s "$OVERRIDE_FILE" ]; then
      override_state="present"
    elif [ -f runtime/director/config/director_config.ini ] && grep -q '^\[DeepDesert_1\]$' runtime/director/config/director_config.ini && grep -q "^NumExtraServers=$((configured_count - 1))$" runtime/director/config/director_config.ini; then
      override_state="loaded into current director config"
    else
      override_state="missing"
    fi
    echo "Director override: $override_state"
    echo "Expected override: NumExtraServers=$((configured_count - 1)) and MinServers=0 for DeepDesert_1"
  elif dual_configured; then
    echo "Director override: present"
    echo "Deep Desert layout status: repair required (one or more managed dimensions are missing)"
    echo "The next battlegroup start will restore the missing dimension automatically."
  else
    echo "Director override: not configured yet"
    echo "Deep Desert layout: Single"
  fi
  echo
  echo "Configured dimensions: max=${max_dimensions:-unset} active=${active_dimensions:-unset}"
  if [ -z "$pvp" ] || [ -z "$pve" ]; then
    if dual_configured; then
      echo "Selector configuration: unavailable until the missing Deep Desert partition is repaired."
    else
      primary="$(primary_partition_id)"
      state_json="$(python3 runtime/scripts/usersettings.py partition-combat-states DeepDesert_1 "$primary" 2>/dev/null || true)"
      single_state="$(printf '%s' "$state_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((p.get("configuredState", "") for p in d.get("partitions", []) if p.get("partitionId") == sys.argv[1]), ""))' "$primary" 2>/dev/null || true)"
      echo "Single Deep Desert configuration: partition ${primary:-unavailable} is ${single_state:-UNKNOWN}."
    fi
    return 0
  fi

  echo "Selector configuration: partition $pvp is explicitly PvP; partition $pve is PvE. Roles are preserved across repair."
  echo
  echo "Configured UserGame PvP/PvE partition rows:"
  if [ -n "$pvp" ]; then
    echo "PvP partition $pvp:"
    python3 runtime/scripts/usersettings.py partition-values DeepDesert_1 "$pvp" 2>/dev/null | grep -E 'partition_pvp_enabled|partition_pve_enabled|force_pvp_all_partitions' || true
  fi
  if [ -n "$pve" ]; then
    echo
    echo "PvE partition $pve:"
    python3 runtime/scripts/usersettings.py partition-values DeepDesert_1 "$pve" 2>/dev/null | grep -E 'partition_pvp_enabled|partition_pve_enabled|force_pvp_all_partitions' || true
  fi
}

configure_sietch_dimensions() {
  local count="$1"
  runtime/scripts/sietches.sh set-max DeepDesert_1 "$count" >/dev/null
  echo "DeepDesert_1 maximum dimensions set to $count."
}

activate_sietch_dimensions() {
  local count="$1"
  runtime/scripts/sietches.sh set-active DeepDesert_1 "$count" >/dev/null
  echo "DeepDesert_1 active/max dimensions set to $count."
}

running_deepdesert_partition_ids() {
  psql_value "
    select partition_id
    from dune.world_partition
    where map = 'DeepDesert_1'
      and coalesce(server_id, '') <> ''
    order by dimension_index, partition_id;
  "
}

require_empty_deepdesert() {
  local connected
  connected="$(psql_value "
    select coalesce(sum(coalesce(fs.connected_players, 0)), 0)
    from dune.world_partition wp
    left join dune.farm_state fs on fs.server_id = wp.server_id
    where wp.map = 'DeepDesert_1';
  " | tr -d '[:space:]')"
  connected="${connected:-0}"
  if [ "$connected" != "0" ]; then
    echo "Cannot change the Deep Desert layout while $connected player(s) are connected to Deep Desert instances." >&2
    echo "Hagga Basin does not need to restart. Wait for the Deep Desert instances to become empty and try again." >&2
    exit 1
  fi
}

reset_single_sietch_dimension() {
  runtime/scripts/sietches.sh set-active DeepDesert_1 1 >/dev/null 2>&1 || true
  runtime/scripts/sietches.sh set-max DeepDesert_1 1 >/dev/null 2>&1 || true
  echo "DeepDesert_1 active/max dimensions reset to 1."
}

prune_sietch_dimension_config() {
  local count="$1"
  shift || true
  python3 - runtime/generated/sietch-config.json "$count" "$@" <<'PY'
import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
count = int(sys.argv[2])
removed_partition_ids = set(sys.argv[3:])
if not path.exists():
    raise SystemExit(0)
data = json.loads(path.read_text(encoding="utf-8"))
map_config = data.get("maps", {}).get("DeepDesert_1", {})
dimensions = map_config.get("dimensions")
if isinstance(dimensions, dict):
    map_config["dimensions"] = {
        key: value for key, value in dimensions.items()
        if key.isdigit() and int(key) < count
    }
partitions = data.get("partitions")
if isinstance(partitions, dict):
    for partition_id in removed_partition_ids:
        partitions.pop(partition_id, None)
tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
tmp.replace(path)
PY
  chmod 600 runtime/generated/sietch-config.json 2>/dev/null || true
}

primary_partition_id() {
  psql_value "
    select partition_id
    from dune.world_partition
    where map = 'DeepDesert_1' and dimension_index = 0
    order by partition_id
    limit 1;
  " | tr -d '[:space:]'
}

secondary_partition_id() {
  psql_value "
    select partition_id
    from dune.world_partition
    where map = 'DeepDesert_1' and dimension_index = 1
    order by partition_id
    limit 1;
  " | tr -d '[:space:]'
}

partition_id_for_dimension() {
  local dimension="$1"
  psql_value "
    select partition_id
    from dune.world_partition
    where map = 'DeepDesert_1' and dimension_index = $dimension
    order by partition_id
    limit 1;
  " | tr -d '[:space:]'
}

deepdesert_partition_ids() {
  psql_value "
    select partition_id
    from dune.world_partition
    where map = 'DeepDesert_1'
    order by dimension_index, partition_id;
  "
}

primary_display_name() {
  local primary values
  primary="$(primary_partition_id)"
  [ -n "$primary" ] || return 0
  values="$(python3 runtime/scripts/usersettings.py partition-engine-values DeepDesert_1 "$primary" 2>/dev/null || true)"
  printf '%s' "$values" | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data.get("server_display_name", ""))' 2>/dev/null || true
}

managed_primary_display_name() {
  local encoded
  [ -f "$OVERRIDE_FILE" ] || return 0
  encoded="$(sed -n 's/^; ManagedPrimaryDisplayNameBase64=//p' "$OVERRIDE_FILE" | tail -n1)"
  [ -n "$encoded" ] || return 0
  printf '%s' "$encoded" | base64 -d 2>/dev/null || true
}

managed_third_role() {
  local role
  [ -f "$OVERRIDE_FILE" ] || { echo pve; return 0; }
  role="$(sed -n 's/^; ManagedThirdRole=//p' "$OVERRIDE_FILE" | tail -n1 | tr '[:upper:]' '[:lower:]')"
  case "$role" in
    pvp) echo pvp ;;
    *) echo pve ;;
  esac
}

pve_partition_id() {
  local primary secondary pvp
  primary="$(primary_partition_id)"
  secondary="$(secondary_partition_id)"
  [ -n "$secondary" ] || return 0
  pvp="$(pvp_partition_id)"
  if [ "$pvp" = "$primary" ]; then
    printf '%s\n' "$secondary"
  else
    printf '%s\n' "$primary"
  fi
}

pvp_partition_id() {
  local primary secondary managed state_json primary_state
  primary="$(primary_partition_id)"
  secondary="$(secondary_partition_id)"
  [ -n "$secondary" ] || return 0

  # Once enabled, the generated override is the durable source of truth. This
  # prevents startup repair from flipping the pair after the selector itself
  # changes the effective state of the previously unlisted partition.
  managed="$(managed_selector_from_override ManagedPvpPartition)"
  if [ "$managed" = "$primary" ] || [ "$managed" = "$secondary" ]; then
    printf '%s\n' "$managed"
    return 0
  fi

  # On first enable, preserve the existing dimension-0 role. If it was PvP,
  # keep it PvP and make the new dimension PvE. Otherwise keep it PvE and make
  # the new dimension PvP. Ambiguous/unknown configurations use the safe PvE
  # primary + PvP secondary default.
  state_json="$(python3 runtime/scripts/usersettings.py partition-combat-states DeepDesert_1 "$primary" "$secondary" 2>/dev/null || true)"
  primary_state="$(printf '%s' "$state_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((p.get("configuredState", "") for p in d.get("partitions", []) if p.get("partitionId") == sys.argv[1]), ""))' "$primary" 2>/dev/null || true)"
  if [ "$primary_state" = "PVP" ]; then
    printf '%s\n' "$primary"
  else
    printf '%s\n' "$secondary"
  fi
}

extra_deepdesert_partition_rows() {
  psql_value "
    select wp.partition_id || '|' || wp.dimension_index || '|' || coalesce(wp.server_id, '') || '|' || coalesce(fs.connected_players, 0)
    from dune.world_partition wp
    left join dune.farm_state fs on fs.server_id = wp.server_id
    where wp.map = 'DeepDesert_1'
      and wp.dimension_index > 0
    order by wp.dimension_index, wp.partition_id;
  "
}

apply_partition_labels() {
  local count="$1" third_role="${2:-pve}" pvp pve third pvp_label pve_label third_label
  pvp="$(pvp_partition_id)"
  pve="$(pve_partition_id)"
  [ -n "$pvp" ] && [ -n "$pve" ] || { echo "Could not resolve Deep Desert PvP/PvE roles."; exit 1; }
  third="$(partition_id_for_dimension 2)"
  pvp_label="PvP"
  pve_label="PvE"
  third_label="PvE 2"
  if [ "$count" -ge 3 ]; then
    if [ "$third_role" = "pvp" ]; then
      pvp_label="PvP 1"
      third_label="PvP 2"
    else
      pve_label="PvE 1"
    fi
  fi
  psql -v ON_ERROR_STOP=1 -c "
-- Labels are globally unique. Move every managed row through a partition-specific temporary label so
-- reversing an existing PvP/PvE pair cannot hit a transient duplicate-key violation.
update dune.world_partition
set label = 'ManagedDeepDesert_' || partition_id::text
where map = 'DeepDesert_1'
  and dimension_index < $count;

update dune.world_partition
set label = case
  when partition_id = $pve then '$pve_label'
  when partition_id = $pvp then '$pvp_label'
  when partition_id = ${third:-0} then '$third_label'
  else label
end
where map = 'DeepDesert_1'
  and dimension_index < $count;
" >/dev/null
}

ensure_partitions() {
  local count="$1" primary
  primary="$(primary_partition_id)"
  if [ -z "$primary" ]; then
    echo "Could not find existing DeepDesert_1 dimension 0 partition."
    exit 1
  fi

  echo "Ensuring DeepDesert_1 has $count managed dimension(s), using partition $primary as the template."
  psql -v ON_ERROR_STOP=1 -c "
do \$\$
declare
  next_id bigint;
  target_dimension integer;
begin
  perform set_config('search_path', 'dune,public', true);
  for target_dimension in 1..$((count - 1)) loop
    if not exists (
      select 1 from dune.world_partition
      where map = 'DeepDesert_1' and dimension_index = target_dimension
    ) then
      select nextval('dune.world_partition_partition_id_seq') into next_id;
      insert into dune.world_partition (
        partition_id, server_id, map, partition_definition, dimension_index, blocked, label
      )
      select
        next_id, null, map, partition_definition, target_dimension, false,
        'ManagedDeepDesert_' || next_id::text
      from dune.world_partition
      where map = 'DeepDesert_1' and dimension_index = 0
      order by partition_id
      limit 1;
    end if;
  end loop;

  perform dune.update_partition_labels(true);
  update dune.world_partition
  set label = 'ManagedDeepDesert_' || partition_id::text
  where map = 'DeepDesert_1'
    and dimension_index < $count;
end
\$\$;
"
  runtime/scripts/extract-partition-catalog.sh >/dev/null 2>&1 || true
}

write_director_override() {
  local count="$1" original_display_name="$2" third_role="${3:-pve}" original_global_server_pve="${4:-True}" pvp pve ids encoded_display_name
  pvp="$(pvp_partition_id)"
  pve="$(pve_partition_id)"
  ids="$(deepdesert_partition_ids | paste -sd, -)"
  encoded_display_name="$(printf '%s' "$original_display_name" | base64 | tr -d '\r\n')"
  [ -n "$pvp" ] || { echo "Missing DeepDesert_1 PvP partition."; exit 1; }
  [ -n "$pve" ] || { echo "Missing DeepDesert_1 PvE partition."; exit 1; }
  mkdir -p "$(dirname "$OVERRIDE_FILE")"
  cat > "$OVERRIDE_FILE" <<EOF
; ManagedPvpPartition=$pvp
; ManagedPvePartition=$pve
; ManagedPartitionIds=$ids
; ManagedInstanceCount=$count
; ManagedThirdRole=$third_role
; ManagedPrimaryDisplayNameBase64=$encoded_display_name
; ManagedOriginalGlobalServerPVE=$original_global_server_pve

[DeepDesert_1]
NumExtraServers=$((count - 1))
MinServers=0
EOF
  echo "Director DeepDesert_1 override written: $OVERRIDE_FILE"
}

managed_selector_from_override() {
  local key="$1"
  [ -f "$OVERRIDE_FILE" ] || return 0
  sed -n "s/^; ${key}=\([0-9][0-9]*\)$/\1/p" "$OVERRIDE_FILE" | head -n1
}

managed_partition_ids_from_override() {
  [ -f "$OVERRIDE_FILE" ] || return 0
  sed -n 's/^; ManagedPartitionIds=//p' "$OVERRIDE_FILE" | tail -n1 | tr ',' '\n' | grep -E '^[0-9]+$' || true
}

managed_original_global_server_pve() {
  [ -f "$OVERRIDE_FILE" ] || return 0
  sed -n 's/^; ManagedOriginalGlobalServerPVE=\(True\|False\)$/\1/p' "$OVERRIDE_FILE" | tail -n1
}

current_global_server_pve() {
  python3 runtime/scripts/usersettings.py global-values 2>/dev/null \
    | awk -F '\t' '$1 == "server_pve" { print $2; exit }'
}

restore_original_global_server_pve() {
  local original
  original="$(managed_original_global_server_pve)"
  [ "$original" = "True" ] || [ "$original" = "False" ] || return 0
  python3 runtime/scripts/usersettings.py map-set Global server_pve "$original"
}

remove_dual_usergame_selectors() {
  local pvp="$1" pve="$2"
  # Remove only the exact values recorded by this toggle. The managed override retains
  # those IDs even if a partial/manual cleanup removed the dimension-1 database row first.
  while IFS= read -r partition_id; do
    [ -n "$partition_id" ] || continue
    python3 runtime/scripts/usersettings.py map-set Global global_pvp_enabled_partition_remove "$partition_id" >/dev/null 2>&1 || true
    # Remove legacy explicit-PvE selectors written by older Dual Deep Desert releases.
    python3 runtime/scripts/usersettings.py map-set Global global_pve_enabled_partition_remove "$partition_id" >/dev/null 2>&1 || true
  done < <(printf '%s\n' "$pvp" "$pve"; managed_partition_ids_from_override; deepdesert_partition_ids | sort -u)
  python3 runtime/scripts/usersettings.py map-unset DeepDesert_1 force_pvp_all_partitions >/dev/null 2>&1 || true
  python3 runtime/scripts/usersettings.py map-unset Global force_pvp_all_partitions >/dev/null 2>&1 || true
  python3 runtime/scripts/usersettings.py dual-deepdesert-matchmaker disable >/dev/null 2>&1 || true
  python3 runtime/scripts/usersettings.py materialize-current >/dev/null || true
}

apply_usergame() {
  local count="$1" third_role="${2:-pve}" pvp pve third partition_id partition_role pvp_name pve_name third_name
  pvp="$(pvp_partition_id)"
  pve="$(pve_partition_id)"
  third="$(partition_id_for_dimension 2)"
  [ -n "$pvp" ] || { echo "Missing DeepDesert_1 PvP partition."; exit 1; }
  [ -n "$pve" ] || { echo "Missing DeepDesert_1 PvE partition."; exit 1; }
  pvp_name="Deep Desert PvP"
  pve_name="Deep Desert PvE"
  third_name="Deep Desert PvE 2"
  if [ "$count" -ge 3 ]; then
    if [ "$third_role" = "pvp" ]; then
      pvp_name="Deep Desert PvP 1"
      third_name="Deep Desert PvP 2"
    else
      pve_name="Deep Desert PvE 1"
    fi
  fi
  runtime/scripts/sietches.sh set-display "$pvp" "$pvp_name" >/dev/null
  runtime/scripts/sietches.sh set-display "$pve" "$pve_name" >/dev/null
  [ "$count" -ge 3 ] && [ -n "$third" ] && runtime/scripts/sietches.sh set-display "$third" "$third_name" >/dev/null
  # Match the configuration verified against Funcom's Kanly selector: both the defensive
  # force-all flag and the one explicit PvP partition selector must be Global. The partition
  # omitted from that selector is PvE. Roles are persisted in the managed override so repairs
  # remain stable and first-time enablement can preserve dimension 0's pre-existing role.
  python3 runtime/scripts/usersettings.py map-unset DeepDesert_1 force_pvp_all_partitions
  while IFS= read -r partition_id; do
    [ -n "$partition_id" ] || continue
    python3 runtime/scripts/usersettings.py map-set Global global_pvp_enabled_partition_remove "$partition_id"
    python3 runtime/scripts/usersettings.py map-set Global global_pve_enabled_partition_remove "$partition_id"
    partition_role="pve"
    if [ "$partition_id" = "$pvp" ] || { [ "$count" -ge 3 ] && [ "$third_role" = "pvp" ] && [ "$partition_id" = "$third" ]; }; then
      partition_role="pvp"
    fi
    # The selector arrays control routing, while these partition-scoped values
    # control the role advertised by each game server in SELECT INSTANCE. Keep
    # both representations synchronized; otherwise newly-created partitions
    # inherit the template's PvE badge even though matchmaking routes them as
    # PvP.
    if [ "$partition_role" = "pvp" ]; then
      python3 runtime/scripts/usersettings.py partition-set DeepDesert_1 "$partition_id" partition_pvp_enabled True
      python3 runtime/scripts/usersettings.py partition-set DeepDesert_1 "$partition_id" partition_pve_enabled False
      python3 runtime/scripts/usersettings.py partition-set DeepDesert_1 "$partition_id" legacy_pvp_enabled True
      python3 runtime/scripts/usersettings.py partition-set DeepDesert_1 "$partition_id" server_pve False
    else
      python3 runtime/scripts/usersettings.py partition-set DeepDesert_1 "$partition_id" partition_pvp_enabled False
      python3 runtime/scripts/usersettings.py partition-set DeepDesert_1 "$partition_id" partition_pve_enabled True
      python3 runtime/scripts/usersettings.py partition-set DeepDesert_1 "$partition_id" legacy_pvp_enabled False
      python3 runtime/scripts/usersettings.py partition-set DeepDesert_1 "$partition_id" server_pve True
    fi
  done < <(deepdesert_partition_ids)
  # Funcom's Kanly selector ignores m_PvpEnabledPartitions while the
  # battlegroup is globally locked to PvE. Mixed Deep Desert layouts must put
  # the battlegroup in mixed-mode compatibility and then assign every Deep
  # Desert partition explicitly above. Partitions not in the PvP selector
  # remain PvE, matching the working Funcom/Kovalt configuration.
  python3 runtime/scripts/usersettings.py map-set Global server_pve False
  python3 runtime/scripts/usersettings.py map-set Global force_pvp_all_partitions False
  python3 runtime/scripts/usersettings.py map-set Global global_pvp_enabled_partition_add "$pvp"
  if [ "$count" -ge 3 ] && [ "$third_role" = "pvp" ] && [ -n "$third" ]; then
    python3 runtime/scripts/usersettings.py map-set Global global_pvp_enabled_partition_add "$third"
  fi
  python3 runtime/scripts/usersettings.py dual-deepdesert-matchmaker enable
  python3 runtime/scripts/usersettings.py materialize-current >/dev/null || true
  echo "UserGame PvP/PvE settings applied. Primary PvE partition: $pve. PvP partition: $pvp."
  echo "Global UserGame now uses m_bShouldForceEnablePvpOnAllPartitions=False and +m_PvpEnabledPartitions=$pvp; no explicit PvE selector is required."
  echo "Deep Desert matchmaking now uses SelectionRule=HomeDimension so the selected PvP/PvE instance reaches the matching partition."
}

enable_layout() {
  local count="$1" third_role="${2:-pve}" original_display_name original_global_server_pve existing_partition_ids
  require_postgres
  require_empty_deepdesert
  existing_partition_ids="$(running_deepdesert_partition_ids)"
  if [ -s "$OVERRIDE_FILE" ]; then
    original_display_name="$(managed_primary_display_name)"
    original_global_server_pve="$(managed_original_global_server_pve)"
  else
    original_display_name="$(primary_display_name)"
  fi
  if [ "$original_global_server_pve" != "True" ] && [ "$original_global_server_pve" != "False" ]; then
    original_global_server_pve="$(current_global_server_pve)"
  fi
  [ "$original_global_server_pve" = "False" ] || original_global_server_pve="True"
  ensure_partitions "$count"
  # Persist every label, role, and Director setting before a newly-added
  # dimension is allowed to spawn. Previously set-active ran first, allowing
  # the third process to boot with the template's stale PvE/default settings.
  configure_sietch_dimensions "$count"
  apply_partition_labels "$count" "$third_role"
  write_director_override "$count" "$original_display_name" "$third_role" "$original_global_server_pve"
  apply_usergame "$count" "$third_role"
  restart_director_if_running
  # The synthetic single-instance warm-up state cannot encode different
  # per-partition Kanly roles. Managed multi-instance layouts always use the
  # game servers' native advertisements instead.
  runtime/scripts/publish-deepdesert-overrides.sh stop >/dev/null 2>&1 || true
  activate_sietch_dimensions "$count"
  recycle_idle_deepdesert_servers "$existing_partition_ids"
  despawn_idle_dynamic_deepdesert_servers
  echo
  echo "Deep Desert layout now has $count managed instances."
  echo "The third instance is configured as ${third_role^^}."
  echo "Players should see $count Deep Desert instances when the client enters the SELECT INSTANCE flow."
  echo "Run bootstrap once if players are still routed back to only dimension 0."
}

enable_dual() {
  local count third_role
  count="$(configured_instance_count)"
  third_role="$(managed_third_role)"
  [ "$count" -ge 2 ] || count=2
  enable_layout "$count" "$third_role"
}

create_layout_safety_backup() {
  echo "Creating a safety backup before changing the Deep Desert layout..."
  DB_BACKUP_ORIGIN=restore-safety runtime/scripts/db.sh backup >/dev/null
  echo "Safety backup created."
}

remove_layout_dimensions() {
  local target="$1" force="${2:-0}" rows partition_id dimension_index server_id connected_players assigned mode
  local removed_ids=()
  rows="$(psql_value "
    select wp.partition_id || '|' || wp.dimension_index || '|' || coalesce(wp.server_id, '') || '|' || coalesce(fs.connected_players, 0)
    from dune.world_partition wp
    left join dune.farm_state fs on fs.server_id = wp.server_id
    where wp.map = 'DeepDesert_1' and wp.dimension_index >= $target
    order by wp.dimension_index desc, wp.partition_id;
  ")"
  [ -n "$rows" ] || return 0

  while IFS='|' read -r partition_id dimension_index server_id connected_players; do
    [ -n "${partition_id:-}" ] || continue
    if [ "${connected_players:-0}" != "0" ]; then
      echo "Cannot remove Deep Desert instance $((dimension_index + 1)): $connected_players player(s) are connected."
      exit 1
    fi
    assigned="$(printf '%s' "${server_id:-}" | tr -d '[:space:]')"
    if [ -n "$assigned" ]; then
      if [ "$force" != "1" ]; then
        echo "Deep Desert partition $partition_id must be stopped before it can be removed."
        exit 1
      fi
      if [ -x runtime/scripts/map-modes.sh ]; then
        mode="$(runtime/scripts/map-modes.sh mode DeepDesert_1 2>/dev/null | awk '{print $2}' || true)"
        if [ "$mode" = "always-on" ]; then
          echo "DeepDesert_1 is Always On; switching it to Dynamic before reducing the layout."
          runtime/scripts/map-modes.sh set DeepDesert_1 dynamic >/dev/null 2>&1 || true
        fi
      fi
      runtime/scripts/despawn-server.sh "$partition_id" --force
    fi
    removed_ids+=("$partition_id")
  done <<< "$rows"

  for partition_id in "${removed_ids[@]}"; do
    python3 runtime/scripts/usersettings.py map-set Global global_pvp_enabled_partition_remove "$partition_id" >/dev/null 2>&1 || true
    python3 runtime/scripts/usersettings.py map-set Global global_pve_enabled_partition_remove "$partition_id" >/dev/null 2>&1 || true
    psql -v ON_ERROR_STOP=1 -c "delete from dune.world_partition where partition_id = $partition_id and map = 'DeepDesert_1'; drop table if exists dune.event_log_p${partition_id};" >/dev/null
  done
  prune_sietch_dimension_config "$target" "${removed_ids[@]}"
}

set_layout() {
  local target="$1" force="${2:-0}" third_role="${3:-pve}" current current_third_role
  [[ "$target" =~ ^[123]$ ]] || { echo "Deep Desert instance count must be 1, 2, or 3."; exit 2; }
  [[ "$third_role" =~ ^(pve|pvp)$ ]] || { echo "Third Deep Desert role must be pve or pvp."; exit 2; }
  require_postgres
  current="$(psql_value "select greatest(1, count(*)) from dune.world_partition where map = 'DeepDesert_1';" | tr -d '[:space:]')"
  current_third_role="$(managed_third_role)"
  if [ "$target" = "$current" ] && { [ "$target" = "1" ] || { [ "$(configured_instance_count)" = "$target" ] && { [ "$target" != "3" ] || [ "$third_role" = "$current_third_role" ]; }; }; }; then
    echo "Deep Desert layout already has $target instance(s)."
    return 0
  fi
  if ! confirm "Change the Deep Desert layout from $current to $target instance(s)?"; then
    echo "Cancelled."
    return 0
  fi
  # Validate before backups, partition deletion, or any other mutation. A
  # layout change needs fresh Deep Desert processes, but must never disconnect
  # players or involve Hagga Basin to achieve that.
  require_empty_deepdesert
  if [ "$target" -lt "$current" ]; then
    create_layout_safety_backup
    remove_layout_dimensions "$target" "$force"
  fi
  if [ "$target" = "1" ]; then
    local pvp pve primary original_display_name
    pvp="$(managed_selector_from_override ManagedPvpPartition)"
    pve="$(managed_selector_from_override ManagedPvePartition)"
    primary="$(primary_partition_id)"
    original_display_name="$(managed_primary_display_name)"
    remove_dual_usergame_selectors "$pvp" "$pve"
    restore_original_global_server_pve
    [ -n "$primary" ] && runtime/scripts/sietches.sh set-display "$primary" "$original_display_name" >/dev/null
    rm -f "$OVERRIDE_FILE"
    reset_single_sietch_dimension
    restart_director_if_running
    despawn_idle_dynamic_deepdesert_servers
    echo "Deep Desert layout restored to a single instance."
    return 0
  fi
  enable_layout "$target" "$third_role"
}

disable_dual() {
  local force="${1:-0}" no_despawn="${2:-0}" pvp pve assigned mode
  local rows row partition_id dimension_index server_id connected_players

  require_postgres

  if [ "$force" = "1" ] && [ "$no_despawn" = "1" ]; then
    echo "--force and --no-despawn cannot be used together."
    exit 2
  fi

  pvp="$(pvp_partition_id)"
  pve="$(pve_partition_id)"
  [ -n "$pvp" ] || pvp="$(managed_selector_from_override ManagedPvpPartition)"
  [ -n "$pve" ] || pve="$(managed_selector_from_override ManagedPvePartition)"

  rows="$(extra_deepdesert_partition_rows)"
  [ -n "$rows" ] || {
    echo "No extra DeepDesert_1 dimensions are present."
    remove_dual_usergame_selectors "$pvp" "$pve"
    restore_original_global_server_pve
    rm -f "$OVERRIDE_FILE"
    reset_single_sietch_dimension
    restart_director_if_running
    despawn_idle_dynamic_deepdesert_servers
    return 0
  }

  while IFS='|' read -r partition_id dimension_index server_id connected_players; do
    [ -n "${partition_id:-}" ] || continue
    if [ "${connected_players:-0}" != "0" ]; then
      echo "Disable is blocked because Deep Desert partition $partition_id has $connected_players connected player(s)."
      exit 1
    fi
    assigned="$(printf '%s' "${server_id:-}" | tr -d '[:space:]')"
    if [ -z "$assigned" ]; then
      continue
    fi

    echo "DeepDesert_1 extra partition $partition_id (dimension $dimension_index) is assigned to server: $assigned"

    if [ "$no_despawn" = "1" ]; then
      echo "Disable is blocked because --no-despawn was used."
      echo "Despawn it first with: dune despawn $partition_id"
      echo "Or rerun with: dune deepdesert dual disable --force"
      exit 1
    fi

    if [ "$force" != "1" ]; then
      if [ ! -t 0 ]; then
        echo "Disable needs to despawn partition $partition_id first, but this is not an interactive terminal."
        echo "Rerun with: dune deepdesert dual disable --force"
        exit 1
      fi

      echo
      echo "The extra Deep Desert partition must be despawned before it can be removed safely."
      if ! confirm "Despawn Deep Desert partition $partition_id now and continue disabling Dual Deep Desert?"; then
        echo "Cancelled. Dual Deep Desert PvP/PvE was not changed."
        return 0
      fi
    fi

    if [ -x runtime/scripts/map-modes.sh ]; then
      mode="$(runtime/scripts/map-modes.sh mode DeepDesert_1 2>/dev/null | awk '{print $2}' || true)"
      if [ "$mode" = "always-on" ]; then
        echo "DeepDesert_1 is configured Always On. Switching it back to Dynamic before disable..."
        runtime/scripts/map-modes.sh set DeepDesert_1 dynamic >/dev/null 2>&1 || true
      fi
    fi

    echo "Despawning Deep Desert partition $partition_id..."
    runtime/scripts/despawn-server.sh "$partition_id" --force

    assigned="$(psql_value "select coalesce(server_id, '') from dune.world_partition where partition_id = $partition_id limit 1;" | tr -d '[:space:]')"
    if [ -n "$assigned" ]; then
      echo "Partition $partition_id is still assigned after despawn cleanup. Disable aborted."
      echo "Remaining server_id: $assigned"
      exit 1
    fi

    echo "Assignment cleared for partition $partition_id."
  done <<< "$rows"

  if [ "$force" != "1" ]; then
    echo
    echo "This removes all extra DeepDesert_1 dimension rows and the generated dual-mode config override."
    if ! confirm "Continue disabling Dual Deep Desert PvP/PvE?"; then
      echo "Cancelled. Dual Deep Desert PvP/PvE was not changed."
      return 0
    fi
  fi

  echo "Removing DeepDesert_1 extra dimensions/config..."
  while IFS='|' read -r partition_id dimension_index server_id connected_players; do
    [ -n "${partition_id:-}" ] || continue
    psql -v ON_ERROR_STOP=1 -c "delete from dune.world_partition where partition_id = $partition_id and map = 'DeepDesert_1'; drop table if exists dune.event_log_p${partition_id};" >/dev/null
  done <<< "$rows"
  remove_dual_usergame_selectors "$pvp" "$pve"
  restore_original_global_server_pve
  rm -f "$OVERRIDE_FILE"
  reset_single_sietch_dimension
  restart_director_if_running
  despawn_idle_dynamic_deepdesert_servers
  echo "Dual Deep Desert PvP/PvE disabled."
  if [ -n "$pvp" ] || [ -n "$pve" ]; then
    echo "This removed the managed Global PvP/PvE settings for partitions ${pvp:-<unknown>} and ${pve:-<unknown>} -- matching manual Advanced Editor entries may have been affected by this toggle."
  fi
}

bootstrap_dual() {
  local primary container
  require_postgres
  primary="$(primary_partition_id)"
  [ -n "$primary" ] || { echo "DeepDesert_1 dimension 0 not found."; exit 1; }
  container="dune-server-deepdesert-1-$primary"
  if ! docker ps -a --format '{{.Names}}' | grep -qx "$container"; then
    container="$(docker ps -a --format '{{.Names}}' | grep -E "^dune-server-deepdesert-1-${primary}$" | head -n1 || true)"
  fi
  [ -n "$container" ] || { echo "No running dimension 0 DeepDesert_1 container found for partition $primary."; return 0; }
  echo "This removes only $container once. Survival_1 and Overmap are untouched."
  confirm "Bootstrap routing fix now" || { echo "Cancelled."; exit 1; }
  runtime/scripts/despawn-server.sh "$container" --force || docker rm -f "$container"
  echo "Bootstrap complete. Players may need about 3 minutes between Deep Desert instance switches due to Director grace routing."
}

cmd="${1:-help}"
case "$cmd" in
  layout)
    sub="${2:-status}"
    shift 2 || true
    ASSUME_YES=0
    FORCE=0
    THIRD_ROLE="pve"
    target=""
    if [ "$sub" = "set" ]; then
      target="${1:-}"
      [ -n "$target" ] && shift || true
    fi
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --yes|-y) ASSUME_YES=1; shift ;;
        --force) FORCE=1; shift ;;
        --third-role)
          [ "$#" -ge 2 ] || { echo "--third-role requires pve or pvp."; exit 2; }
          THIRD_ROLE="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
          shift 2
          ;;
        *) echo "Unknown option: $1"; exit 2 ;;
      esac
    done
    case "$sub" in
      status) status_dual ;;
      configured)
        if layout_configured; then
          echo "Deep Desert layout is configured for $(configured_instance_count) instance(s)."
        else
          echo "Deep Desert layout configuration is invalid."
          exit 1
        fi
        ;;
      set) set_layout "$target" "$FORCE" "$THIRD_ROLE" ;;
      repair)
        target="$(configured_instance_count)"
        if [ "$target" -le 1 ]; then
          prune_sietch_dimension_config 1
          echo "Single Deep Desert layout does not require repair."
        else
          enable_layout "$target" "$(managed_third_role)"
        fi
        ;;
      *) usage; exit 2 ;;
    esac
    ;;
  dual)
    sub="${2:-status}"
    shift 2 || true
    ASSUME_YES=0
    FORCE=0
    NO_DESPAWN=0
    for arg in "$@"; do
      case "$arg" in
        --yes|-y) ASSUME_YES=1 ;;
        --force) FORCE=1 ;;
        --no-despawn) NO_DESPAWN=1 ;;
        *) echo "Unknown option: $arg"; exit 2 ;;
      esac
    done
    case "$sub" in
      status) status_dual ;;
      configured)
        if dual_configured; then
          echo "Dual Deep Desert is configured."
        else
          echo "Dual Deep Desert is not configured."
          exit 1
        fi
        ;;
      enable|repair) enable_dual ;;
      disable) disable_dual "$FORCE" "$NO_DESPAWN" ;;
      bootstrap) bootstrap_dual ;;
      *) usage; exit 2 ;;
    esac
    ;;
  help|--help|-h) usage ;;
  *) usage; exit 2 ;;
esac
