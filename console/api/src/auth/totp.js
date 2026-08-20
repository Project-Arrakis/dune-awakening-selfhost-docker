// Tier 3 TOTP (console layered auth, RFC docs/rfc-console-auth.md §2.3). Mandatory
// second factor on the password tier. Interoperable RFC 6238 parameters so every
// mainstream authenticator app works: HMAC-SHA1, 6 digits, 30-second period,
// ±1-step verification window, 160-bit server-generated secret.
//
// Pure module: secret generation, base32 (RFC 4648) for the provisioning URI,
// RFC 4226 HOTP, RFC 6238 TOTP, and a windowed constant-time verify. No I/O, no
// persistence (later phase), no clock of its own — the caller passes the time so
// tests are deterministic and the module never reads a wall clock implicitly.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_ALGORITHM = "SHA1"; // interoperable default; authenticator apps assume it
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_SECRET_BYTES = 20; // 160-bit
export const TOTP_DEFAULT_WINDOW = 1; // ±1 step tolerates ordinary clock drift

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648, no padding on output

// ---- base32 (RFC 4648) ----

export function base32Encode(bytes) {
  const buf = Buffer.from(bytes);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(input) {
  const cleaned = String(input).replace(/[\s=-]/g, "").toUpperCase();
  if (cleaned.length === 0 || /[^A-Z2-7]/.test(cleaned)) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of cleaned) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---- secret ----

// Generate a fresh 160-bit secret. Returns the raw bytes and the base32 form
// (what an authenticator app / the provisioning URI needs).
export function generateTotpSecret(random = randomBytes) {
  const secret = random(TOTP_SECRET_BYTES);
  if (!Buffer.isBuffer(secret) && !(secret instanceof Uint8Array)) {
    throw new TypeError("random source must return a Buffer/Uint8Array");
  }
  if (secret.length !== TOTP_SECRET_BYTES) {
    throw new RangeError(`random source returned ${secret.length} bytes, expected ${TOTP_SECRET_BYTES}`);
  }
  const bytes = Buffer.from(secret);
  return { secretBytes: bytes, base32: base32Encode(bytes) };
}

// ---- HOTP / TOTP ----

// RFC 4226 HOTP: HMAC-SHA1(secret, counter) → dynamic truncation → zero-padded
// `digits`-length decimal string.
export function hotp(secretBytes, counter, digits = TOTP_DIGITS) {
  const counterBuf = Buffer.alloc(8);
  // 64-bit big-endian counter; JS bitops are 32-bit so split hi/lo.
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", Buffer.from(secretBytes)).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function counterForTime(timeSeconds, period = TOTP_PERIOD_SECONDS) {
  return Math.floor(timeSeconds / period);
}

// Current TOTP code for a given time (seconds since epoch). The caller supplies
// the time — the module never reads the clock itself.
export function totpCode(secretBytes, timeSeconds, { period = TOTP_PERIOD_SECONDS, digits = TOTP_DIGITS } = {}) {
  return hotp(secretBytes, counterForTime(timeSeconds, period), digits);
}

// Verify a submitted token against the ±window steps around `timeSeconds`.
// Compares with timingSafeEqual and checks every step in the window without
// short-circuiting, so a valid token is accepted regardless of which step it
// landed on and the check does not leak the matching offset via timing.
export function verifyTotp(secretBytes, token, timeSeconds, {
  period = TOTP_PERIOD_SECONDS,
  digits = TOTP_DIGITS,
  window = TOTP_DEFAULT_WINDOW,
} = {}) {
  if (typeof token !== "string") return false;
  const candidate = token.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return false;
  const candidateBuf = Buffer.from(candidate, "utf8");
  const center = counterForTime(timeSeconds, period);
  let matched = false;
  for (let offset = -window; offset <= window; offset++) {
    const expected = hotp(secretBytes, center + offset, digits);
    const expectedBuf = Buffer.from(expected, "utf8");
    if (expectedBuf.length === candidateBuf.length && timingSafeEqual(expectedBuf, candidateBuf)) {
      matched = true; // no break: keep timing independent of the matching step
    }
  }
  return matched;
}

// ---- provisioning URI ----

// otpauth:// URI an authenticator app imports (rendered as a QR by the caller).
// label = "Issuer:account"; issuer is also a query param (apps expect both).
export function provisioningUri({
  secretBase32,
  accountName,
  issuer,
  algorithm = TOTP_ALGORITHM,
  digits = TOTP_DIGITS,
  period = TOTP_PERIOD_SECONDS,
}) {
  if (!secretBase32 || !accountName || !issuer) {
    throw new Error("provisioningUri requires secretBase32, accountName, and issuer");
  }
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm,
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
