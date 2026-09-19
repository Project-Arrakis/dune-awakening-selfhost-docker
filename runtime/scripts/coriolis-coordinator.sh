#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

SIGNAL_TEXT="LogCoriolis: Display: Coriolis Restart Farm"
STATE_FILE="${DUNE_CORIOLIS_STATE_FILE:-runtime/generated/coriolis-coordinator.env}"
STATE_LOCK_FILE="${DUNE_CORIOLIS_STATE_LOCK_FILE:-runtime/generated/coriolis-coordinator.lock}"
RESTART_SCRIPT="${DUNE_CORIOLIS_RESTART_SCRIPT:-runtime/scripts/restart-game-farm.sh}"
CLEANUP_SCRIPT="${DUNE_CORIOLIS_CLEANUP_SCRIPT:-runtime/scripts/coriolis-data-cleanup.sh}"
POLL_SECONDS="${DUNE_CORIOLIS_POLL_SECONDS:-2}"
LOOKBACK_SECONDS="${DUNE_CORIOLIS_LOOKBACK_SECONDS:-8}"
INITIAL_LOOKBACK_SECONDS="${DUNE_CORIOLIS_INITIAL_LOOKBACK_SECONDS:-21600}"
COOLDOWN_SECONDS="${DUNE_CORIOLIS_COOLDOWN_SECONDS:-21600}"
GRACE_SECONDS="${DUNE_CORIOLIS_GRACE_SECONDS:-90}"
RETRY_SECONDS="${DUNE_CORIOLIS_RETRY_SECONDS:-60}"
MAX_ATTEMPTS="${DUNE_CORIOLIS_MAX_ATTEMPTS:-3}"

bounded_uint() {
  local value="$1" fallback="$2" minimum="$3" maximum="$4"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt "$minimum" ] || [ "$value" -gt "$maximum" ]; then
    printf '%s\n' "$fallback"
  else
    printf '%s\n' "$value"
  fi
}

POLL_SECONDS="$(bounded_uint "$POLL_SECONDS" 2 1 60)"
LOOKBACK_SECONDS="$(bounded_uint "$LOOKBACK_SECONDS" 8 2 300)"
INITIAL_LOOKBACK_SECONDS="$(bounded_uint "$INITIAL_LOOKBACK_SECONDS" 21600 8 86400)"
COOLDOWN_SECONDS="$(bounded_uint "$COOLDOWN_SECONDS" 21600 300 86400)"
GRACE_SECONDS="$(bounded_uint "$GRACE_SECONDS" 90 0 300)"
RETRY_SECONDS="$(bounded_uint "$RETRY_SECONDS" 60 0 900)"
MAX_ATTEMPTS="$(bounded_uint "$MAX_ATTEMPTS" 3 1 5)"

state_value() {
  local key="$1"
  [ -r "$STATE_FILE" ] || return 1
  awk -F= -v key="$key" '$1 == key { print substr($0, length($1) + 2); exit }' "$STATE_FILE"
}

write_state() {
  local state="$1" requested_epoch="$2" message="$3"
  local now temporary
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$(dirname "$STATE_FILE")"
  temporary="${STATE_FILE}.tmp.$$"
  {
    printf 'state=%s\n' "$state"
    printf 'requested_epoch=%s\n' "$requested_epoch"
    printf 'requested_at=%s\n' "$(date -u -d "@$requested_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '%s' "$now")"
    printf 'updated_at=%s\n' "$now"
    printf 'message=%s\n' "$(printf '%s' "$message" | tr '\r\n=' '   ' | cut -c1-300)"
  } > "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$STATE_FILE"
}

restart_is_recent() {
  local now="$1" last last_state age
  last_state="$(state_value state 2>/dev/null || true)"
  case "$last_state" in
    succeeded|failed|skipped) ;;
    *) return 1 ;;
  esac
  last="$(state_value requested_epoch 2>/dev/null || true)"
  [[ "$last" =~ ^[0-9]+$ ]] || return 1
  age=$((now - last))
  [ "$age" -ge 0 ] && [ "$age" -lt "$COOLDOWN_SECONDS" ]
}

perform_farm_restart() {
  "$RESTART_SCRIPT" coriolis
}

