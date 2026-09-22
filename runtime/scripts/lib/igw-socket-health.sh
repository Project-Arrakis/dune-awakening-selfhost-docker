#!/usr/bin/env bash

# Classify consecutive IGW UDP socket samples. A large receive queue alone is
# normal during bursts and is not evidence that the game stopped consuming it.
# A recoverable stall requires all of the following for the full confirmation
# window:
#   - the queue remains above the configured threshold;
#   - the queue never drains between samples; and
#   - the kernel is still dropping new datagrams for the saturated socket.
#
# Output: <decision>|<first_blocked_at>|<last_drop_at>
# Decisions are clear, baseline, draining, observe, and recover.
igw_socket_evidence_decision() {
  local threshold="$1"
  local stall_seconds="$2"
  local drop_grace_seconds="$3"
  local now="$4"
  local first_blocked_at="$5"
  local last_drop_at="$6"
  local previous_queue="$7"
  local previous_drops="$8"
  local queue="$9"
  local drops="${10}"
  local age drop_age

  if ! [[ "$threshold" =~ ^[0-9]+$ && "$stall_seconds" =~ ^[0-9]+$ && "$drop_grace_seconds" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ && "$queue" =~ ^[0-9]+$ && "$drops" =~ ^[0-9]+$ ]]; then
    printf 'clear||\n'
    return 0
  fi

  if [ "$queue" -lt "$threshold" ]; then
    printf 'clear||\n'
    return 0
  fi

  if ! [[ "$previous_queue" =~ ^[0-9]+$ && "$previous_drops" =~ ^[0-9]+$ ]]; then
    printf 'baseline||\n'
    return 0
  fi

  # Any observed drain proves that the game is still consuming the socket.
  # A lower drop counter means the socket was recreated, so prior evidence no
  # longer belongs to the current socket generation.
  if [ "$queue" -lt "$previous_queue" ] || [ "$drops" -lt "$previous_drops" ]; then
    printf 'draining||\n'
    return 0
  fi

  if [ "$drops" -gt "$previous_drops" ]; then
    last_drop_at="$now"
    if ! [[ "$first_blocked_at" =~ ^[0-9]+$ ]]; then
      first_blocked_at="$now"
    fi
  fi

  if ! [[ "$first_blocked_at" =~ ^[0-9]+$ && "$last_drop_at" =~ ^[0-9]+$ ]]; then
    printf 'baseline||\n'
    return 0
  fi

  age=$((now - first_blocked_at))
  drop_age=$((now - last_drop_at))
  if [ "$age" -ge "$stall_seconds" ] && [ "$drop_age" -le "$drop_grace_seconds" ]; then
    printf 'recover|%s|%s\n' "$first_blocked_at" "$last_drop_at"
  else
    printf 'observe|%s|%s\n' "$first_blocked_at" "$last_drop_at"
  fi
}
