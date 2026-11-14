#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

mkdir -p runtime/generated

if [ "${1:-}" = "--from-bundle" ]; then
  # Verify inside the orchestrator, where the downloaded volume and Docker
  # socket are available. Keep existing tags intact on any validation failure.
  tags_tmp="$(mktemp runtime/generated/image-tags.env.tmp.XXXXXX)"
  trap 'rm -f -- "$tags_tmp"' EXIT
  docker compose exec -T orchestrator python3 - \
    < runtime/scripts/verify-game-images.py > "$tags_tmp"
  [ -s "$tags_tmp" ] || { echo "Verified image tags are empty." >&2; exit 1; }
  chmod 644 "$tags_tmp"
  mv -f -- "$tags_tmp" runtime/generated/image-tags.env
  echo "Verified downloaded game images and wrote runtime/generated/image-tags.env"
  cat runtime/generated/image-tags.env
  exit 0
fi

[ "$#" -eq 0 ] || { echo "Usage: $0 [--from-bundle]" >&2; exit 2; }

get_latest_tag() {
  local repo="$1"
  docker images --format '{{.Repository}} {{.Tag}}' \
    | awk -v repo="$repo" '$1 == repo && $2 != "<none>" { print $2 }' \
    | sort -rV \
    | head -n1
}

WORLD_TAG="$(get_latest_tag registry.funcom.com/funcom/self-hosting/seabass-server)"
POSTGRES_TAG="$(get_latest_tag registry.funcom.com/funcom/self-hosting/igw-postgres)"

if [ -z "$WORLD_TAG" ]; then
  echo "Could not detect seabass-server image tag"
  exit 1
fi

if [ -z "$POSTGRES_TAG" ]; then
  echo "Could not detect igw-postgres image tag"
  exit 1
fi

cat > runtime/generated/image-tags.env <<EOF
DUNE_WORLD_IMAGE_TAG=$WORLD_TAG
DUNE_POSTGRES_IMAGE_TAG=$POSTGRES_TAG
EOF

echo "Wrote runtime/generated/image-tags.env"
cat runtime/generated/image-tags.env
