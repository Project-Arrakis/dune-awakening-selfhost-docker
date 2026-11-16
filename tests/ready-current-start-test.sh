#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
# Exercise the actual helper without running the rest of the readiness command.
eval "$(sed -n '/^container_logs() {/,/^}/p' "$repo_root/runtime/scripts/ready.sh")"
export log_tail_lines=4000
inspection=ok
current_log='Current process is warming up'
docker_timeout() {
  if [ "$2" = inspect ]; then
    [ "$inspection" = ok ] || return 1
    printf '%s\n' '2026-10-06T09:16:07Z'
  elif [ "$2" = logs ]; then
    # An unscoped query would return the previous attempt's fatal error.
    if [ "$3" != --since ] || [ "$4" != '2026-10-06T09:16:07Z' ]; then
      printf '%s\n' 'Segmentation fault (core dumped)'
    else
      printf '%s\n' "$current_log"
    fi
  else
    return 1
  fi
}
[ "$(container_logs dune-server-survival-1)" = "$current_log" ]
current_log='Segmentation fault (core dumped)'
[ "$(container_logs dune-server-survival-1)" = "$current_log" ]
inspection=failed
[ -z "$(container_logs dune-server-survival-1)" ]
printf '%s\n' 'Readiness uses only current-start logs and preserves current fatal errors.'
