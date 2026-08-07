#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

OVERRIDE_FILE="${DUNE_DEEPDESERT_OVERRIDE_FILE:-runtime/generated/director-deepdesert-dual.ini}"

usage() {
  cat <<'EOF'
Usage:
  dune deepdesert dual status
  dune deepdesert dual configured
  dune deepdesert dual enable [--yes]
  dune deepdesert dual disable [--force] [--no-despawn] [--yes]
  dune deepdesert dual bootstrap [--yes]
  dune deepdesert dual repair
EOF
}

dual_configured() {
  [ -s "$OVERRIDE_FILE" ] || return 1
  grep -Eq '^\[DeepDesert_1\][[:space:]]*$' "$OVERRIDE_FILE" \
    && grep -Eq '^NumExtraServers=[1-9][0-9]*[[:space:]]*$' "$OVERRIDE_FILE"
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
  local rows partition_id server_id connected_players mode
  RECYCLED_DEEPDESERT_SERVERS=0
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
    if [ "${connected_players:-0}" != "0" ]; then
      echo "Skipping DeepDesert_1 partition $partition_id recycle because connected_players=$connected_players."
      continue
    fi
    if [ "$mode" = "dynamic" ]; then
      echo "Despawning idle dynamic DeepDesert_1 partition $partition_id so it remains offline until player demand."
      runtime/scripts/despawn-server.sh "$partition_id" --force >/dev/null
      RECYCLED_DEEPDESERT_SERVERS=1
      continue
    fi
    echo "Recycling idle DeepDesert_1 partition $partition_id so it republishes fresh state..."
    runtime/scripts/despawn-server.sh "$partition_id" --force >/dev/null
    runtime/scripts/spawn-server.sh "$partition_id" >/dev/null
    RECYCLED_DEEPDESERT_SERVERS=1
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
    echo "Restarting dune-director so DeepDesert_1 config changes take effect..."
    runtime/scripts/restart-director.sh >/dev/null
    echo "dune-director restarted."
  else
    echo "dune-director is not running. The new DeepDesert_1 config will apply on next start."
  fi
}

