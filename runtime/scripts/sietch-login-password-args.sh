#!/usr/bin/env bash

# GHSA-fc89-h24v-6j3x (issue #252): ServerLoginPassword/ServerPassword were
# previously passed to the game binary as `docker run` positional arguments
# (sourced from sietches.sh's `runtime-args` output), visible in plaintext
# via `ps aux`/`/proc/<pid>/cmdline` and `docker inspect --format
# '{{json .Args}}'` to anyone with host or Docker-socket access. Confirmed
# via two live, real-player join tests (2026-08-12) that the game binary
# accepts both values via environment variable instead -- both the bare and
# BackendLoginConfiguration__-prefixed forms, mirroring the alias convention
# already used for the related ServerLoginPasswordSecret value in each
# launcher script's own `docker run` invocation.
#
# Extracted into this shared, sourced helper (matching the existing
# sietch-name.sh pattern) rather than duplicated across spawn-server.sh,
# start-server-survival-1.sh, and start-server-overmap.sh, per this
# codebase's own established convention for logic shared across launcher
# scripts (see host-paths.sh, runtime-env.sh, image-tags.sh, all `source`d
# by the same three files).

# sietch_login_password_docker_args <name-of-array-holding-sietch-runtime-args> <name-of-output-args-array> <name-of-output-filtered-array>
#
# Reads the array named by $1 (typically SIETCH_RUNTIME_ARGS, as populated
# from `sietches.sh runtime-args`'s output), and:
#   - populates the array named by $2 with the -e "KEY=value" docker run
#     flags for ServerLoginPassword/ServerPassword (bare + prefixed alias),
#     if either was present.
#   - populates the array named by $3 with a copy of $1's contents, minus
#     the -ServerLoginPassword=/-ServerPassword= positional-argument
#     entries specifically (all other positional args, e.g.
#     -ServerDisplayName=, are preserved unchanged).
#
# Uses bash nameref (`local -n`) rather than a subshell/stdout-based
# interface so the caller's own arrays are populated directly, matching
# this script's existing `mapfile -t ARRNAME < <(...)` style without
# requiring an extra subprocess.
sietch_login_password_docker_args() {
  # Defensive guard (Requirement 20 L3 Architect-hat finding, 2026-08-12):
  # this function has three separate nameref parameters (one input, two
  # output). If a future caller ever passes the same variable name for two
  # of the three, bash namerefs would alias them to the same underlying
  # array -- and because the two output arrays are each zeroed (`=()`)
  # before being rebuilt, an alias with the input array would silently
  # wipe the source data before it's fully read, producing an empty result
  # instead of a loud error. No current call site does this (all three
  # launcher scripts pass three distinct literal names), but fail loudly
  # here rather than leave this as a silent, future footgun.
  if [ "$1" = "$2" ] || [ "$1" = "$3" ] || [ "$2" = "$3" ]; then
    echo "sietch_login_password_docker_args: BUG: all three array-name arguments must be distinct (got: \$1=$1 \$2=$2 \$3=$3)" >&2
    return 1
  fi

  local -n _sietch_source_args="$1"
  local -n _sietch_output_login_args="$2"
  local -n _sietch_output_filtered_args="$3"

  local _sietch_login_password=""
  local _sietch_server_password=""
  local _sietch_arg

  for _sietch_arg in "${_sietch_source_args[@]}"; do
    case "$_sietch_arg" in
      -ServerLoginPassword=*) _sietch_login_password="${_sietch_arg#-ServerLoginPassword=}" ;;
      -ServerPassword=*) _sietch_server_password="${_sietch_arg#-ServerPassword=}" ;;
    esac
  done

  _sietch_output_login_args=()
  if [ -n "$_sietch_login_password" ]; then
    _sietch_output_login_args+=(
      -e "ServerLoginPassword=$_sietch_login_password"
      -e "BackendLoginConfiguration__ServerLoginPassword=$_sietch_login_password"
    )
  fi
  if [ -n "$_sietch_server_password" ]; then
    _sietch_output_login_args+=(
      -e "ServerPassword=$_sietch_server_password"
      -e "BackendLoginConfiguration__ServerPassword=$_sietch_server_password"
    )
  fi

  _sietch_output_filtered_args=()
  for _sietch_arg in "${_sietch_source_args[@]}"; do
    case "$_sietch_arg" in
      -ServerLoginPassword=*|-ServerPassword=*) continue ;;
    esac
    _sietch_output_filtered_args+=("$_sietch_arg")
  done
}
