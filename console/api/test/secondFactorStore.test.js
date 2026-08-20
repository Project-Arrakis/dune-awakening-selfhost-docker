import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSecondFactorStore, SecondFactorCorruptError, SECOND_FACTOR_VERSION } from "../src/auth/secondFactorStore.js";
import { totpCode, counterForTime, TOTP_PERIOD_SECONDS } from "../src/auth/totp.js";

const SECRET = Buffer.from("12345678901234567890", "utf8"); // 20 bytes
const T = 1700000000;

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "sfs-"));
  const filePath = join(dir, "console-second-factor.json");
  return { store: createSecondFactorStore({ filePath }), filePath, dir };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ---- basic lifecycle ----

test("a fresh install is not configured and no file exists", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    assert.equal(await store.isConfigured(), false);
    assert.equal(existsSync(filePath), false);
    assert.equal(await store.remainingRecoveryCodes(), 0);
  } finally { cleanup(dir); }
});

test("commit persists TOTP + recovery codes at mode 0600 and returns one-time codes", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    const { codes } = await store.commit(SECRET);
    assert.equal(codes.length, 10);
    assert.equal(await store.isConfigured(), true);
    assert.equal(await store.remainingRecoveryCodes(), 10);

    // file mode is 0600
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    // secret stored as base64 of RAW bytes (not base32), round-trips
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(onDisk.version, SECOND_FACTOR_VERSION);
    assert.deepEqual(Buffer.from(onDisk.totp.secret, "base64"), SECRET);
    assert.equal(onDisk.totp.lastUsedCounter, -1);
    // plaintext codes are NOT on disk (only digests)
    for (const c of codes) assert.equal(readFileSync(filePath, "utf8").includes(c.replace(/-/g, "")), false);
  } finally { cleanup(dir); }
});

// ---- TOTP verify + replay prevention ----

test("verifyTotpToken accepts a valid code once, then rejects the SAME code as replay", async () => {
  const { store, dir } = freshStore();
  try {
    await store.commit(SECRET);
    const token = totpCode(SECRET, T);
    assert.deepEqual(await store.verifyTotpToken(token, T), { ok: true });
    // same code, same step -> replay (matched counter <= lastUsedCounter)
    assert.deepEqual(await store.verifyTotpToken(token, T), { ok: false, reason: "replay" });
    // a code from a later step is accepted (counter advances)
    const later = totpCode(SECRET, T + TOTP_PERIOD_SECONDS);
    assert.deepEqual(await store.verifyTotpToken(later, T + TOTP_PERIOD_SECONDS), { ok: true });
    // and re-presenting the earlier step's code is now also replay (counter went backward)
    assert.deepEqual(await store.verifyTotpToken(token, T), { ok: false, reason: "replay" });
  } finally { cleanup(dir); }
});

test("verifyTotpToken rejects an invalid code and reports not_configured before commit", async () => {
  const { store, dir } = freshStore();
  try {
    assert.deepEqual(await store.verifyTotpToken("000000", T), { ok: false, reason: "not_configured" });
    await store.commit(SECRET);
    assert.deepEqual(await store.verifyTotpToken("000000", T), { ok: false, reason: "invalid" });
  } finally { cleanup(dir); }
});

test("CONCURRENCY: N simultaneous verifications of the same code -> exactly one succeeds (no replay)", async () => {
  const { store, dir } = freshStore();
  try {
    await store.commit(SECRET);
    const token = totpCode(SECRET, T);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.verifyTotpToken(token, T)));
    const ok = results.filter((r) => r.ok).length;
    const replay = results.filter((r) => r.reason === "replay").length;
    assert.equal(ok, 1, "exactly one concurrent verification of one code may succeed");
    assert.equal(replay, 7, "the rest are rejected as replay");
  } finally { cleanup(dir); }
});

// ---- recovery-code single use ----

test("consumeRecoveryCode accepts a code once and rejects its reuse", async () => {
  const { store, dir } = freshStore();
  try {
    const { codes } = await store.commit(SECRET);
    const r1 = await store.consumeRecoveryCode(codes[3]);
    assert.equal(r1.ok, true);
    assert.equal(r1.remaining, 9);
    assert.equal(await store.remainingRecoveryCodes(), 9);
    const r2 = await store.consumeRecoveryCode(codes[3]);
    assert.deepEqual(r2, { ok: false, reason: "unknown" });
  } finally { cleanup(dir); }
});

