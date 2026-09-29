#!/usr/bin/env bash

# Resolution of the stack's configurable host ports.
#
# These live in their own library because two very different classes of script
# need them. runtime-env.sh -- which sources this file -- is the heavyweight
# entrypoint helper that also pulls in Compose project naming, secrets and
# host-file ownership; the hot-path scripts (autoscaler.sh, deepdesert.sh,
# despawn-server.sh, ...) deliberately do not source it and must still be able
# to work out which port Postgres is published on.

# Validate one port-valued environment variable, falling back to the shipped
# default when it is unset or empty. An out-of-range value is a configuration
# error and is reported rather than silently replaced, so a typo in .env cannot
# quietly point the stack at the wrong port.
port_env_value() {
  local key="$1"
  local default_value="$2"
  local value="${!key:-$default_value}"

  if printf '%s' "$value" | grep -Eq '^[0-9]+$' && [ "$value" -ge 1 ] && [ "$value" -le 65535 ]; then
    printf '%s' "$value"
    return 0
  fi

  printf '%s\n' "Invalid $key=$value; expected TCP/UDP port 1-65535." >&2
  return 1
}

resolve_postgres_port() { port_env_value POSTGRES_PORT 15432; }
resolve_rmq_admin_port() { port_env_value RMQ_ADMIN_PORT 32573; }
resolve_rmq_admin_http_port() { port_env_value RMQ_ADMIN_HTTP_PORT 32574; }
resolve_rmq_game_port() { port_env_value RMQ_GAME_PORT 31982; }
resolve_rmq_game_http_port() { port_env_value RMQ_GAME_HTTP_PORT 31983; }
resolve_text_router_port() { port_env_value TEXT_ROUTER_PORT 5059; }
resolve_director_port() { port_env_value DIRECTOR_PORT 11717; }
