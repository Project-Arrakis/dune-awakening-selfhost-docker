#!/usr/bin/env bash

validate_sietch_display_name() {
  local raw="${1:-}"

  # Trim surrounding whitespace while preserving spaces inside the name.
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"

  if [ -z "$raw" ]; then
    printf '\n'
    return 0
  fi

  case "$raw" in
    *$'\r'*|*$'\n'*|*$'\t'*|*"'"*|*'|'*)
      echo "Invalid Sietch name. Apostrophes, pipes, tabs, and line breaks are not supported." >&2
      return 1
      ;;
  esac

  if [ "${#raw}" -gt 80 ]; then
    echo "Invalid Sietch name. The name must be 80 characters or fewer." >&2
    return 1
  fi

  printf '%s\n' "$raw"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ "$#" -eq 1 ] || {
    echo "Usage: bash runtime/scripts/sietch-name.sh <display-name>" >&2
    exit 2
  }
  validate_sietch_display_name "$1"
fi
