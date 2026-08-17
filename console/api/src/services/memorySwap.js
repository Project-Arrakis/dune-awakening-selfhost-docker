export function parseMemorySwapStatus(stdout = "") {
  const values = Object.fromEntries(String(stdout).split(/\r?\n/).map((line) => {
    const index = line.indexOf("=");
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : [];
  }).filter((entry) => entry.length === 2));
  const integer = (key, fallback = 0) => {
    const value = Number(values[key]);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  };
  return {
    enabled: values.enabled === "1",
    hostPoolActive: values.host_pool_active === "1",
    poolGiB: integer("pool_gib"),
    perServerGiB: integer("per_server_gib", 2),
    recommendedPoolGiB: integer("recommended_pool_gib", 1),
    worldServerCount: integer("world_server_count", 2),
    existingSwapGiB: integer("existing_swap_gib"),
    physicalMemoryGiB: integer("physical_memory_gib"),
    safeAvailableDiskGiB: integer("safe_available_disk_gib"),
    swappiness: values.swappiness || "unknown",
    configuredSwappiness: Math.min(100, integer("configured_swappiness", 10)),
    swapFile: values.swap_file || "/var/lib/dune-awakening/swapfile"
  };
}
