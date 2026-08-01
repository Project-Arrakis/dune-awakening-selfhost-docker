#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

source runtime/scripts/runtime-env.sh

CLIENT_PORT_BASE="$(resolve_client_port_base)"
IGW_PORT_BASE="$(resolve_igw_port_base)"
GAME_PORT="$((CLIENT_PORT_BASE + 1))"
IGW_PORT="$IGW_PORT_BASE"
PARTITION_ID="${DUNE_SURVIVAL_PARTITION_ID:-1}"

docker rm -f dune-server-survival-1 2>/dev/null || true

docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
begin;
update dune.world_partition
set server_id = null
where partition_id = $PARTITION_ID;
delete from dune.farm_state
where map = 'Survival_1'
  and game_port = $GAME_PORT
  and igw_port = $IGW_PORT;
commit;
" >/dev/null