test("consumeRecoveryCode distinguishes malformed / unknown / not_configured", async () => {
  const { store, dir } = freshStore();
  try {
    assert.deepEqual(await store.consumeRecoveryCode("whatever"), { ok: false, reason: "not_configured" });
    const { codes } = await store.commit(SECRET);
    assert.deepEqual(await store.consumeRecoveryCode("not-a-code"), { ok: false, reason: "malformed" });
    // a well-formed but not-issued code
    const { store: other, dir: d2 } = freshStore();
    const foreign = (await other.commit(SECRET)).codes[0];
    cleanup(d2);
    assert.deepEqual(await store.consumeRecoveryCode(foreign), { ok: false, reason: "unknown" });
    assert.equal(codes.length, 10);
  } finally { cleanup(dir); }
});

test("CONCURRENCY: N simultaneous consumptions of the same recovery code -> exactly one succeeds (no double-spend)", async () => {
  const { store, dir } = freshStore();
  try {
    const { codes } = await store.commit(SECRET);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.consumeRecoveryCode(codes[0])));
    const ok = results.filter((r) => r.ok).length;
    assert.equal(ok, 1, "a single-use code cannot be spent twice under concurrency");
    assert.equal(await store.remainingRecoveryCodes(), 9, "exactly one code consumed");
  } finally { cleanup(dir); }
});

test("CONCURRENCY: consuming all distinct codes at once removes exactly all of them", async () => {
  const { store, dir } = freshStore();
  try {
    const { codes } = await store.commit(SECRET);
    const results = await Promise.all(codes.map((c) => store.consumeRecoveryCode(c)));
    assert.equal(results.filter((r) => r.ok).length, 10);
    assert.equal(await store.remainingRecoveryCodes(), 0);
  } finally { cleanup(dir); }
});

// ---- regenerate ----

test("regenerateRecoveryCodes issues a new set and invalidates the old", async () => {
  const { store, dir } = freshStore();
  try {
    const { codes: oldCodes } = await store.commit(SECRET);
    const { codes: newCodes, ok } = await store.regenerateRecoveryCodes();
    assert.equal(ok, true);
    assert.equal(newCodes.length, 10);
    // an old code no longer works
    assert.deepEqual(await store.consumeRecoveryCode(oldCodes[0]), { ok: false, reason: "unknown" });
    // a new one does
    assert.equal((await store.consumeRecoveryCode(newCodes[0])).ok, true);
  } finally { cleanup(dir); }
});

// ---- corruption fails closed ----

test("a corrupt store file throws SecondFactorCorruptError -- never silently 'not configured'", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    await store.commit(SECRET);
    writeFileSync(filePath, "{ this is not json", { mode: 0o600 });
    await assert.rejects(() => store.isConfigured(), SecondFactorCorruptError);
    await assert.rejects(() => store.verifyTotpToken(totpCode(SECRET, T), T), SecondFactorCorruptError);
    await assert.rejects(() => store.consumeRecoveryCode("x"), SecondFactorCorruptError);
    // critically: a corrupt file must NOT read as an unconfigured (bypassable) install
  } finally { cleanup(dir); }
});

test("a wrong-shape / wrong-version store file also fails closed", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    writeFileSync(filePath, JSON.stringify({ version: 999, totp: {}, recoveryCodes: [] }), { mode: 0o600 });
    await assert.rejects(() => store.isConfigured(), SecondFactorCorruptError);
  } finally { cleanup(dir); }
});

// ---- clear (total-loss host reset / pre-rotation) ----

test("clear removes all state and returns the install to unconfigured", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    await store.commit(SECRET);
    assert.equal(await store.isConfigured(), true);
    await store.clear();
    assert.equal(existsSync(filePath), false);
    assert.equal(await store.isConfigured(), false);
    await store.clear(); // idempotent
  } finally { cleanup(dir); }
});

// ---- queue keeps ordering / survives a thrown op ----

test("the serialized queue survives a throwing op and keeps serving later ops", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    await store.commit(SECRET);
    writeFileSync(filePath, "corrupt", { mode: 0o600 });
    await assert.rejects(() => store.isConfigured(), SecondFactorCorruptError);
    // repair and confirm the queue still works
    await store.clear();
    await store.commit(SECRET);
    assert.equal(await store.isConfigured(), true);
  } finally { cleanup(dir); }
});
