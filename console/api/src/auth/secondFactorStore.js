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
// SERIALIZATION IS IN-PROCESS AND PER-FILE. The queue only serializes callers of
// ONE store instance. Two instances over the same file would each have their own
// queue and could interleave -- reintroducing the exact double-spend/replay race
// this module prevents -- so construction is guarded to one live store per
// resolved path (see the registry below). The design assumes a single console
// process (RFC: sessions are in-memory); a future multi-process deployment would
// need file-level locking, not just this queue.
//
// On-disk shape (runtime/generated/console-second-factor.json, mode 0600):
//   { "version": 1,
//     "totp": { "secret": "<base64 raw bytes>", "lastUsedCounter": <int> },
//     "recoveryCodes": ["<64-hex digest>", ...] }
// The TOTP secret is stored as base64 of the RAW bytes and decoded to a Buffer
// at the verify boundary -- verifyTotpMatch is never handed base32 (#411 audit).
// The secret is stored reversibly (base64 is encoding, not encryption) in a 0600
// file: acceptable for this phase because host-filesystem access already
// transcends console auth (RFC §3.4); encryption-at-rest is deferred to the
// separate KEK/DEK secrets system (Requirement 27), a deferral recorded in #407.
//
// Backup/restore integrity (RFC §2.3.1) is NOT handled here and is NOT yet
// handled anywhere: restoring an older file un-consumes recovery codes (and
// rolls lastUsedCounter back, which self-heals since TOTP validates near
// wall-clock time). As of the recovery-code-login phase (#426), recovery codes
// are consumable at login, so a restored old file resurrecting a spent code is
// directly exploitable -- the restore-detection + `auth.second-factor-reset-
// detected` audit event + "regenerate after restore" operator guidance remain
// UNWIRED and are tracked in #425 (re-scoped to the rotation phase). Do not
// read this comment as a claim that any reset-detection exists today.

import { resolve as resolvePath } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { writeJsonAtomicAsync } from "../jsonStore.js";
import {
  generateRecoveryCodes,
  consumeRecoveryCode as consumeRecoveryCodePure,
} from "./recoveryCodes.js";
import { verifyTotpMatch, TOTP_SECRET_BYTES } from "./totp.js";

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

// Thrown when the file's version is NEWER than this binary understands (e.g. a
// deploy rollback reading a version:2 file). Distinct from corruption because the
// remedy is the opposite: do NOT delete the file (it is good, live 2FA state) --
// upgrade the binary. Keeping this separate stops an operator following §3.4's
// "delete a corrupt file" guidance from destroying working state on a downgrade.
export class SecondFactorVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecondFactorVersionError";
  }
}

// One live store per resolved file path (see header). A second construction for
// the same path throws, turning the "singleton per file" contract into an
// enforced one rather than a comment a future wiring change could silently break.
const openPaths = new Set();

