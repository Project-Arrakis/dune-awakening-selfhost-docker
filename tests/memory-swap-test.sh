#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
source runtime/scripts/memory-swap-common.sh

DUNE_MEMORY_SWAP_ENABLED=0
DUNE_MEMORY_SWAP_PER_SERVER_GIB=2
[ "$(memory_swap_total_for_limit 12g)" = "12g" ]

DUNE_MEMORY_SWAP_ENABLED=1
[ "$(memory_swap_total_for_limit 12g)" = "14336m" ]
[ "$(memory_swap_total_for_limit 3072m)" = "5120m" ]

# The following patterns intentionally inspect literal shell expressions.
# shellcheck disable=SC2016
for script in runtime/scripts/start-server-survival-1.sh runtime/scripts/start-server-overmap.sh runtime/scripts/spawn-server.sh; do
  grep -Fq -- '--memory-swap "$(memory_swap_total_for_limit "$MEMORY")"' "$script"
done

grep -Fq 'docker run --rm --user 0:0 --privileged --pid=host' runtime/scripts/memory-swap.sh
grep -Fq 'SWAP_DIR="/var/lib/dune-awakening"' runtime/scripts/memory-swap-host.sh
# shellcheck disable=SC2016
grep -Fq 'SWAP_FILE="$SWAP_DIR/swapfile"' runtime/scripts/memory-swap-host.sh
grep -Fq 'Memory Swap preserves at least 25 GiB or 10%' runtime/scripts/memory-swap-host.sh
# shellcheck disable=SC2016
grep -Fq 'remove_marked_block "$FSTAB"' runtime/scripts/memory-swap-host.sh

echo "memory swap calculations, lifecycle integration, and host safeguards passed"
