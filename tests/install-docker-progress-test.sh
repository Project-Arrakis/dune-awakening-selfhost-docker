#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

grep -Fq 'if ! need_sudo sh "$get_docker_script"; then' install.sh \
  || fail "Docker installer execution is not streamed directly to the terminal"

if grep -Fq 'error=$(need_sudo sh "$get_docker_script"' install.sh; then
  fail "Docker installer output is still captured and hidden"
fi

grep -Fq 'Review the installer output above for the cause.' install.sh \
  || fail "Docker installation failure does not direct users to the streamed error"

echo "PASS: Docker installation progress remains visible"
