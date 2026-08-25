#!/usr/bin/env bash
# Regression test: CONSOLE_TOTP_ENABLED (RFC docs/rfc-console-auth.md
# §2.3/§4, #407) is documented as an operator-facing flag in .env.example
# but was never wired into docker-compose.web.yml's console service
# environment block -- despite six merged Tier 3 implementation phases, the
# flag was unreachable in any real docker-compose deployment regardless of
# what an operator set in .env. Found while E2E-testing #482/#484 on
# dune-dev. This does not need Docker -- it just checks the compose YAML
# text directly, so it runs anywhere this repo's tests already run.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
compose_file="$repo_root/docker-compose.web.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$compose_file" ] || fail "$compose_file not found"

grep -qE '^\s*CONSOLE_TOTP_ENABLED:\s*"\$\{CONSOLE_TOTP_ENABLED:-' "$compose_file" \
  || fail "CONSOLE_TOTP_ENABLED is not passed through to the console service in docker-compose.web.yml -- an operator setting it in .env has no effect on the running container"

echo "PASS: CONSOLE_TOTP_ENABLED is wired into docker-compose.web.yml's console environment"