perform_cycle_data_cleanup() {
  if [ ! -x "$CLEANUP_SCRIPT" ]; then
    echo "Coriolis cycle data cleanup is unavailable; continuing with the farm restart." >&2
    return 1
  fi
  "$CLEANUP_SCRIPT"
}

handle_restart_signal() {
  local source_container="$1" now attempt cleanup_failed=0
  now="$(date +%s)"

  mkdir -p "$(dirname "$STATE_LOCK_FILE")"
  exec 9>"$STATE_LOCK_FILE"
  if ! flock -n 9; then
    echo "Coriolis restart request is already being handled."
    return 0
  fi
  if restart_is_recent "$now"; then
    echo "Ignoring duplicate Coriolis restart request from $source_container within the ${COOLDOWN_SECONDS}s cooldown."
    flock -u 9
    exec 9>&-
    return 0
  fi
  if [ -f runtime/generated/manual-stop.env ]; then
    write_state skipped "$now" "Manual stop is active; no Coriolis restart was started."
    echo "Manual stop is active; ignoring Coriolis restart request."
    flock -u 9
    exec 9>&-
    return 0
  fi

  write_state running "$now" "Funcom requested a farm restart from $source_container."
  echo "Funcom Coriolis farm restart requested by $source_container."
  if [ "$GRACE_SECONDS" -gt 0 ]; then
    echo "Waiting ${GRACE_SECONDS}s for every Sietch to finish its Coriolis transition."
    sleep "$GRACE_SECONDS"
  fi
  if [ -f runtime/generated/manual-stop.env ]; then
    write_state skipped "$now" "Manual stop became active during the Coriolis grace period; no restart was started."
    echo "Manual stop became active; cancelling the Coriolis restart."
    flock -u 9
    exec 9>&-
    return 0
  fi
  if ! perform_cycle_data_cleanup; then
    cleanup_failed=1
    echo "Coriolis cycle data cleanup failed; continuing with the farm restart so the cycle is not blocked." >&2
  fi
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    if perform_farm_restart; then
      if [ "$cleanup_failed" = "1" ]; then
        write_state succeeded "$now" "Coriolis game-farm restart completed, but cycle data cleanup failed."
      else
        write_state succeeded "$now" "Coriolis game-farm restart completed successfully."
      fi
      echo "Coriolis game-farm restart completed successfully."
      flock -u 9
      exec 9>&-
      return 0
    fi
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "Coriolis game-farm restart attempt $attempt failed; retrying in ${RETRY_SECONDS}s."
      sleep "$RETRY_SECONDS"
    fi
  done

  write_state failed "$now" "Coriolis game-farm restart failed after $MAX_ATTEMPTS attempts."
  echo "Coriolis game-farm restart failed after $MAX_ATTEMPTS attempts." >&2
  flock -u 9
  exec 9>&-
  return 1
}

scan_once() {
  local lookback="${1:-$LOOKBACK_SECONDS}" container
  while IFS= read -r container; do
    [ -n "$container" ] || continue
    if docker logs --since "${lookback}s" "$container" 2>&1 | grep -Fq "$SIGNAL_TEXT"; then
      handle_restart_signal "$container"
      return $?
    fi
  done < <(docker ps --format '{{.Names}}' | grep -E '^dune-server-survival-1(-[0-9]+)?$' | sort || true)
}

show_status() {
  echo "=== Coriolis Coordinator ==="
  if [ -r "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  else
    echo "state=waiting"
    echo "message=No Coriolis restart has been handled yet."
  fi
}

monitor() {
  echo "Coriolis coordinator is monitoring Funcom farm-restart requests."
  echo "Signal: $SIGNAL_TEXT"
  # Recover a request missed while upgrading or while the coordinator was
  # unavailable. A recreated Sietch has fresh Docker logs, so this cannot
  # replay a request that an earlier full game-farm restart already handled.
  scan_once "$INITIAL_LOOKBACK_SECONDS" || true
  while true; do
    scan_once || true
    sleep "$POLL_SECONDS"
  done
}

if [ "${DUNE_CORIOLIS_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

case "${1:-monitor}" in
  monitor) monitor ;;
  scan-once) scan_once ;;
  status) show_status ;;
  *)
    echo "Usage: $0 [monitor|scan-once|status]" >&2
    exit 2
    ;;
esac
