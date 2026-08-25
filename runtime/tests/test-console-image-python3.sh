#!/usr/bin/env bash
# Regression test for issue #489: the console image must install python3
# EXPLICITLY, not inherit it from the base image.
#
# python3 used to arrive for free from node:20-bookworm (full Debian, ships
# python3-minimal). Commit c248780e (2026-08-20) bumped the base to
# node:24-trixie-slim for Trivy CVE remediation (issue #54); the slim variant
# does not ship it. Nothing failed at build time or in CI, and the breakage
# stayed invisible for five days because it only surfaces once the image is
# rebuilt -- at which point the console's Home panel dies.
#
# It matters because console/api/src/runner.js spawns `dune` with a plain local
# spawn (cwd=/repo), so every dune subcommand the Web Console runs executes
# INSIDE this container, not on the operator's host. runtime-env.sh shells out
# to python3 while resolving engine values, and runner.js spawns python3
# directly for the `usersettings` path -- so an image without it makes
# `dune status` exit 127 with empty stdout, which the UI renders as the generic
# "Server status is unavailable" with no hint at the real cause.
#
# This checks the Dockerfile text directly rather than building the image, so it
# runs anywhere this repo's tests already run. It cannot catch a python3 that is
# listed but fails to install -- the container-lifecycle CI job covers that by
# actually building and running the image.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
dockerfile="$repo_root/console/api/Dockerfile"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$dockerfile" ] || fail "$dockerfile not found"

# Match python3 as its own apt package entry in the install list, not a
# substring of some other token (python3-yaml, python3.11-dev, ...).
grep -qE '^[[:space:]]*python3[[:space:]]*\\?[[:space:]]*$' "$dockerfile" \
  || fail "console/api/Dockerfile does not install python3 -- the Web Console runs dune scripts in-container and they shell out to python3, so \`dune status\` will exit 127 and the Home panel will show only 'Server status is unavailable' (issue #489)"

echo "PASS: console/api/Dockerfile installs python3"