status_dual() {
  local pvp pve primary state_json single_state override_state max_dimensions active_dimensions
  require_postgres
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
    elif [ -f runtime/director/config/director_config.ini ] && grep -q '^\[DeepDesert_1\]$' runtime/director/config/director_config.ini && grep -q '^NumExtraServers=1$' runtime/director/config/director_config.ini; then
      override_state="loaded into current director config"
    else
      override_state="missing"
    fi
    echo "Director override: $override_state"
    echo "Expected override: NumExtraServers=1 and MinServers=0 for DeepDesert_1"
  elif dual_configured; then
    echo "Director override: present"
    echo "Dual Deep Desert status: repair required (dimension 1 is missing)"
    echo "The next battlegroup start will restore the missing dimension automatically."
  else
    echo "Director override: not configured yet"
    echo "Dual Deep Desert status: disabled"
  fi
  echo
  echo "Configured dimensions: max=${max_dimensions:-unset} active=${active_dimensions:-unset}"
  if [ -z "$pvp" ] || [ -z "$pve" ]; then
    if dual_configured; then
      echo "Selector configuration: unavailable until the missing Dual Deep Desert partition is repaired."
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

ensure_dual_sietch_dimensions() {
  runtime/scripts/sietches.sh set-max DeepDesert_1 2 >/dev/null
  runtime/scripts/sietches.sh set-active DeepDesert_1 2 >/dev/null
  echo "DeepDesert_1 active/max dimensions set to 2."
}

reset_single_sietch_dimension() {
  runtime/scripts/sietches.sh set-active DeepDesert_1 1 >/dev/null 2>&1 || true
  runtime/scripts/sietches.sh set-max DeepDesert_1 1 >/dev/null 2>&1 || true
  echo "DeepDesert_1 active/max dimensions reset to 1."
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
    select partition_id || '|' || dimension_index || '|' || coalesce(server_id, '')
    from dune.world_partition
    where map = 'DeepDesert_1'
      and dimension_index > 0
    order by dimension_index, partition_id;
  "
}

apply_partition_labels() {
  local pvp pve
  pvp="$(pvp_partition_id)"
  pve="$(pve_partition_id)"
  [ -n "$pvp" ] && [ -n "$pve" ] || { echo "Could not resolve Deep Desert PvP/PvE roles."; exit 1; }
  psql -v ON_ERROR_STOP=1 -c "
-- Labels are globally unique. Move both rows through partition-specific temporary labels so
-- reversing an existing PvP/PvE pair cannot hit a transient duplicate-key violation.
update dune.world_partition
set label = 'DualDeepDesert_' || partition_id::text
where map = 'DeepDesert_1'
  and dimension_index in (0, 1);

update dune.world_partition
set label = case
  when partition_id = $pve then 'PvE'
  when partition_id = $pvp then 'PvP'
  else label
end
where map = 'DeepDesert_1'
  and dimension_index in (0, 1);
" >/dev/null
}

ensure_partition() {
  local existing primary
  primary="$(primary_partition_id)"
  if [ -z "$primary" ]; then
    echo "Could not find existing DeepDesert_1 dimension 0 partition."
    exit 1
  fi
  existing="$(secondary_partition_id)"
  if [ -n "$existing" ]; then
    echo "DeepDesert_1 dimension 1 already exists: partition $existing"
    return 0
  fi

  echo "Creating DeepDesert_1 dimension 1 by copying detected dimension 0 partition $primary."
  psql -v ON_ERROR_STOP=1 -c "
do \$\$
declare
  next_id bigint;
begin
  perform set_config('search_path', 'dune,public', true);
  select nextval('dune.world_partition_partition_id_seq') into next_id;

  insert into dune.world_partition (
    partition_id,
    server_id,
    map,
    partition_definition,
    dimension_index,
    blocked,
    label
  )
  select
    next_id,
    null,
    map,
    partition_definition,
    1,
    false,
    'DualDeepDesert_' || next_id::text
  from dune.world_partition
  where map = 'DeepDesert_1' and dimension_index = 0
  order by partition_id
  limit 1;

  perform dune.update_partition_labels(true);
  update dune.world_partition
  set label = 'DualDeepDesert_' || partition_id::text
  where map = 'DeepDesert_1'
    and dimension_index in (0, 1);
end
\$\$;
"
  runtime/scripts/extract-partition-catalog.sh >/dev/null 2>&1 || true
}

write_director_override() {
  local pvp pve
  pvp="$(pvp_partition_id)"
  pve="$(pve_partition_id)"
  [ -n "$pvp" ] || { echo "Missing DeepDesert_1 PvP partition."; exit 1; }
  [ -n "$pve" ] || { echo "Missing DeepDesert_1 PvE partition."; exit 1; }
  mkdir -p "$(dirname "$OVERRIDE_FILE")"
  cat > "$OVERRIDE_FILE" <<EOF
; ManagedPvpPartition=$pvp
; ManagedPvePartition=$pve

[DeepDesert_1]
NumExtraServers=1
MinServers=0
EOF
  echo "Director DeepDesert_1 override written: $OVERRIDE_FILE"
}

managed_selector_from_override() {
  local key="$1"
  [ -f "$OVERRIDE_FILE" ] || return 0
  sed -n "s/^; ${key}=\([0-9][0-9]*\)$/\1/p" "$OVERRIDE_FILE" | head -n1
}

remove_dual_usergame_selectors() {
  local pvp="$1" pve="$2"
  # Remove only the exact values recorded by this toggle. The managed override retains
  # those IDs even if a partial/manual cleanup removed the dimension-1 database row first.
  for partition_id in "$pvp" "$pve"; do
    [ -n "$partition_id" ] || continue
    python3 runtime/scripts/usersettings.py map-set Global global_pvp_enabled_partition_remove "$partition_id" >/dev/null 2>&1 || true
    # Remove legacy explicit-PvE selectors written by older Dual Deep Desert releases.
    python3 runtime/scripts/usersettings.py map-set Global global_pve_enabled_partition_remove "$partition_id" >/dev/null 2>&1 || true
  done
  python3 runtime/scripts/usersettings.py map-unset DeepDesert_1 force_pvp_all_partitions >/dev/null 2>&1 || true
  python3 runtime/scripts/usersettings.py map-unset Global force_pvp_all_partitions >/dev/null 2>&1 || true
  python3 runtime/scripts/usersettings.py dual-deepdesert-matchmaker disable >/dev/null 2>&1 || true
  python3 runtime/scripts/usersettings.py materialize-current >/dev/null || true
}

apply_usergame() {
  local pvp pve
  pvp="$(pvp_partition_id)"
  pve="$(pve_partition_id)"
  [ -n "$pvp" ] || { echo "Missing DeepDesert_1 PvP partition."; exit 1; }
  [ -n "$pve" ] || { echo "Missing DeepDesert_1 PvE partition."; exit 1; }
  runtime/scripts/sietches.sh set-display "$pvp" "Deep Desert PvP" >/dev/null
  runtime/scripts/sietches.sh set-display "$pve" "Deep Desert PvE" >/dev/null
  # Match the configuration verified against Funcom's Kanly selector: both the defensive
  # force-all flag and the one explicit PvP partition selector must be Global. The partition
  # omitted from that selector is PvE. Roles are persisted in the managed override so repairs
  # remain stable and first-time enablement can preserve dimension 0's pre-existing role.
  python3 runtime/scripts/usersettings.py map-unset DeepDesert_1 force_pvp_all_partitions
  for partition_id in "$pvp" "$pve"; do
    python3 runtime/scripts/usersettings.py map-set Global global_pvp_enabled_partition_remove "$partition_id"
    python3 runtime/scripts/usersettings.py map-set Global global_pve_enabled_partition_remove "$partition_id"
  done
  python3 runtime/scripts/usersettings.py map-set Global force_pvp_all_partitions False
  python3 runtime/scripts/usersettings.py map-set Global global_pvp_enabled_partition_add "$pvp"
  python3 runtime/scripts/usersettings.py dual-deepdesert-matchmaker enable
  python3 runtime/scripts/usersettings.py materialize-current >/dev/null || true
  echo "UserGame PvP/PvE settings applied. PvE partition: $pve. PvP partition: $pvp."
  echo "Global UserGame now uses m_bShouldForceEnablePvpOnAllPartitions=False and +m_PvpEnabledPartitions=$pvp; no explicit PvE selector is required."
  echo "Deep Desert matchmaking now uses SelectionRule=HomeDimension so the selected PvP/PvE instance reaches the matching partition."
}

enable_dual() {
  require_postgres
  ensure_partition
  ensure_dual_sietch_dimensions
  apply_partition_labels
  write_director_override
  apply_usergame
  recycle_idle_deepdesert_servers
  if [ "${RECYCLED_DEEPDESERT_SERVERS:-0}" = "1" ]; then
    echo "Refreshing dune-director after DeepDesert_1 recycle so the current instances re-register cleanly..."
    restart_director_if_running
  else
    restart_director_if_running
  fi
  despawn_idle_dynamic_deepdesert_servers
  echo
  echo "Dual Deep Desert PvP/PvE is enabled."
  echo "Gameplay routing now matches the verified flow: only partition $(pvp_partition_id) is listed in the Global m_PvpEnabledPartitions array; partition $(pve_partition_id) remains PvE."
  echo "Players should see two Deep Desert instances when the client enters the SELECT INSTANCE flow."
  echo "Run bootstrap once if players are still routed back to only dimension 0."
}

disable_dual() {
  local force="${1:-0}" no_despawn="${2:-0}" pvp pve assigned mode
  local rows row partition_id dimension_index server_id

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
    rm -f "$OVERRIDE_FILE"
    reset_single_sietch_dimension
    restart_director_if_running
    despawn_idle_dynamic_deepdesert_servers
    return 0
  }

  while IFS='|' read -r partition_id dimension_index server_id; do
    [ -n "${partition_id:-}" ] || continue
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
  psql -v ON_ERROR_STOP=1 -c "delete from dune.world_partition where map = 'DeepDesert_1' and dimension_index > 0;"
  remove_dual_usergame_selectors "$pvp" "$pve"
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
