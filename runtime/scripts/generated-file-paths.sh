#!/usr/bin/env bash

# Repair a Docker-created directory where a generated regular file must live.
# Only empty directories are removed; unexpected contents are always preserved.
repair_generated_file_path() {
  local path="$1"
  local first_entry=""

  if [ -d "$path" ]; then
    if ! first_entry="$(find "$path" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)"; then
      echo "Could not inspect generated file path: $path" >&2
      return 1
    fi
    if [ -n "$first_entry" ]; then
      echo "Generated file path is a non-empty directory and was not removed: $path" >&2
      echo "Move or inspect its contents, then retry startup." >&2
      return 1
    fi

    echo "Repairing empty Docker-created directory at generated file path: $path"
    if ! rmdir -- "$path"; then
      echo "Could not remove the empty directory at: $path" >&2
      echo "Repair its host ownership or remove it with sudo, then retry startup." >&2
      return 1
    fi
  elif [ -e "$path" ] && [ ! -f "$path" ]; then
    echo "Generated file path is not a regular file: $path" >&2
    return 1
  fi
}
