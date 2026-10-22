#!/usr/bin/env bash

# The UDP socket table is a property of the network namespace, not of the
# container. Every container in this stack runs with host networking
# (docker-compose.yml's network_mode, spawn-server.sh --network host,
# start-autoscaler.sh --network host), so the autoscaler already shares the
# namespace the core map's IGW socket lives in and can read /proc/net/udp
# directly. That matters because this runs for every ready core map every
# IGW_SOCKET_HEALTH_SCAN_SECONDS: an exec here leaves a conmon pair resident for
# the engine's exit delay, which is the same cost lib/postgres.sh exists to
# avoid, for a file the host can already see.
#
# The port filter is the only thing that scopes the read to this map, so a
# container that did *not* share the namespace would not have its port in the
# host's table and would sample an empty queue -- the watchdog would go blind
# rather than fail loudly. Confirm the namespace before trusting the shortcut,
# and keep the exec for anything else.
igw_socket_table() {
  local container="$1"

  if [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$container" 2>/dev/null)" = "host" ]; then
    cat /proc/net/udp /proc/net/udp6 2>/dev/null
    return 0
  fi

  timeout --kill-after=1s 5s docker exec "$container" sh -c \
    'cat /proc/net/udp /proc/net/udp6 2>/dev/null' 2>/dev/null
}

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
