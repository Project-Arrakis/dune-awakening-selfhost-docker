import test from "node:test";
import assert from "node:assert/strict";

import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
  base32Encode,
  base32Decode,
  generateTotpSecret,
  hotp,
  counterForTime,
  totpCode,
  verifyTotp,
  provisioningUri,
} from "../src/auth/totp.js";

// RFC 6238 Appendix B reference secret (ASCII "12345678901234567890", 20 bytes).
const RFC_SECRET = Buffer.from("12345678901234567890", "utf8");

// ---- base32 (RFC 4648 test vectors) ----

test("base32Encode matches RFC 4648 vectors (no padding)", () => {
  const cases = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];
  for (const [plain, encoded] of cases) {
    assert.equal(base32Encode(Buffer.from(plain, "utf8")), encoded, `encode ${JSON.stringify(plain)}`);
  }
});

test("base32Decode reverses encode, tolerating case / spaces / padding", () => {
  assert.equal(base32Decode("MZXW6YTBOI").toString("utf8"), "foobar");
  assert.equal(base32Decode("mzxw6ytboi").toString("utf8"), "foobar");
  assert.equal(base32Decode("MZXW 6YTB OI==").toString("utf8"), "foobar");
  // Non-empty round-trips (empty input is intentionally rejected as null by
  // base32Decode — an empty secret is never usable; see the reject test below).
  for (const s of ["hello world", "\x00\x01\x02\x03\x04", "z"]) {
    const b = Buffer.from(s, "utf8");
    assert.deepEqual(base32Decode(base32Encode(b)), b, `round-trip ${JSON.stringify(s)}`);
  }
});

test("base32Decode rejects non-alphabet input", () => {
  assert.equal(base32Decode("!!!!"), null);
  assert.equal(base32Decode("0189"), null); // 0,1,8,9 are not in the base32 alphabet
  assert.equal(base32Decode(""), null);
});

// ---- HOTP / TOTP against RFC 6238 Appendix B (SHA1 column) ----

test("hotp/totpCode reproduce the RFC 6238 SHA1 8-digit test vectors", () => {
  // [unix time T, expected 8-digit SHA1 TOTP]
  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, expected] of vectors) {
    assert.equal(totpCode(RFC_SECRET, t, { digits: 8 }), expected, `T=${t}`);
    // and directly via hotp on the derived counter
    assert.equal(hotp(RFC_SECRET, counterForTime(t), 8), expected, `hotp T=${t}`);
  }
});

test("6-digit code is the low 6 digits of the 8-digit RFC vector", () => {
  assert.equal(totpCode(RFC_SECRET, 59, { digits: 6 }), "287082");
  assert.equal(totpCode(RFC_SECRET, 1111111109), "081804"); // default digits = 6
  assert.equal(totpCode(RFC_SECRET, 1234567890), "005924");
});

test("counterForTime floors to the period", () => {
  assert.equal(counterForTime(0), 0);
  assert.equal(counterForTime(29), 0);
  assert.equal(counterForTime(30), 1);
  assert.equal(counterForTime(59), 1);
  assert.equal(counterForTime(60), 2);
});

// ---- verifyTotp windowing ----

test("verifyTotp accepts the current code and rejects a wrong one", () => {
  const t = 1234567890;
  assert.equal(verifyTotp(RFC_SECRET, "005924", t), true);
  assert.equal(verifyTotp(RFC_SECRET, "000000", t), false);
});

test("verifyTotp accepts ±1 step (clock drift) but not ±2", () => {
  const t = 1234567890;
  const prev = totpCode(RFC_SECRET, t - TOTP_PERIOD_SECONDS);
  const next = totpCode(RFC_SECRET, t + TOTP_PERIOD_SECONDS);
  const twoBack = totpCode(RFC_SECRET, t - 2 * TOTP_PERIOD_SECONDS);
  assert.equal(verifyTotp(RFC_SECRET, prev, t), true, "previous step within ±1");
  assert.equal(verifyTotp(RFC_SECRET, next, t), true, "next step within ±1");
  assert.equal(verifyTotp(RFC_SECRET, twoBack, t), false, "two steps away is outside the window");
  // window: 0 rejects even the adjacent step
  assert.equal(verifyTotp(RFC_SECRET, prev, t, { window: 0 }), false);
});

test("verifyTotp rejects malformed tokens (wrong length, non-digit, non-string)", () => {
  const t = 1234567890;
  assert.equal(verifyTotp(RFC_SECRET, "5924", t), false, "too short");
  assert.equal(verifyTotp(RFC_SECRET, "00592412", t), false, "too long");
  assert.equal(verifyTotp(RFC_SECRET, "abcdef", t), false, "non-digit");
  assert.equal(verifyTotp(RFC_SECRET, 5924, t), false, "non-string");
  assert.equal(verifyTotp(RFC_SECRET, null, t), false);
});

test("verifyTotp tolerates surrounding whitespace", () => {
  assert.equal(verifyTotp(RFC_SECRET, "  005924 ", 1234567890), true);
});

// ---- secret generation ----

test("generateTotpSecret returns a 160-bit secret and its base32", () => {
  const seq = (len) => Buffer.alloc(len, 7);
  const { secretBytes, base32 } = generateTotpSecret(seq);
  assert.equal(secretBytes.length, TOTP_SECRET_BYTES);
  assert.equal(TOTP_SECRET_BYTES, 20);
  assert.equal(base32, base32Encode(secretBytes));
  assert.deepEqual(base32Decode(base32), secretBytes, "base32 round-trips the secret");
});

test("generateTotpSecret rejects a bad random source", () => {
  assert.throws(() => generateTotpSecret(() => Buffer.alloc(8)), /expected 20/);
  assert.throws(() => generateTotpSecret(() => "nope"), /Buffer\/Uint8Array/);
});

test("a freshly generated secret verifies its own current code", () => {
  const { secretBytes } = generateTotpSecret((len) => Buffer.alloc(len, 0x2a));
  const t = 1700000000;
  assert.equal(verifyTotp(secretBytes, totpCode(secretBytes, t), t), true);
});

// ---- provisioning URI ----

test("provisioningUri builds a valid otpauth URL with issuer/label/params", () => {
  // Derive the base32 from an obvious fixed byte pattern rather than hardcoding
  // a high-entropy literal (which secret scanners flag as a generic key).
  const secretBase32 = base32Encode(Buffer.alloc(TOTP_SECRET_BYTES, 0x41));
  const uri = provisioningUri({
    secretBase32,
    accountName: "operator@example.com",
    issuer: "Dune Console",
  });
  const u = new URL(uri);
  assert.equal(u.protocol, "otpauth:");
  assert.equal(u.host, "totp");
  assert.equal(decodeURIComponent(u.pathname), "/Dune Console:operator@example.com");
  assert.equal(u.searchParams.get("secret"), secretBase32);
  assert.equal(u.searchParams.get("issuer"), "Dune Console");
  assert.equal(u.searchParams.get("algorithm"), "SHA1");
  assert.equal(u.searchParams.get("digits"), String(TOTP_DIGITS));
  assert.equal(u.searchParams.get("period"), String(TOTP_PERIOD_SECONDS));
});

test("provisioningUri requires secret, account, and issuer", () => {
  assert.throws(() => provisioningUri({ accountName: "a", issuer: "b" }), /requires/);
  assert.throws(() => provisioningUri({ secretBase32: "X", issuer: "b" }), /requires/);
  assert.throws(() => provisioningUri({ secretBase32: "X", accountName: "a" }), /requires/);
});
