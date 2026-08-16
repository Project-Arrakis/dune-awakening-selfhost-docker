#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
ROOT_DIR="${DUNE_RUNTIME_REPO_ROOT:-$SCRIPT_ROOT}"
cd "$ROOT_DIR"

if [ $# -ne 1 ] || ! [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Usage: repair-map-settings-permissions.sh <safe-map-directory-name>" >&2
  exit 2
fi

safe_name="$1"
settings_dir="runtime/game/$safe_name/Saved/UserSettings"

# This is the normal path. It avoids starting a helper container for every
# dynamic-map launch when ownership has not drifted.
if mkdir -p "$settings_dir" 2>/dev/null && [ -w "$settings_dir" ]; then
  exit 0
fi

source "$SCRIPT_ROOT/runtime/scripts/host-paths.sh"
source "$SCRIPT_ROOT/runtime/scripts/host-file-ownership.sh"

owner="$(dune_resolve_host_owner)"
target_uid="${owner%%:*}"
target_gid="${owner#*:}"
helper_image="${DUNE_RUNTIME_PERMISSION_HELPER_IMAGE:-dune-orchestrator:dev}"
container_name="dune-server-$safe_name"

if docker ps --format '{{.Names}}' | grep -Fxq "$container_name"; then
  echo "Refusing to repair settings ownership while the map is running: $container_name" >&2
  exit 1
fi

if ! docker image inspect "$helper_image" >/dev/null 2>&1; then
  echo "Cannot repair settings for $safe_name: Docker image not found: $helper_image" >&2
  exit 1
fi

host_game_root="${DUNE_RUNTIME_HOST_GAME_ROOT:-$(host_path "$ROOT_DIR/runtime/game")}"
echo "Repairing dynamic-map settings ownership: $safe_name"

# Mount only runtime/game and alter only the selected, currently stopped map's
# host-managed settings chain. Other Saved data and other maps are untouched.
docker run --rm \
  --user 0:0 \
  --entrypoint sh \
  -e "SAFE_NAME=$safe_name" \
  -e "TARGET_UID=$target_uid" \
  -e "TARGET_GID=$target_gid" \
  -v "$host_game_root:/game" \
  "$helper_image" -c '
    set -eu
    case "$SAFE_NAME" in
      ""|*[!a-z0-9-]*) echo "Invalid map settings directory" >&2; exit 2 ;;
    esac
    saved="/game/$SAFE_NAME/Saved"
    settings="$saved/UserSettings"
    mkdir -p "$settings"
    chown "$TARGET_UID:$TARGET_GID" "/game/$SAFE_NAME" "$saved"
    chmod u+rwx "/game/$SAFE_NAME" "$saved"
    find "$settings" -xdev \( ! -uid "$TARGET_UID" -o ! -gid "$TARGET_GID" \) \
      -exec chown -h "$TARGET_UID:$TARGET_GID" {} +
    find "$settings" -xdev -type d ! -perm -u+rwx -exec chmod u+rwx {} +
    find "$settings" -xdev -type f ! -perm -u+rw -exec chmod u+rw {} +
  '

if [ ! -d "$settings_dir" ] || [ ! -w "$settings_dir" ]; then
  echo "Dynamic-map settings directory remains unwritable: $settings_dir" >&2
  exit 1
fi
