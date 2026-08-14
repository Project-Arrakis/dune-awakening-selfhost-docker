#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/bin"
cat > "$test_root/bin/id" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-u" ]; then
  echo 0
elif [ "${1:-}" = "-g" ]; then
  echo 0
else
  exec /usr/bin/id "$@"
fi
EOF
chmod +x "$test_root/bin/id"

set +e
direct_root_output="$(PATH="$test_root/bin:$PATH" SUDO_USER= sh ./install.sh 2>&1)"
direct_root_status=$?
sudo_root_output="$(PATH="$test_root/bin:$PATH" SUDO_USER=ubuntu sh ./install.sh 2>&1)"
sudo_root_status=$?
set -e

[ "$direct_root_status" -ne 0 ] || fail "direct root installation was not rejected"
grep -Fq 'This project must not be installed as root.' <<<"$direct_root_output" \
  || fail "direct root rejection is not explained"
grep -Fq 'adduser dune' <<<"$direct_root_output" \
  || fail "Debian/Ubuntu root guidance does not explain how to create a regular user"
grep -Fq 'usermod -aG sudo dune' <<<"$direct_root_output" \
  || fail "Debian/Ubuntu root guidance does not grant sudo access"

[ "$sudo_root_status" -ne 0 ] || fail "sudo installer invocation was not rejected"
grep -Fq 'The installer was started with sudo.' <<<"$sudo_root_output" \
  || fail "sudo invocation rejection is not explained"
grep -Fq './install.sh' <<<"$sudo_root_output" \
  || fail "sudo invocation guidance does not provide the corrected command"

grep -Fq 'if ! need_sudo sh "$get_docker_script"; then' install.sh \
  || fail "Docker installer execution is not streamed directly to the terminal"

if grep -Fq 'error=$(need_sudo sh "$get_docker_script"' install.sh; then
  fail "Docker installer output is still captured and hidden"
fi

grep -Fq 'Review the installer output above for the cause.' install.sh \
  || fail "Docker installation failure does not direct users to the streamed error"

echo "PASS: installer rejects root safely and Docker installation progress remains visible"
