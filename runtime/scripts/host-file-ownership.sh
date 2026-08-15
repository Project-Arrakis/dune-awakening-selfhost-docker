#!/usr/bin/env bash

# Keep host-managed files writable by the installation owner even when a
# maintenance path is launched by a root systemd service.
dune_resolve_host_owner() {
  local repo_uid repo_gid configured_uid configured_gid

  repo_uid="$(stat -c '%u' . 2>/dev/null || printf '0')"
  repo_gid="$(stat -c '%g' . 2>/dev/null || printf '0')"
  configured_uid="${DUNE_HOST_UID:-}"
  configured_gid="${DUNE_HOST_GID:-}"

  if [ -z "$configured_uid" ] && [ -r .env ]; then
    configured_uid="$(awk -F= '$1 == "DUNE_HOST_UID" { value=$2; gsub(/[[:space:]"'\'']/, "", value); print value; exit }' .env)"
  fi
  if [ -z "$configured_gid" ] && [ -r .env ]; then
    configured_gid="$(awk -F= '$1 == "DUNE_HOST_GID" { value=$2; gsub(/[[:space:]"'\'']/, "", value); print value; exit }' .env)"
  fi

  if [[ "$repo_uid" =~ ^[0-9]+$ && "$repo_gid" =~ ^[0-9]+$ && "$repo_uid" != "0" ]]; then
    printf '%s:%s\n' "$repo_uid" "$repo_gid"
    return
  fi
  if [[ "$configured_uid" =~ ^[0-9]+$ && "$configured_gid" =~ ^[0-9]+$ && "$configured_uid" != "0" ]]; then
    printf '%s:%s\n' "$configured_uid" "$configured_gid"
    return
  fi
  printf '%s:%s\n' "$repo_uid" "$repo_gid"
}

dune_set_host_path_owner() {
  local path="$1" owner target_uid target_gid

  [ -e "$path" ] || [ -L "$path" ] || return 0
  [ "$(id -u)" = "0" ] || return 0
  owner="$(dune_resolve_host_owner)"
  target_uid="${owner%%:*}"
  target_gid="${owner#*:}"
  [ "$target_uid" != "0" ] || return 0
  if ! chown -h "$target_uid:$target_gid" "$path"; then
    echo "WARN could not restore host ownership for $path" >&2
  fi
  return 0
}
