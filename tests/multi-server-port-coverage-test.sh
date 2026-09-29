#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# lib/ports.sh is the single statement of which host ports the stack publishes
# and what they default to. multi-server-config.py has to know every one of
# them: it strides them per instance, writes them into .env on `apply`, checks
# them on `verify`, and -- most importantly -- walks them to prove no two
# managed host ports collide across VMs.
#
# A resolver that exists in lib/ports.sh but not in SERVICE_DEFAULT_PATTERNS is
# invisible to all four. RMQ_ADMIN_HTTP_PORT shipped that way: the planner
# printed no line for it, `apply` never wrote it, and the collision check could
# not see 32574 -- while the multi-server guide already told operators VM2
# "should show" RMQ_ADMIN_HTTP_PORT=33574, a value no command could produce.
#
# The check is one-directional on purpose. Every resolver must be planned, but
# not every planned port comes from a resolver: rmq_game_local_http, admin_web
# and prometheus are parsed out of their own sources by dedicated helpers.

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

python3 - <<'PY' || fail "the planner does not cover every port in lib/ports.sh"
import re
import sys
from pathlib import Path

ports_lib = Path("runtime/scripts/lib/ports.sh").read_text()
planner = Path("runtime/scripts/multi-server-config.py").read_text()

resolvers = dict(
    (match.group(2), match.group(1))
    for match in re.finditer(
        r"^(resolve_\w+)\(\)\s*\{\s*port_env_value\s+(\w+)\s+\d+\s*;\s*\}$",
        ports_lib,
        re.MULTILINE,
    )
)
if not resolvers:
    print("no resolvers found in lib/ports.sh -- has its shape changed?", file=sys.stderr)
    raise SystemExit(1)

table = re.search(
    r"SERVICE_DEFAULT_PATTERNS = \{(.*?)\n\}", planner, re.DOTALL
)
if not table:
    print("SERVICE_DEFAULT_PATTERNS is no longer where this test looks for it", file=sys.stderr)
    raise SystemExit(1)

planned = dict(
    (match.group(2), match.group(3))
    for match in re.finditer(
        r'"(\w+)":\s*\("(\w+)",\s*"(\w+)"\)', table.group(1)
    )
)

status = 0
for env_key, resolver in sorted(resolvers.items()):
    if env_key not in planned:
        print(
            f"{env_key} is resolved by lib/ports.sh but absent from "
            f"SERVICE_DEFAULT_PATTERNS: multi-server-config.py cannot stride it, "
            f"write it, verify it or check it for collisions",
            file=sys.stderr,
        )
        status = 1
    elif planned[env_key] != resolver:
        print(
            f"{env_key} is planned via {planned[env_key]}() but lib/ports.sh "
            f"defines {resolver}()",
            file=sys.stderr,
        )
        status = 1

raise SystemExit(status)
PY

# The planner has to actually run, and a loopback-only port must not appear in
# the NAT plan -- forwarding the admin broker's management API is precisely the
# exposure the loopback bind exists to prevent.
plan="$(python3 runtime/scripts/multi-server-config.py plan --instances 2)"

printf '%s\n' "$plan" | grep -Fq 'RMQ Admin HTTP TCP  : 32574' \
  || fail "VM1 does not plan the documented RMQ_ADMIN_HTTP_PORT default"
printf '%s\n' "$plan" | grep -Fq 'RMQ Admin HTTP TCP  : 33574' \
  || fail "VM2 does not plan RMQ_ADMIN_HTTP_PORT=33574, which the guide tells operators to expect"

printf '%s\n' "$plan" | awk '/Public NAT/,/informational/' | grep -Fq '32574' \
  && fail "the admin broker's management port is loopback-only and must never be in the NAT plan"

echo "multi-server-config.py covers every port lib/ports.sh resolves"
