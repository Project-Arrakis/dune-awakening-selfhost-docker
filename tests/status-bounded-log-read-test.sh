#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
status_script="$repo_root/runtime/scripts/status.sh"

bash -n "$status_script"

grep -Fq 'docker_timeout_seconds="${DUNE_STATUS_DOCKER_TIMEOUT_SECONDS:-12}"' "$status_script"
grep -Fq 'log_tail_lines="${DUNE_STATUS_LOG_TAIL_LINES:-4000}"' "$status_script"

while IFS= read -r log_read; do
  if [[ "$log_read" != *"docker_timeout docker logs --tail"* ]]; then
    printf 'Found an unbounded or non-time-limited status log read:\n%s\n' "$log_read" >&2
    exit 1
  fi
done < <(grep -E '^[[:space:]]*(logs="\$\()?[^#]*docker(_timeout)? docker logs|^[[:space:]]*docker(_timeout)? docker logs' "$status_script")

if grep -Fq 'docker logs "$container"' "$status_script"; then
  printf 'map_state must not read a container\x27s complete log history.\n' >&2
  exit 1
fi

echo "status.sh bounds and time-limits every Docker log read"
