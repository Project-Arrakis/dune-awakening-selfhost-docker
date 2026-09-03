import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

// Every writer of .env (the wizard's per-field save, the manual Discord OAuth
// form, port changes, DB password rotation, always-on tuning, the public
// directory toggle, and -- once shipped -- Settings' Discord OAuth
// disable/enable/forget) shares this one module. Without serialization, two
// concurrent requests each do read -> mutate -> write independently; whichever
// write lands second silently discards the first (a real, twice-found gap --
// see #678). A single in-process queue is sufficient: every writer runs in
// this same Node process, there is no multi-process/multi-host contention to
// solve, only interleaved requests within one event loop.
let writeQueue = Promise.resolve();

function enqueue(fn) {
  const result = writeQueue.then(fn, fn);
  // Swallow so one failed write doesn't wedge the queue for every writer
  // after it -- each caller still sees its own rejection via the returned
  // promise, this is only about keeping the chain alive.
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

// Writes exactly the given key/value pairs, as ONE read-modify-write
// transaction under the shared queue. A caller writing N related keys (the
// wizard's per-field loop, the manual form's changed-fields loop) MUST use
// this instead of N separate updateEnvFileValue calls -- looping single-key
// calls still races against a different request's write landing between
// iterations, even with each individual call serialized.
export function updateEnvFileValues(repoRoot, entries) {
  const normalizedEntries = Object.entries(entries).map(([key, value]) => [String(key || "").trim(), String(value)]);
  return enqueue(() => {
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
    const remaining = new Map(normalizedEntries);
    const next = current.map((existing) => {
      const key = envLineKey(existing);
      if (remaining.has(key)) {
        const value = remaining.get(key);
        remaining.delete(key);
        return `${key}=${quoteEnv(value)}`;
      }
      return existing;
    });
    for (const [key, value] of remaining) next.push(`${key}=${quoteEnv(value)}`);
    writeFileSync(envPath, `${next.join("\n")}\n`, { mode: 0o644 });
    try { chmodSync(envPath, 0o644); } catch {}
  });
}

export function updateEnvFileValue(repoRoot, key, value) {
  return updateEnvFileValues(repoRoot, { [key]: value });
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
