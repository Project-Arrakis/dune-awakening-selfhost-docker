#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a
[ ! -f .env ] || source .env
[ ! -r runtime/generated/image-tags.env ] || source runtime/generated/image-tags.env
set +a
exec python3 runtime/scripts/experimental_tanks.py "$@"