export function createSecondFactorStore({ filePath }) {
  if (!filePath) throw new Error("createSecondFactorStore requires a filePath");
  const key = resolvePath(filePath);
  if (openPaths.has(key)) {
    throw new Error(
      `a second-factor store is already open for ${key}; construct one store per file at boot and share it (concurrent stores would defeat serialization)`
    );
  }
  openPaths.add(key);
  let closed = false;

  // Serializing queue (Promise chain), not a boolean lock: each op appends its
  // read-modify-write to the tail and awaits its own link, so ops run one at a
  // time in arrival order and never interleave across an await. A thrown op does
  // not break the chain for the next caller.
  let tail = Promise.resolve();
  function runExclusive(fn) {
    if (closed) return Promise.reject(new Error("second-factor store is closed"));
    const run = tail.then(fn, fn); // run regardless of the prior op's outcome
    tail = run.then(() => {}, () => {}); // keep the chain alive on rejection
    return run;
  }

  function persist(state) {
    return writeJsonAtomicAsync(filePath, state, 0o600);
  }

  // Read + validate the current state. Returns null when genuinely absent
  // (enrollment should trigger); throws SecondFactorCorruptError when present but
  // unusable, or SecondFactorVersionError when present but newer than supported.
  async function loadRaw() {
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw new SecondFactorCorruptError(`second-factor store is unreadable (${err.code || "read error"})`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Deliberately does NOT echo the parser message (which can include file
      // content on some runtimes) -- a corrupt-file error must not leak the seed.
      throw new SecondFactorCorruptError("second-factor store is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || !Number.isInteger(parsed.version)) {
      throw new SecondFactorCorruptError("second-factor store has an unexpected shape");
    }
    if (parsed.version > SECOND_FACTOR_VERSION) {
      throw new SecondFactorVersionError(
        `second-factor store is version ${parsed.version}, newer than this console supports (${SECOND_FACTOR_VERSION}); upgrade the console -- do NOT delete this file`
      );
    }
    if (parsed.version !== SECOND_FACTOR_VERSION) {
      // Older, unknown version -- no migration path defined yet (v1 is the first).
      throw new SecondFactorCorruptError(`second-factor store has unsupported version ${parsed.version}`);
    }
    const totp = parsed.totp;
    if (!totp || typeof totp.secret !== "string" || !Number.isInteger(totp.lastUsedCounter)) {
      throw new SecondFactorCorruptError("second-factor store TOTP section is malformed");
    }
    // The secret must be valid base64 decoding to a plausible key length; a
    // corrupt-but-string secret would otherwise silently self-lock the operator
    // (every code invalid) instead of surfacing as corruption.
    const secretBytes = Buffer.from(totp.secret, "base64");
    if (secretBytes.length < 10 || secretBytes.length > 64 || secretBytes.toString("base64") !== totp.secret) {
      throw new SecondFactorCorruptError("second-factor store TOTP secret is not valid base64 of a key");
    }
    if (!Array.isArray(parsed.recoveryCodes) || parsed.recoveryCodes.some((d) => typeof d !== "string")) {
      throw new SecondFactorCorruptError("second-factor store recoveryCodes section is malformed");
    }
    return parsed;
  }

  function assertSecretBytes(secretBytes) {
    if (!Buffer.isBuffer(secretBytes) && !(secretBytes instanceof Uint8Array)) {
      throw new TypeError("second-factor store requires raw TOTP secret bytes (not base32)");
    }
    if (secretBytes.length !== TOTP_SECRET_BYTES) {
      throw new RangeError(`TOTP secret must be ${TOTP_SECRET_BYTES} bytes, got ${secretBytes.length}`);
    }
  }

  // initialCounter seeds totp.lastUsedCounter so the enrollment-confirm code's
  // own step is already "used" -- the RFC (§4) forbids reusing the confirm code
  // at the forced first login, and seeding the matched step enforces that.
  function makeState(secretBytes, digests, initialCounter = NO_COUNTER) {
    if (!Number.isInteger(initialCounter) || initialCounter < NO_COUNTER) {
      throw new RangeError(`initialCounter must be an integer >= ${NO_COUNTER}, got ${initialCounter}`);
    }
    return {
      version: SECOND_FACTOR_VERSION,
      totp: { secret: Buffer.from(secretBytes).toString("base64"), lastUsedCounter: initialCounter },
      recoveryCodes: digests,
    };
  }

  // ---- public API (all mutating ops serialized through runExclusive) ----

  // True iff a usable TOTP state exists. Throws on corruption/newer-version (fail
  // closed) -- callers must not treat a throw as "not configured".
  function isConfigured() {
    return runExclusive(async () => (await loadRaw()) !== null);
  }

  // Atomic first-time enrollment: create the second factor ONLY if none exists,
  // in one critical section (no check-then-act gap). Returns { ok:true, codes }
  // with the one-time plaintext recovery codes, or { ok:false, reason:
  // "already_configured" } without touching existing state. Use this for setup;
  // use commit() only for a deliberate rotation that overwrites.
  function enroll(secretBytes, { count, initialCounter } = {}) {
    return runExclusive(async () => {
      assertSecretBytes(secretBytes);
      if ((await loadRaw()) !== null) return { ok: false, reason: "already_configured" };
      const { codes, digests } = count ? generateRecoveryCodes(count) : generateRecoveryCodes();
      await persist(makeState(secretBytes, digests, initialCounter));
      return { ok: true, codes };
    });
  }

  // Overwrite the second factor with a fresh TOTP secret + recovery-code set
  // (deliberate rotation / re-key). Unconditional -- callers wanting
  // enroll-if-absent must use enroll(). Returns { ok:true, codes }.
  function commit(secretBytes, { count, initialCounter } = {}) {
    return runExclusive(async () => {
      assertSecretBytes(secretBytes);
      const { codes, digests } = count ? generateRecoveryCodes(count) : generateRecoveryCodes();
      await persist(makeState(secretBytes, digests, initialCounter));
      return { ok: true, codes };
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
      await persist(state);
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
      await persist(state);
      return { ok: true, remaining: result.remaining.length };
    });
  }

  // Regenerate the recovery-code set (invalidating all current codes). Returns
  // { ok:true, codes } with the one-time plaintext codes, or
  // { ok:false, reason:"not_configured" }. TOTP secret/counter are untouched.
  function regenerateRecoveryCodes({ count } = {}) {
    return runExclusive(async () => {
      const state = await loadRaw();
      if (state === null) return { ok: false, reason: "not_configured" };
      const { codes, digests } = count ? generateRecoveryCodes(count) : generateRecoveryCodes();
      state.recoveryCodes = digests;
      await persist(state);
      return { ok: true, codes };
    });
  }

  // How many unused recovery codes remain (for the settings UI). Throws on
  // corruption/newer-version.
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

  // Release this store's hold on its path (for teardown / tests). After close(),
  // further ops reject and the path can be re-opened.
  function close() {
    closed = true;
    openPaths.delete(key);
  }

  return {
    isConfigured,
    enroll,
    commit,
    verifyTotpToken,
    consumeRecoveryCode,
    regenerateRecoveryCodes,
    remainingRecoveryCodes,
    clear,
    close,
  };
}
