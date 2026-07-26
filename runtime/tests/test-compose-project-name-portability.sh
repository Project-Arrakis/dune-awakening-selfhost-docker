#!/usr/bin/env bash
# Guards against the exact PR #108 / 443152d incident: a hardcoded
# `name:` field in a docker-compose.*.yml file, or any other change
# that makes the resolved Compose project name (and therefore every
# named volume) depend on something other than the operator's own
# install directory basename.
#
# Real incident: PR #108 (2026-07-25) added `name: dune-awakening-selfhost-docker`
# to docker-compose.yml/docker-compose.metrics.yml. It was "verified"
# via `docker compose config` showing a no-op -- but that check only
# ever ran against a host whose directory happens to already be named
# `dune-awakening-selfhost-docker`, so it could never have caught the
# real bug: an operator whose install directory has any other name
# would get a *different*, fresh, empty volume set on their next
# `docker compose up`, silently orphaning their real game/database
# data with no error. Upstream reverted it within minutes
# (443152d, "fix(compose): preserve existing project volume names").
#
# This test reproduces that exact scenario using a `git worktree`
# checked out under a deliberately different directory name, so the
# check is meaningful regardless of what this repo's own directory is
# named on whichever host runs it.
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# 1. Static check: no compose file that declares top-level, persistent
#    NAMED VOLUMES may also hardcode a project 'name:'. The real risk
#    from the 443152d incident is specifically about named volumes --
#    a hardcoded name in a compose file with no data volumes at stake
#    (e.g. docker-compose.web.yml, which only uses bind mounts and
#    explicit container_name: fields to keep the console's container
#    name predictable across install directories) is a different,
#    deliberate, safe pattern and must not be flagged here.
for f in docker-compose.yml docker-compose.metrics.yml \
         docker-compose.web.yml docker-compose.public-probe.yml; do
  [ -f "$f" ] || continue
  has_hardcoded_name="$(grep -qE '^name:[[:space:]]*\S' "$f" && echo 1 || echo 0)"
  [ "$has_hardcoded_name" = "1" ] || continue

  has_named_volumes="$(python3 -c "
import sys, yaml
d = yaml.safe_load(open('$f')) or {}
print(1 if d.get('volumes') else 0)
" 2>/dev/null || echo 1)"  # fail safe: assume risky if the check itself errors

  if [ "$has_named_volumes" = "1" ]; then
    fail "$f hardcodes a Compose project 'name:' field AND declares" \
         "top-level named volumes. This makes every operator whose" \
         "install directory isn't named exactly that string get a" \
         "different, fresh volume set on their next 'docker compose" \
         "up', silently orphaning their existing data. See" \
         "docker-compose.yml's own history (443152d) for the real" \
         "incident this check exists to prevent. Do not add this back" \
         "without a real, tested, per-operator-safe migration path."
  fi
done

# 2. Behavioral check: prove the resolved project name (and therefore
#    every named volume) actually still tracks the directory basename,
#    using a real differently-named worktree -- not an assumption.
WORKTREE_DIR="$(mktemp -d)/renamed-install-test-$$"
cleanup() { git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true; }
trap cleanup EXIT

git worktree add --detach --quiet "$WORKTREE_DIR" HEAD

resolved_name="$(cd "$WORKTREE_DIR" && docker compose config 2>/dev/null \
  | grep -E '^name:' | awk '{print $2}')"
expected_name="$(basename "$WORKTREE_DIR")"

if [ "$resolved_name" != "$expected_name" ]; then
  fail "docker compose config resolved project name to" \
       "'$resolved_name' inside a worktree named '$expected_name'." \
       "The resolved project name must always match the operator's" \
       "own install directory basename -- anything else means" \
       "volumes will not be found on the next 'docker compose up' for" \
       "operators whose directory isn't named the same as this host's."
fi

echo "PASS: Compose project name tracks install directory basename" \
     "(verified in a real differently-named worktree: '$expected_name')," \
     "no hardcoded 'name:' field present in any compose file."
