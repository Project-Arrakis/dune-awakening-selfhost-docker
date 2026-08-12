#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

python3 -c 'compile(open("patches/vehicle-permission-reset/patch.py", encoding="utf-8").read(), "patch.py", "exec")'
grep -q '51a26e1e5c67cceef98fdb34ee4953c2016079216cda4668a6033a017c9e601e' patches/vehicle-permission-reset/patch.py
grep -q '2ed150f8acaf7fe975664ab6021ed2cd8fa4138edf230f050e437b9acaaa2d01' patches/vehicle-permission-reset/patch.py

printf 'not a Funcom binary' >"$tmp_dir/unsupported"
if python3 patches/vehicle-permission-reset/patch.py \
  "$tmp_dir/unsupported" "$tmp_dir/output" >"$tmp_dir/error.log" 2>&1; then
  echo "patcher accepted an unsupported binary" >&2
  exit 1
fi
grep -q 'unsupported Funcom binary' "$tmp_dir/error.log"
[ ! -e "$tmp_dir/output" ]

if python3 patches/vehicle-permission-reset/patch.py \
  "$tmp_dir/unsupported" "$tmp_dir/unsupported" >"$tmp_dir/same-path.log" 2>&1; then
  echo "patcher accepted an in-place patch request" >&2
  exit 1
fi
grep -q 'stock binary is never modified in place' "$tmp_dir/same-path.log"

# shellcheck source=runtime/scripts/image-tags.sh
source runtime/scripts/image-tags.sh
DUNE_GAME_SERVER_IMAGE="example.test/dune:compat"
[ "$(resolve_game_server_image)" = "example.test/dune:compat" ]
unset DUNE_GAME_SERVER_IMAGE
DUNE_WORLD_IMAGE_TAG="test-tag"
[ "$(resolve_game_server_image)" = \
  "registry.funcom.com/funcom/self-hosting/seabass-server:test-tag" ]

fake_bin="$tmp_dir/bin"
mkdir -p "$fake_bin"
printf '#!/usr/bin/env bash\nexit 1\n' >"$fake_bin/docker"
chmod +x "$fake_bin/docker"
DUNE_VEHICLE_PERMISSION_RESET_FIX_ENABLED=true
resolved="$(PATH="$fake_bin:$PATH" resolve_game_server_image 2>"$tmp_dir/fallback-warning")"
[ "$resolved" = "registry.funcom.com/funcom/self-hosting/seabass-server:test-tag" ]
grep -q 'using the official image' "$tmp_dir/fallback-warning"
unset DUNE_VEHICLE_PERMISSION_RESET_FIX_ENABLED

for launcher in \
  runtime/scripts/start-server-overmap.sh \
  runtime/scripts/start-server-survival-1.sh \
  runtime/scripts/spawn-server.sh \
  runtime/scripts/recycle-world-game-servers.sh; do
  grep -q 'resolve_game_server_image' "$launcher"
done

grep -q '^ARG BASE_IMAGE$' patches/vehicle-permission-reset/Dockerfile
grep -q '^FROM \${BASE_IMAGE}$' patches/vehicle-permission-reset/Dockerfile
grep -q 'dune vehicle-fix \[status|auto|build|enable|disable|remove\]' runtime/scripts/dune

detect_line="$(grep -n 'runtime/scripts/detect-image-tags.sh' runtime/scripts/update.sh | cut -d: -f1)"
compat_line="$(grep -n 'runtime/scripts/vehicle-permission-reset-fix.sh auto' runtime/scripts/update.sh | cut -d: -f1)"
start_line="$(grep -n 'runtime/scripts/start-all.sh' runtime/scripts/update.sh | tail -n1 | cut -d: -f1)"
[ "$detect_line" -lt "$compat_line" ]
[ "$compat_line" -lt "$start_line" ]
grep -q 'if image_exists "$PATCHED_IMAGE"' runtime/scripts/vehicle-permission-reset-fix.sh
grep -q 'The update will continue with the official Funcom game-server image' runtime/scripts/vehicle-permission-reset-fix.sh
grep -q 'redblink-dune-game-server:vehicle-permission-reset-' runtime/scripts/storage.sh
grep -q 'redblink-dune-game-server)' runtime/scripts/storage.sh

# Exercise updater-safe behavior in an isolated repository fixture. A known-tag
# image is reused and enabled; an unsupported binary warns but never fails the
# surrounding update or enables a nonexistent compatibility image.
fixture="$tmp_dir/fixture"
mkdir -p \
  "$fixture/runtime/scripts" \
  "$fixture/runtime/generated" \
  "$fixture/patches/vehicle-permission-reset" \
  "$fixture/bin"
cp runtime/scripts/vehicle-permission-reset-fix.sh runtime/scripts/image-tags.sh "$fixture/runtime/scripts/"
cp patches/vehicle-permission-reset/patch.py patches/vehicle-permission-reset/Dockerfile \
  "$fixture/patches/vehicle-permission-reset/"
printf 'DUNE_WORLD_IMAGE_TAG=test-auto-tag\n' >"$fixture/runtime/generated/image-tags.env"
cat >"$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-} ${2:-}" in
  "image inspect")
    case "${3:-}" in
      redblink-dune-game-server:*) [ "${MOCK_PATCHED_EXISTS:-0}" = "1" ] ;;
      registry.funcom.com/*) exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
  "create ") echo fixture-container ;;
  "cp ") printf 'unsupported fixture binary' >"$3" ;;
  "rm ") exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$fixture/bin/docker"

MOCK_PATCHED_EXISTS=1 PATH="$fixture/bin:$PATH" \
  "$fixture/runtime/scripts/vehicle-permission-reset-fix.sh" auto \
  >"$tmp_dir/auto-reuse.log" 2>&1
grep -q '^DUNE_VEHICLE_PERMISSION_RESET_FIX_ENABLED=true$' "$fixture/.env"
grep -q '^DUNE_VEHICLE_PERMISSION_RESET_FIX_AUTO=true$' "$fixture/.env"
grep -q 'already matches Funcom tag test-auto-tag' "$tmp_dir/auto-reuse.log"

rm "$fixture/.env"
if ! PATH="$fixture/bin:$PATH" \
  "$fixture/runtime/scripts/vehicle-permission-reset-fix.sh" auto \
  >"$tmp_dir/auto-fallback.log" 2>&1; then
  echo "automatic compatibility preparation blocked an unsupported update" >&2
  exit 1
fi
grep -q 'The update will continue with the official Funcom game-server image' "$tmp_dir/auto-fallback.log"
[ ! -e "$fixture/.env" ]

printf 'DUNE_GAME_SERVER_IMAGE=example.test/custom:latest\n' >"$fixture/.env"
PATH="$fixture/bin:$PATH" \
  "$fixture/runtime/scripts/vehicle-permission-reset-fix.sh" auto \
  >"$tmp_dir/auto-custom.log" 2>&1
grep -q 'skipping automatic compatibility image preparation' "$tmp_dir/auto-custom.log"
[ "$(wc -l <"$fixture/.env")" -eq 1 ]

printf 'DUNE_VEHICLE_PERMISSION_RESET_FIX_AUTO=false\n' >"$fixture/.env"
PATH="$fixture/bin:$PATH" \
  "$fixture/runtime/scripts/vehicle-permission-reset-fix.sh" auto \
  >"$tmp_dir/auto-disabled.log" 2>&1
grep -q 'Automatic vehicle permission compatibility preparation is disabled' "$tmp_dir/auto-disabled.log"
[ "$(wc -l <"$fixture/.env")" -eq 1 ]

echo "vehicle permission reset fix tests passed"
