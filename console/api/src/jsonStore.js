import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return Math.min(Math.max(fallback, min), max);
  return Math.min(Math.max(n, min), max);
}

export function writeJsonAtomic(file, value, mode = 0o600, { pretty = true } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const temporaryPath = `${file}.${process.pid}.tmp`;
  const json = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  writeFileSync(temporaryPath, `${json}\n`, { mode });
  renameSync(temporaryPath, file);
}
