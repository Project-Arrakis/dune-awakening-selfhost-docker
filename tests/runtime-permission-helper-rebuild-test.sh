#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fixture="$test_root/project"
mkdir -p "$fixture/runtime/scripts" "$fixture/runtime/generated" \
  "$fixture/runtime/logs" "$fixture/runtime/text-router" "$fixture/orchestrator" \
  "$test_root/bin"
cp "$repo_root/runtime/scripts/repair-host-runtime-permissions.sh" \
  "$repo_root/runtime/scripts/host-paths.sh" "$fixture/runtime/scripts/"
printf 'FROM scratch\n' > "$fixture/orchestrator/Dockerfile"

cat > "$test_root/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_DOCKER_LOG:?}"
case "${1:-} ${2:-}" in
  "image inspect") [ -f "${FAKE_DOCKER_IMAGE_STATE:?}" ] ;;
  "build --tag")
    [ "${3:-}" = "dune-orchestrator:dev" ]
    [ "${4:-}" = "orchestrator" ]
    : > "$FAKE_DOCKER_IMAGE_STATE"
    ;;
  "run --rm") exit 0 ;;
  *) echo "Unexpected fake Docker call: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$test_root/bin/docker"

export PATH="$test_root/bin:$PATH"
export FAKE_DOCKER_LOG="$test_root/docker.log"
export FAKE_DOCKER_IMAGE_STATE="$test_root/image-present"

output="$(
  cd "$fixture"
  DUNE_RUNTIME_REPO_ROOT="$fixture" \
    DUNE_RUNTIME_HOST_REPO_ROOT="$fixture" \
    runtime/scripts/repair-host-runtime-permissions.sh
)"
grep -Fq 'Runtime permission helper image is missing; rebuilding dune-orchestrator:dev...' <<<"$output"
grep -Fxq 'build --tag dune-orchestrator:dev orchestrator' "$FAKE_DOCKER_LOG"
[ -f "$FAKE_DOCKER_IMAGE_STATE" ]

rm -f "$FAKE_DOCKER_IMAGE_STATE"
: > "$FAKE_DOCKER_LOG"
if (
  cd "$fixture"
  DUNE_RUNTIME_REPO_ROOT="$fixture" \
    DUNE_RUNTIME_HOST_REPO_ROOT="$fixture" \
    DUNE_RUNTIME_PERMISSION_HELPER_IMAGE="custom-helper:test" \
    runtime/scripts/repair-host-runtime-permissions.sh
) >"$test_root/custom.log" 2>&1; then
  echo "A missing custom helper image unexpectedly succeeded." >&2
  exit 1
fi
grep -Fq 'Docker image not found: custom-helper:test' "$test_root/custom.log"
if grep -q '^build ' "$FAKE_DOCKER_LOG"; then
  echo "A custom helper override was unexpectedly rebuilt." >&2
  exit 1
fi

echo "runtime permission helper rebuild tests passed"
