#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mapfile -t compose_files < <(git ls-files 'docker-compose*.yml' 'compose*.yml' | sort)
[ "${#compose_files[@]}" -gt 0 ] || fail "no tracked Compose files were found"

for compose_file in "${compose_files[@]}"; do
  python3 - "$compose_file" <<'PY'
import re
import sys

path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines()
has_fixed_name = any(re.match(r"^name\s*:", line) for line in lines)
has_named_volumes = False

for index, line in enumerate(lines):
    if not re.match(r"^volumes\s*:\s*(?:#.*)?$", line):
        continue
    for child in lines[index + 1:]:
        if child and not child[0].isspace():
            break
        stripped = child.strip()
        if stripped and not stripped.startswith("#") and re.match(r"^[^:#][^:]*\s*:", stripped):
            has_named_volumes = True
            break

if has_fixed_name and has_named_volumes:
    print(f"FAIL: {path} fixes the Compose project name while declaring persistent named volumes", file=sys.stderr)
    raise SystemExit(1)
PY
done

test_root="$(mktemp -d)"
worktree_dir="$test_root/renamed-dune-install"
cleanup() {
  git worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true
  rm -rf "$test_root"
}
trap cleanup EXIT

git worktree add --detach "$worktree_dir" HEAD >/dev/null

compose_project_name() {
  local compose_json
  compose_json="$(cd "$worktree_dir" && env -u COMPOSE_PROJECT_NAME docker compose "$@" config --format json)"
  python3 -c 'import json, sys; print(json.load(sys.stdin)["name"])' <<<"$compose_json"
}

expected_name="$(basename "$worktree_dir")"
main_name="$(compose_project_name -f docker-compose.yml)"
[ "$main_name" = "$expected_name" ] || fail "main Compose project resolved as '$main_name', expected '$expected_name'"

metrics_name="$(compose_project_name -f docker-compose.yml -f docker-compose.metrics.yml)"
[ "$metrics_name" = "$expected_name" ] || fail "main + metrics Compose project resolved as '$metrics_name', expected '$expected_name'"

echo "PASS: tracked Compose files preserve directory-derived project naming for persistent volumes"
