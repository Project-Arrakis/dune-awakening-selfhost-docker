import test from "node:test";
import assert from "node:assert/strict";
import { parseMemorySwapStatus } from "../src/services/memorySwap.js";

test("memory swap status parser exposes safe typed values", () => {
  const status = parseMemorySwapStatus(`enabled=1
host_pool_active=1
pool_gib=8
per_server_gib=2
recommended_pool_gib=8
world_server_count=4
existing_swap_gib=0
physical_memory_gib=64
safe_available_disk_gib=120
swappiness=10
swap_file=/var/lib/dune-awakening/swapfile
`);
  assert.deepEqual(status, {
    enabled: true,
    hostPoolActive: true,
    poolGiB: 8,
    perServerGiB: 2,
    recommendedPoolGiB: 8,
    worldServerCount: 4,
    existingSwapGiB: 0,
    physicalMemoryGiB: 64,
    safeAvailableDiskGiB: 120,
    swappiness: "10",
    swapFile: "/var/lib/dune-awakening/swapfile"
  });
});

test("memory swap status parser rejects malformed numeric values", () => {
  const status = parseMemorySwapStatus("enabled=yes\npool_gib=-5\nper_server_gib=bad\n");
  assert.equal(status.enabled, false);
  assert.equal(status.poolGiB, 0);
  assert.equal(status.perServerGiB, 2);
});
