#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$TEST_ROOT/repo/runtime/generated" "$TEST_ROOT/bin"
cp "$REPO_ROOT/runtime/scripts/fake-k8s-serviceaccount.sh" "$TEST_ROOT/repo/helper.sh"

cat > "$TEST_ROOT/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_DOCKER_CALLS"
case "${1:-}" in
  ps)
    [ "${FAKE_DOCKER_PS_FAIL:-0}" = "0" ] || exit 1
    printf '%s\n' container-running container-stopped
    ;;
  inspect)
    [ "${FAKE_DOCKER_INSPECT_FAIL:-0}" = "0" ] || exit 1
    printf '%s\n' \
      "$FAKE_HOST_ROOT/runtime/generated/dune-fake-k8s-serviceaccount-mounted-running-100" \
      "$FAKE_HOST_ROOT/runtime/generated/dune-fake-k8s-serviceaccount-mounted-stopped-200"
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod +x "$TEST_ROOT/bin/docker"

export PATH="$TEST_ROOT/bin:$PATH"
export FAKE_DOCKER_CALLS="$TEST_ROOT/docker.calls"
export FAKE_HOST_ROOT="$TEST_ROOT/host-repo"

cd "$TEST_ROOT/repo"
source ./helper.sh

host_path() {
  local path="$1"
  printf '%s/%s\n' "$FAKE_HOST_ROOT" "${path#"$PWD"/}"
}

stable_dir="$(fake_k8s_serviceaccount_dir survival-1)"
if [ "$stable_dir" != "$PWD/runtime/generated/dune-fake-k8s-serviceaccount-survival-1" ]; then
  echo "FAIL stable path: $stable_dir"
  exit 1
fi

prepare_fake_k8s_serviceaccount "$stable_dir" funcom-seabass-test
if [ "$(cat "$stable_dir/namespace")" != "funcom-seabass-test" ] \
  || [ "$(cat "$stable_dir/token")" != "fake-token" ] \
  || [ -s "$stable_dir/ca.crt" ] \
  || [ ! -f "${stable_dir}.stable" ]; then
  echo "FAIL stable preparation"
  exit 1
fi

mounted_running="$PWD/runtime/generated/dune-fake-k8s-serviceaccount-mounted-running-100"
mounted_stopped="$PWD/runtime/generated/dune-fake-k8s-serviceaccount-mounted-stopped-200"
stale="$PWD/runtime/generated/dune-fake-k8s-serviceaccount-stale-300"
mkdir -p "$mounted_running" "$mounted_stopped" "$stale"

prune_legacy_fake_k8s_serviceaccounts

if [ ! -d "$mounted_running" ] || [ ! -d "$mounted_stopped" ]; then
  echo "FAIL mounted legacy directories were removed"
  exit 1
fi
if [ -e "$stale" ]; then
  echo "FAIL unmounted legacy directory was retained"
  exit 1
fi
if [ ! -d "$stable_dir" ]; then
  echo "FAIL stable directory was removed"
  exit 1
fi
if ! grep -Fxq 'ps -aq' "$FAKE_DOCKER_CALLS" \
  || ! grep -q '^inspect .*container-running container-stopped$' "$FAKE_DOCKER_CALLS"; then
  echo "FAIL cleanup did not inspect running and stopped containers"
  exit 1
fi

inspect_guard="$PWD/runtime/generated/dune-fake-k8s-serviceaccount-inspect-failure-400"
mkdir -p "$inspect_guard"
export FAKE_DOCKER_INSPECT_FAIL=1
prune_legacy_fake_k8s_serviceaccounts
if [ ! -d "$inspect_guard" ]; then
  echo "FAIL cleanup did not fail closed after Docker inspect failure"
  exit 1
fi
unset FAKE_DOCKER_INSPECT_FAIL

ps_guard="$PWD/runtime/generated/dune-fake-k8s-serviceaccount-ps-failure-500"
mkdir -p "$ps_guard"
export FAKE_DOCKER_PS_FAIL=1
prune_legacy_fake_k8s_serviceaccounts
if [ ! -d "$ps_guard" ]; then
  echo "FAIL cleanup did not fail closed after Docker ps failure"
  exit 1
fi

echo "Fake Kubernetes service-account cleanup tests passed."
