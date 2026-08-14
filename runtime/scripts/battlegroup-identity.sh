#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

# shellcheck source=runtime/scripts/runtime-env.sh disable=SC1091
source runtime/scripts/runtime-env.sh

BATTLEGROUP_FILE="${DUNE_BATTLEGROUP_FILE:-runtime/generated/battlegroup.env}"
TOKEN_FILE="${DUNE_FUNCOM_TOKEN_FILE:-runtime/secrets/funcom-token.txt}"
PRIMARY_ENV_FILE="${DUNE_BATTLEGROUP_PRIMARY_ENV_FILE:-.env}"
BACKUP_DIR="${DUNE_BATTLEGROUP_BACKUP_DIR:-runtime/backups/db}"
INIT_BACKUP_DIR="${DUNE_BATTLEGROUP_INIT_BACKUP_DIR:-runtime/backups}"

usage() {
  cat <<'EOF'
Usage:
  runtime/scripts/battlegroup-identity.sh ensure
  runtime/scripts/battlegroup-identity.sh check

ensure verifies the saved Battlegroup ID against the Funcom token and safely
recovers a missing ID from live runtime evidence or matching backup metadata.
check performs validation without changing files.
EOF
}

ids_match() {
  [ "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')" ]
}

identity_matches_host() {
  local battlegroup_id="$1"
  local token_host="$2"
  local battlegroup_host
  battlegroup_host="$(battlegroup_host_id "$battlegroup_id" 2>/dev/null || true)"
  [ -n "$battlegroup_host" ] && ids_match "$battlegroup_host" "$token_host"
}

metadata_battlegroup_id() {
  local file="$1"
  local candidate
  [ -r "$file" ] || return 1

  candidate="$(awk -F': *' '$1 == "battlegroup_id" { value = substr($0, length($1) + 2); sub(/^ */, "", value); print value; exit }' "$file")"
  if battlegroup_id_is_valid "$candidate"; then
    printf '%s' "$candidate"
    return 0
  fi

  candidate="$(awk '
    function clean(value) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value ~ /^".*"$/ || value ~ /^'\''.*'\''$/) value = substr(value, 2, length(value) - 2)
      return value
    }
    function emit(value) {
      value = clean(value)
      if (value ~ /^funcom-seabass-sh-[A-Za-z0-9]+-[A-Za-z0-9]+$/) sub(/^funcom-seabass-/, "", value)
      if (value ~ /^sh-[A-Za-z0-9]+-[A-Za-z0-9]+$/) {
        print value
        exit
      }
    }
    /^[A-Za-z0-9_.-]+:/ {
      section = $1
      sub(/:.*/, "", section)
      next
    }
    section == "metadata" && /^  (name|namespace):[[:space:]]*/ {
      value = $0
      sub(/^  (name|namespace):[[:space:]]*/, "", value)
      emit(value)
    }
    section == "spec" && /^  name:[[:space:]]*/ {
      value = $0
      sub(/^  name:[[:space:]]*/, "", value)
      emit(value)
    }
  ' "$file")"
  battlegroup_id_is_valid "$candidate" || return 1
  printf '%s' "$candidate"
}

latest_matching_backup_id() {
  local token_host="$1"
  local file candidate
  [ -d "$BACKUP_DIR" ] || return 1

  while IFS= read -r file; do
    candidate="$(metadata_battlegroup_id "$file" 2>/dev/null || true)"
    if battlegroup_id_is_valid "$candidate" && identity_matches_host "$candidate" "$token_host"; then
      printf '%s' "$candidate"
      return 0
    fi
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.yaml' -printf '%T@\t%p\n' 2>/dev/null | sort -rn | cut -f2-)
  return 1
}

latest_matching_init_id() {
  local token_host="$1"
  local file candidate
  [ -d "$INIT_BACKUP_DIR" ] || return 1

  while IFS= read -r file; do
    candidate="$(config_value "$file" BATTLEGROUP_ID 2>/dev/null || true)"
    if battlegroup_id_is_valid "$candidate" && identity_matches_host "$candidate" "$token_host"; then
      printf '%s' "$candidate"
      return 0
    fi
  done < <(find "$INIT_BACKUP_DIR" -maxdepth 2 -type f -path '*/init-reset-*/battlegroup.env' -printf '%T@\t%p\n' 2>/dev/null | sort -rn | cut -f2-)
  return 1
}

