#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/image-tags.sh

ACTION="${1:-status}"
BASE_TAG="$(resolve_world_image_tag)"
BASE_IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server:${BASE_TAG}"
SAFE_TAG="${BASE_TAG//[^a-zA-Z0-9_.-]/-}"
PATCHED_IMAGE="redblink-dune-game-server:vehicle-permission-reset-${SAFE_TAG}"
BINARY_PATH="/home/dune/server/DuneSandbox/Binaries/Linux/DuneSandboxServer-Linux-Shipping"
PATCHER="patches/vehicle-permission-reset/patch.py"
DOCKERFILE="patches/vehicle-permission-reset/Dockerfile"

usage() {
  cat <<'EOF'
Usage: vehicle-permission-reset-fix.sh [status|auto|build|enable|disable|remove]

  status  Show whether the version-locked compatibility image is available.
  auto    Build and enable the image when the installed Funcom build is supported.
  build   Build a derived local image from the installed official Funcom image.
  enable  Select the derived image for future game-server starts.
  disable Return future game-server starts to the official Funcom image.
  remove  Remove only the derived local image.

These commands never restart or replace a running game server.
EOF
}

persist_env_value() {
  local key="$1" value="$2" env_file=".env" tmp
  touch "$env_file"
  tmp="$(mktemp ./.env.vehicle-fix.XXXXXX)"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $0 ~ "^" key "=" { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$env_file" >"$tmp"
  chmod --reference="$env_file" "$tmp" 2>/dev/null || true
  mv "$tmp" "$env_file"
}

remove_env_value() {
  local key="$1" env_file=".env" tmp
  [ -f "$env_file" ] || return 0
  tmp="$(mktemp ./.env.vehicle-fix.XXXXXX)"
  awk -v key="$key" '$0 !~ "^" key "=" { print }' "$env_file" >"$tmp"
  chmod --reference="$env_file" "$tmp" 2>/dev/null || true
  mv "$tmp" "$env_file"
}

image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}

status() {
  printf 'Official image: %s\n' "$BASE_IMAGE"
  printf 'Compatibility image: %s\n' "$PATCHED_IMAGE"
  if image_exists "$PATCHED_IMAGE"; then
    echo "Status: built"
  else
    echo "Status: not built"
  fi

  if [ -n "${DUNE_GAME_SERVER_IMAGE:-}" ]; then
    echo "Configured: custom game-server image override"
    echo "Effective image: $DUNE_GAME_SERVER_IMAGE"
    return 0
  fi

  case "${DUNE_VEHICLE_PERMISSION_RESET_FIX_AUTO:-true}" in
    0|false|FALSE|no|NO|off|OFF) echo "Automatic preparation: disabled" ;;
    *) echo "Automatic preparation: enabled" ;;
  esac

  case "${DUNE_VEHICLE_PERMISSION_RESET_FIX_ENABLED:-false}" in
    1|true|TRUE|yes|YES|on|ON)
      echo "Configured: yes"
      if image_exists "$PATCHED_IMAGE"; then
        echo "Effective image: compatibility image"
      else
        echo "Effective image: official image (compatibility image unavailable for this tag)"
      fi
      ;;
    *)
      echo "Configured: no"
      echo "Effective image: official image"
      ;;
  esac
}

build() {
  local work_dir build_dir source_binary patched_binary source_container
  local cleanup_container=""

  image_exists "$BASE_IMAGE" || {
    echo "Official image is not installed locally: $BASE_IMAGE" >&2
    exit 1
  }

  work_dir="$(mktemp -d /tmp/dune-vehicle-permission-reset.XXXXXX)"
  build_dir="$work_dir/build"
  mkdir -p "$build_dir"
  source_binary="$work_dir/DuneSandboxServer-Linux-Shipping.stock"
  patched_binary="$build_dir/DuneSandboxServer-Linux-Shipping"

  cleanup() {
    if [ -n "$cleanup_container" ]; then
      docker rm -f "$cleanup_container" >/dev/null 2>&1 || true
    fi
    rm -rf "$work_dir"
  }
  trap cleanup EXIT

  source_container="$(docker create "$BASE_IMAGE")"
  cleanup_container="$source_container"
  docker cp "$source_container:$BINARY_PATH" "$source_binary"
  docker rm "$source_container" >/dev/null
  cleanup_container=""

  python3 "$PATCHER" "$source_binary" "$patched_binary"
  docker build \
    --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    --label "io.dunedocker.compatibility.vehicle-permission-reset=true" \
    --label "io.dunedocker.compatibility.base-image=$BASE_IMAGE" \
    -f "$DOCKERFILE" \
    -t "$PATCHED_IMAGE" \
    "$build_dir"

  echo
  echo "Built: $PATCHED_IMAGE"
  echo "No running container was changed."
  echo "Run 'dune vehicle-fix enable' to select it for future game-server starts."
}

enable() {
  image_exists "$PATCHED_IMAGE" || {
    echo "Compatibility image is not built: $PATCHED_IMAGE" >&2
    echo "Run: dune vehicle-fix build" >&2
    exit 1
  }
  persist_env_value DUNE_VEHICLE_PERMISSION_RESET_FIX_ENABLED true
  persist_env_value DUNE_VEHICLE_PERMISSION_RESET_FIX_AUTO true
  echo "Vehicle permission reset fix enabled for future game-server starts."
  echo "No running container was restarted or replaced."
}

disable() {
  remove_env_value DUNE_VEHICLE_PERMISSION_RESET_FIX_ENABLED
  persist_env_value DUNE_VEHICLE_PERMISSION_RESET_FIX_AUTO false
  echo "Vehicle permission reset fix disabled for future game-server starts."
  echo "Automatic preparation is disabled until 'dune vehicle-fix enable' is run."
  echo "No running container was restarted or replaced."
}

remove() {
  case "${DUNE_VEHICLE_PERMISSION_RESET_FIX_ENABLED:-false}" in
    1|true|TRUE|yes|YES|on|ON)
      echo "Refusing to remove the configured game-server image." >&2
      echo "Run 'dune vehicle-fix disable' first, then restart world servers on the official image." >&2
      exit 1
      ;;
  esac

  if image_exists "$PATCHED_IMAGE"; then
    docker image rm "$PATCHED_IMAGE"
  else
    echo "Compatibility image is not installed: $PATCHED_IMAGE"
  fi
}

auto() {
  if [ -n "${DUNE_GAME_SERVER_IMAGE:-}" ]; then
    echo "Custom game-server image override is configured; skipping automatic compatibility image preparation."
    return 0
  fi

  case "${DUNE_VEHICLE_PERMISSION_RESET_FIX_AUTO:-true}" in
    0|false|FALSE|no|NO|off|OFF)
      echo "Automatic vehicle permission compatibility preparation is disabled."
      return 0
      ;;
  esac

  if image_exists "$PATCHED_IMAGE"; then
    echo "Vehicle permission compatibility image already matches Funcom tag $BASE_TAG."
    enable
    return 0
  fi

  echo "Checking vehicle permission compatibility for Funcom tag $BASE_TAG..."
  if "$0" build; then
    "$0" enable
    echo "Vehicle permission compatibility fix is ready for the upcoming world-server start."
    return 0
  fi

  cat >&2 <<EOF
WARN: The vehicle permission compatibility image could not be prepared for Funcom tag $BASE_TAG.
The update will continue with the official Funcom game-server image. No older compatibility image will be used.
EOF
  return 0
}

case "$ACTION" in
  status) status ;;
  auto) auto ;;
  build) build ;;
  enable) enable ;;
  disable) disable ;;
  remove) remove ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
