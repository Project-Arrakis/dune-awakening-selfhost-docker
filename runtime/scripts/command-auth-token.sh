#!/usr/bin/env bash

# The game server currently expects this compatibility fallback when no
# installation-specific override is configured.
BUILTIN_COMMAND_AUTH_TOKEN="Nu6VmPWUMvdPMeB7qErr"

command_auth_token() {
  if [ -n "${DUNE_COMMAND_AUTH_TOKEN:-}" ]; then
    printf '%s' "$DUNE_COMMAND_AUTH_TOKEN"
    return 0
  fi

  printf '%s' "$BUILTIN_COMMAND_AUTH_TOKEN"
}
