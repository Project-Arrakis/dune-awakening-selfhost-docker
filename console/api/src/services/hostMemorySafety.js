const GIB = 1024 ** 3;

export function calculateAlwaysOnHostMemorySafety(totalBytes, configuredReserveGiB = "") {
  const total = Math.max(0, Number(totalBytes) || 0);
  const configuredReserve = Number(configuredReserveGiB);
  const reserveBytes = Number.isInteger(configuredReserve) && configuredReserve > 0
    ? configuredReserve * GIB
    : Math.max(4 * GIB, Math.floor(total * 0.15));
  const boundedReserve = total > 0 && reserveBytes >= total ? Math.floor(total / 4) : reserveBytes;
  const usableBytes = Math.max(0, total - boundedReserve);
  const recommendedParallelism = Math.max(1, Math.min(16, Math.floor(usableBytes / (16 * GIB))));

  return {
    physicalMemoryGiB: Math.round(total / GIB),
    reserveGiB: Math.ceil(boundedReserve / GIB),
    recommendedParallelism
  };
}
