// Tier 3 second-factor store (console layered auth, RFC docs/rfc-console-auth.md
// §2.3 / §3.4). Persists the mandatory-TOTP + recovery-code state for the single
// built-in `local-owner` principal and mediates every read-modify-write through
// one serialized queue.
//
// Why the queue matters (this is the whole point of the phase): a single atomic
// *write* is not enough. Single-use recovery codes and TOTP replay-prevention are
// read-modify-write sequences -- read the current state, decide, persist the
// reduced state. The read and the write are async (non-blocking fs), so without
// serialization two concurrent logins could both read the same state before
// either writes, and both spend the same one-time recovery code (double spend) or
// both accept the same TOTP step counter (replay within one 30s step). Every
// mutating op runs inside runExclusive() so the read, the decision, and the
// persist are one uninterruptible critical section. Closes the carried-forward
// obligations from the recovery-code (#408) and TOTP (#412) module audits.
//
// On-disk shape (runtime/generated/console-second-factor.json, mode 0600):
//   { "version": 1,
//     "totp": { "secret": "<base64 raw bytes>", "lastUsedCounter": <int> },
//     "recoveryCodes": ["<64-hex digest>", ...] }
// The TOTP secret is stored as base64 of the RAW bytes and decoded to a Buffer
// at the verify boundary -- verifyTotpMatch is never handed base32 (#411 audit).

import { readFile, writeFile, rename, rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  generateRecoveryCodes,
  consumeRecoveryCode as consumeRecoveryCodePure,
} from "./recoveryCodes.js";
import { verifyTotpMatch } from "./totp.js";

export const SECOND_FACTOR_VERSION = 1;
const NO_COUNTER = -1; // lastUsedCounter sentinel: no TOTP code consumed yet

// Thrown when the store file exists but cannot be parsed/validated. Callers on
// the auth path MUST treat this as "cannot verify the second factor" -> deny,
// NEVER as "no second factor configured" -> allow. A corrupt file must not be a
// 2FA bypass; recovery is the documented host-filesystem reset (RFC §3.4).
export class SecondFactorCorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecondFactorCorruptError";
  }
}

