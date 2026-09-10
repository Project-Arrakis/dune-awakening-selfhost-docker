#!/usr/bin/env bash

# The two overmap Landsraad activities are isolated, disposable instances.
# Use Funcom's own map-name conversion and actor cleanup routine so a stopped
# instance cannot retain dropped items or other ownerless transient actors.

landsraad_instance_requires_cleanup() {
  case "$1" in
    CB_Overland_S_07|CB_Overland_S_08) return 0 ;;
    *) return 1 ;;
  esac
}

landsraad_instance_cleanup_sql() {
  local world_map="$1"
  local partition_id="$2"

  landsraad_instance_requires_cleanup "$world_map" || return 1
  [[ "$partition_id" =~ ^[0-9]+$ ]] || return 1

  cat <<SQL
select dune.delete_actors_and_respawns_on_server(
  row(dune.upgrade_map_name('$world_map'), $partition_id::bigint, (
    select dimension_index
    from dune.world_partition
    where partition_id = $partition_id
      and map = '$world_map'
  ))::dune.serverinfo,
  null::text[],
  false
);
SQL
}
