#!/usr/bin/env bash
# Static test for issue #246: every long-lived container this repo starts
# via a raw `docker run` (not docker-compose.*.yml, which already labels
# its own services via Compose itself) must carry an explicit
# `com.docker.compose.project=${DUNE_COMPOSE_PROJECT_NAME}` label. Without
# it, cAdvisor/the addon's ops.health.containers bridge action (scoped by
# that same label, see dune-awakening-selfhost-docker#244/#246) cannot see
# these containers at all -- confirmed live: dune-postgres, dune-rmq-admin,
# dune-rmq-game, dune-director, dune-text-router, and every dune-server-*
# instance previously had no such label (dune-postgres had the WRONG one,
# "postgres", from an unrelated Compose invocation).
#
# This is a static grep test, not a live Docker test, deliberately --
# it verifies the fix is present in source, matching this repo's existing
# test-compose-project-name-portability.sh precedent for this class of
# "does every script agree on one convention" regression.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# script:container-name pairs -- every raw `docker run` this repo issues
# for a long-lived Dune-managed container, per issue #246's evidence.
# dune-autoscaler (start-autoscaler.sh) is deliberately excluded: issue
# #246's own live evidence showed it already reporting the correct
# Compose project via cAdvisor with no explicit label present, and it
# does not source runtime-env.sh the way every script below does.
declare -a checks=(
  "runtime/scripts/start-postgres.sh:dune-postgres"
  "runtime/scripts/start-rabbitmq.sh:dune-rmq-admin"
  "runtime/scripts/start-rabbitmq.sh:dune-rmq-game"
  "runtime/scripts/start-director.sh:dune-director"
  "runtime/scripts/start-text-router.sh:dune-text-router"
  "runtime/scripts/start-server-gateway.sh:dune-server-gateway"
  "runtime/scripts/start-server-overmap.sh:dune-server-overmap"
  "runtime/scripts/start-server-survival-1.sh:dune-server-survival-1"
)

for check in "${checks[@]}"; do
  script="${check%%:*}"
  container="${check##*:}"
  path="$repo_root/$script"
  [ -f "$path" ] || fail "$script does not exist -- update this test's container inventory"

  # The --label line must appear between this container's --name line and
  # the next --name (or end of the docker run invocation) -- a plain
  # whole-file grep would pass even if the label were attached to some
  # OTHER container's docker run in the same script (start-rabbitmq.sh
  # starts two containers from one script).
  name_line="$(grep -n -- "--name \"\?$container\"\?" "$path" | head -1 | cut -d: -f1)"
  [ -n "$name_line" ] || fail "$script: no 'docker run ... --name $container' found"

  # Look at a small window after the --name line for the label -- real
  # docker run invocations in this repo are one argument per line.
  window_end=$((name_line + 5))
  found="$(sed -n "${name_line},${window_end}p" "$path" | grep -c -- '--label "com.docker.compose.project=${DUNE_COMPOSE_PROJECT_NAME}"' || true)"
  [ "$found" -ge 1 ] || fail "$script: $container's docker run does not set --label com.docker.compose.project=\${DUNE_COMPOSE_PROJECT_NAME} within 5 lines of --name"
done

# spawn-server.sh is dynamic (one script, N possible container names via
# $CONTAINER_NAME) -- checked separately by pattern, not a fixed name.
spawn_path="$repo_root/runtime/scripts/spawn-server.sh"
spawn_name_line="$(grep -n -- '--name "\$CONTAINER_NAME"' "$spawn_path" | head -1 | cut -d: -f1)"
[ -n "$spawn_name_line" ] || fail "spawn-server.sh: no 'docker run ... --name \"\$CONTAINER_NAME\"' found"
spawn_window_end=$((spawn_name_line + 5))
spawn_found="$(sed -n "${spawn_name_line},${spawn_window_end}p" "$spawn_path" | grep -c -- '--label "com.docker.compose.project=${DUNE_COMPOSE_PROJECT_NAME}"' || true)"
[ "$spawn_found" -ge 1 ] || fail "spawn-server.sh: \$CONTAINER_NAME's docker run does not set --label com.docker.compose.project=\${DUNE_COMPOSE_PROJECT_NAME} within 5 lines of --name"

echo "PASS: every raw docker-run-managed container carries an explicit com.docker.compose.project label"