export function createSecondFactorStore({ filePath }) {
  if (!filePath) throw new Error("createSecondFactorStore requires a filePath");

  // Serializing queue (Promise chain), not a boolean lock: each op appends its
  // read-modify-write to the tail and awaits its own link, so ops run one at a
  // time in arrival order and never interleave across an await. A thrown op does
  // not break the chain for the next caller.
  let tail = Promise.resolve();
  let tmpSeq = 0;
  function runExclusive(fn) {
    const run = tail.then(fn, fn); // run regardless of the prior op's outcome
    tail = run.then(() => {}, () => {}); // keep the chain alive on rejection
    return run;
  }

  async function writeAtomic(value) {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${tmpSeq++}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, filePath); // atomic replace on the same filesystem
  }

  // Read + validate the current state. Returns null when genuinely absent
  // (enrollment should trigger); throws SecondFactorCorruptError when present
  // but unusable (must fail closed).
  async function loadRaw() {
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw new SecondFactorCorruptError(`second-factor store is unreadable: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SecondFactorCorruptError(`second-factor store is not valid JSON: ${err.message}`);
    }
    if (!parsed || typeof parsed !== "object" || parsed.version !== SECOND_FACTOR_VERSION) {
      throw new SecondFactorCorruptError("second-factor store has an unexpected shape/version");
    }
    const totp = parsed.totp;
    if (!totp || typeof totp.secret !== "string" || !Number.isInteger(totp.lastUsedCounter)) {
      throw new SecondFactorCorruptError("second-factor store TOTP section is malformed");
    }
    if (!Array.isArray(parsed.recoveryCodes) || parsed.recoveryCodes.some((d) => typeof d !== "string")) {
      throw new SecondFactorCorruptError("second-factor store recoveryCodes section is malformed");
    }
    return parsed;
  }

  // ---- public API (all mutating ops serialized through runExclusive) ----

  // True iff a usable TOTP state exists. Throws on corruption (fail closed) --
  // callers must not treat a throw as "not configured".
  function isConfigured() {
    return runExclusive(async () => (await loadRaw()) !== null);
  }

  // Commit a freshly-enrolled second factor: persist the TOTP secret (raw bytes)
  // and a fresh recovery-code set. Returns the one-time plaintext recovery codes
  // for display. Overwrites any prior state (used by enrollment and by rotation).
  function commit(secretBytes, { count } = {}) {
    return runExclusive(async () => {
      if (!Buffer.isBuffer(secretBytes) && !(secretBytes instanceof Uint8Array)) {
        throw new TypeError("commit requires raw TOTP secret bytes");
      }
      const { codes, digests } = count ? generateRecoveryCodes(count) : generateRecoveryCodes();
      await writeAtomic({
        version: SECOND_FACTOR_VERSION,
        totp: {
          secret: Buffer.from(secretBytes).toString("base64"),
          lastUsedCounter: NO_COUNTER,
        },
        recoveryCodes: digests,
      });
      return { codes };
    });
  }

  // Verify a TOTP token with replay prevention: accept only if valid AND its
  // matched step counter is strictly greater than the last consumed one, then
  // persist the new counter. Returns { ok, reason }: reason is "not_configured",
  // "invalid" (no step matched), or "replay" (matched an already-used step).
  function verifyTotpToken(token, timeSeconds, options = {}) {
    return runExclusive(async () => {
      const state = await loadRaw();
      if (state === null) return { ok: false, reason: "not_configured" };
      const secretBytes = Buffer.from(state.totp.secret, "base64");
      const { valid, counter } = verifyTotpMatch(secretBytes, token, timeSeconds, options);
      if (!valid) return { ok: false, reason: "invalid" };
      if (counter <= state.totp.lastUsedCounter) return { ok: false, reason: "replay" };
      state.totp.lastUsedCounter = counter;
      await writeAtomic(state);
      return { ok: true };
    });
  }

  // Consume a recovery code (single-use). On success the digest is removed and
  // the reduced set persisted, all inside the critical section so the same code
  // cannot be spent twice by concurrent logins. Returns { ok, reason, remaining }.
  function consumeRecoveryCode(code) {
    return runExclusive(async () => {
      const state = await loadRaw();
      if (state === null) return { ok: false, reason: "not_configured" };
      const result = consumeRecoveryCodePure(code, state.recoveryCodes);
      if (!result.ok) return { ok: false, reason: result.reason };
      state.recoveryCodes = result.remaining;
      await writeAtomic(state);
      return { ok: true, remaining: result.remaining.length };
    });
  }

  // Regenerate the recovery-code set (invalidating all current codes). Returns
  // the one-time plaintext codes. TOTP secret/counter are untouched.
  function regenerateRecoveryCodes({ count } = {}) {
    return runExclusive(async () => {
      const state = await loadRaw();
      if (state === null) return { ok: false, reason: "not_configured" };
      const { codes, digests } = count ? generateRecoveryCodes(count) : generateRecoveryCodes();
      state.recoveryCodes = digests;
      await writeAtomic(state);
      return { ok: true, codes };
    });
  }

  // How many unused recovery codes remain (for the settings UI). Throws on corruption.
  function remainingRecoveryCodes() {
    return runExclusive(async () => {
      const state = await loadRaw();
      return state === null ? 0 : state.recoveryCodes.length;
    });
  }

  // Remove all second-factor state (the documented total-loss host reset, RFC
  // §3.4, and the pre-rotation clear). Idempotent.
  function clear() {
    return runExclusive(async () => {
      await rm(filePath, { force: true });
      return { ok: true };
    });
  }

  return {
    isConfigured,
    commit,
    verifyTotpToken,
    consumeRecoveryCode,
    regenerateRecoveryCodes,
    remainingRecoveryCodes,
    clear,
  };
}
