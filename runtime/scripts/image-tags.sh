#!/usr/bin/env bash
set -euo pipefail

get_latest_local_tag() {
  local repo="$1"
  docker images --format '{{.Repository}} {{.Tag}}' 2>/dev/null \
    | awk -v repo="$repo" '$1 == repo && $2 != "<none>" { print $2 }' \
    | sort -rV \
    | head -n1
}

resolve_world_image_tag() {
  if [ -n "${DUNE_WORLD_IMAGE_TAG:-}" ]; then
    printf '%s' "$DUNE_WORLD_IMAGE_TAG"
    return 0
  fi

  local tag=""
  tag="$(get_latest_local_tag registry.funcom.com/funcom/self-hosting/seabass-server)"
  if [ -n "$tag" ]; then
    printf '%s' "$tag"
  else
    printf '%s' "1968181-0-shipping"
  fi
}

resolve_game_server_image() {
  if [ -n "${DUNE_GAME_SERVER_IMAGE:-}" ]; then
    printf '%s' "$DUNE_GAME_SERVER_IMAGE"
    return 0
  fi

  case "${DUNE_VEHICLE_PERMISSION_RESET_FIX_ENABLED:-false}" in
    1|true|TRUE|yes|YES|on|ON)
      local tag safe_tag image
      tag="$(resolve_world_image_tag)"
      safe_tag="${tag//[^a-zA-Z0-9_.-]/-}"
      image="redblink-dune-game-server:vehicle-permission-reset-${safe_tag}"
      if ! docker image inspect "$image" >/dev/null 2>&1; then
        echo "Vehicle permission reset fix is unavailable for Funcom tag $tag; using the official image." >&2
        echo "Run 'dune vehicle-fix build' only after this build is supported and tested." >&2
      else
        printf '%s' "$image"
        return 0
      fi
      ;;
  esac

  printf 'registry.funcom.com/funcom/self-hosting/seabass-server:%s' "$(resolve_world_image_tag)"
}

resolve_postgres_image_tag() {
  if [ -n "${DUNE_POSTGRES_IMAGE_TAG:-}" ]; then
    printf '%s' "$DUNE_POSTGRES_IMAGE_TAG"
    return 0
  fi

  local tag=""
  tag="$(get_latest_local_tag registry.funcom.com/funcom/self-hosting/igw-postgres)"
  if [ -n "$tag" ]; then
    printf '%s' "$tag"
  else
    printf '%s' "17.4"
  fi
}