validate_saved_identity() {
  local token_host="$1"
  local configured
  configured="$(config_value "$BATTLEGROUP_FILE" BATTLEGROUP_ID 2>/dev/null || true)"
  battlegroup_id_is_valid "$configured" || return 1
  if ! identity_matches_host "$configured" "$token_host"; then
    echo "Battlegroup identity mismatch: the saved Battlegroup ID does not belong to the current Funcom token Host ID." >&2
    echo "Refusing to replace or start this identity automatically." >&2
    return 2
  fi
  printf '%s' "$configured"
}

persist_recovered_identity() {
  local candidate="$1"
  mkdir -p "$(dirname "$BATTLEGROUP_FILE")"
  set_env_file_value "$BATTLEGROUP_FILE" BATTLEGROUP_ID "$candidate" 664
}

ensure_identity() {
  local token_host configured candidate source funcom_token
  funcom_token="$(resolve_funcom_token "$TOKEN_FILE" 2>/dev/null || true)"
  token_host="$(funcom_token_host_id "$funcom_token" 2>/dev/null || true)"
  if [ -z "$token_host" ]; then
    echo "Cannot validate Battlegroup identity: the Funcom token is missing, malformed, or has no HostId." >&2
    return 1
  fi

  if configured="$(validate_saved_identity "$token_host")"; then
    echo "Battlegroup identity verified: $configured"
    return 0
  else
    case "$?" in
      2) return 1 ;;
    esac
  fi

  candidate=""
  source=""
  if [ "${DUNE_BATTLEGROUP_SKIP_RUNTIME_SOURCES:-0}" != "1" ]; then
    candidate="$(resolve_battlegroup_id 2>/dev/null || true)"
    if battlegroup_id_is_valid "$candidate"; then
      if ! identity_matches_host "$candidate" "$token_host"; then
        echo "Battlegroup identity mismatch: live containers or logs use an ID that does not belong to the current Funcom token." >&2
        echo "Refusing to choose a different identity automatically." >&2
        return 1
      fi
      source="live containers or runtime logs"
    fi
  fi

  if [ -z "$candidate" ]; then
    candidate="$(config_value "$PRIMARY_ENV_FILE" BATTLEGROUP_ID 2>/dev/null || true)"
    if battlegroup_id_is_valid "$candidate"; then
      if ! identity_matches_host "$candidate" "$token_host"; then
        echo "Battlegroup identity mismatch: .env uses an ID that does not belong to the current Funcom token." >&2
        echo "Refusing to choose a different identity automatically." >&2
        return 1
      fi
      source="the primary environment configuration"
    else
      candidate=""
    fi
  fi

  if [ -z "$candidate" ]; then
    candidate="$(latest_matching_backup_id "$token_host" 2>/dev/null || true)"
    [ -z "$candidate" ] || source="database backup metadata"
  fi
  if [ -z "$candidate" ]; then
    candidate="$(latest_matching_init_id "$token_host" 2>/dev/null || true)"
    [ -z "$candidate" ] || source="initialization recovery metadata"
  fi

  if ! battlegroup_id_is_valid "$candidate"; then
    cat >&2 <<'EOF'
Battlegroup identity is missing and could not be recovered safely.
Refusing to start with the placeholder identity "dune-docker" because Funcom
will reject it and the server would record misleading backup metadata.
Restore runtime/generated/battlegroup.env from a known-good copy or contact support.
EOF
    return 1
  fi

  persist_recovered_identity "$candidate"
  echo "Recovered Battlegroup identity from $source: $candidate"
}

check_identity() {
  local token_host configured funcom_token
  funcom_token="$(resolve_funcom_token "$TOKEN_FILE" 2>/dev/null || true)"
  token_host="$(funcom_token_host_id "$funcom_token" 2>/dev/null || true)"
  if [ -z "$token_host" ]; then
    echo "Battlegroup identity check failed: the Funcom token is missing, malformed, or has no HostId." >&2
    return 1
  fi
  configured="$(validate_saved_identity "$token_host")" || {
    echo "Battlegroup identity check failed: BATTLEGROUP_ID is missing, invalid, or mismatched." >&2
    return 1
  }
  echo "Battlegroup identity is valid and matches the Funcom token: $configured"
}

case "${1:-ensure}" in
  ensure) ensure_identity ;;
  check) check_identity ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
