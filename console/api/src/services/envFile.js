import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

export function updateEnvFileValue(repoRoot, key, value) {
  const envPath = resolve(repoRoot, ".env");
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  // A normally-newline-terminated file splits into a trailing "" entry (the
  // position right before EOF). Appending a new key pushed it AFTER that
  // entry instead of dropping it first, preserving a blank line in front of
  // every newly-added key -- and on a sequential per-key loop (e.g. the
  // guided Discord setup wizard writing one field per call), each call saw
  // the previous call's freshly blank-line-prefixed file and repeated the
  // mistake, producing a blank line before every field but the first
  // (live-testing finding). Only trailing blanks are stripped here -- a
  // deliberate blank line between two existing keys elsewhere in the file is
  // untouched.
  while (current.length && current[current.length - 1] === "") current.pop();
  const normalizedKey = String(key || "").trim();
  const line = `${normalizedKey}=${quoteEnv(String(value))}`;
  let found = false;
  const next = current.map((existing) => {
    if (envLineKey(existing) === normalizedKey) {
      found = true;
      return line;
    }
    return existing;
  });
  if (!found) next.push(line);
  writeFileSync(envPath, `${next.join("\n")}\n`, { mode: 0o644 });
  try { chmodSync(envPath, 0o644); } catch {}
}

export function quoteEnv(value) {
  if (/^[A-Za-z0-9_.:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function envLineKey(line) {
  const text = String(line || "").trimStart();
  if (!text || text.startsWith("#")) return "";
  const index = text.indexOf("=");
  return index > 0 ? text.slice(0, index).trim() : "";
}
