import { redact } from "../redact.js";

// A map restart must not begin its start/spawn half until both refill queues
// have finished using the brief write-safe window. Promise.allSettled is
// deliberate: if one queue fails, we still wait for the other rather than
// returning early while it is writing to PostgreSQL.
export async function flushBaseRefillQueues({ flushGenerators, flushWater }) {
  const [generatorResult, waterResult] = await Promise.allSettled([
    Promise.resolve().then(flushGenerators),
    Promise.resolve().then(flushWater)
  ]);

  const flushed = [];
  const failures = [];
  if (generatorResult.status === "fulfilled") {
    flushed.push(...(generatorResult.value?.flushed || []).map((entry) => ({ ...entry, refillType: "generator" })));
  } else {
    failures.push({ refillType: "generator", error: redact(String(generatorResult.reason?.message || generatorResult.reason)) });
  }
  if (waterResult.status === "fulfilled") {
    flushed.push(...(waterResult.value?.flushed || []).map((entry) => ({ ...entry, refillType: "water" })));
  } else {
    failures.push({ refillType: "water", error: redact(String(waterResult.reason?.message || waterResult.reason)) });
  }

  return { flushed, failures };
}
