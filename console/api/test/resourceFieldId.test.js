import test from "node:test";
import assert from "node:assert/strict";
import { decodeFieldId } from "../src/services/resourceFieldId.js";

const MASK_21 = (1n << 21n) - 1n;

function encodeFieldId(x, y, z) {
  const enc = (v) => BigInt(v) & MASK_21;
  return enc(x) | (enc(y) << 21n) | (enc(z) << 42n);
}

test("decodes a real, documented field_id (dune-resource-scanner's Large spice example)", () => {
  // findings/2026-08-24-field-id-21bit/README.md: both DD Large-spice rows
  // decode to (-812800, -1016000, -4144) against dune-dev.
  assert.deepEqual(decodeFieldId(encodeFieldId(-812800, -1016000, -4144)), { x: -812800, y: -1016000, z: -4144 });
});

test("decodes zero", () => {
  assert.deepEqual(decodeFieldId(0n), { x: 0, y: 0, z: 0 });
});

test("decodes the maximum representable positive value on each axis (2^20 - 1)", () => {
  assert.deepEqual(decodeFieldId(encodeFieldId(1048575, 1048575, 1048575)), { x: 1048575, y: 1048575, z: 1048575 });
});

test("decodes the maximum representable negative value on each axis (-2^20)", () => {
  assert.deepEqual(decodeFieldId(encodeFieldId(-1048576, -1048576, -1048576)), { x: -1048576, y: -1048576, z: -1048576 });
});

test("a true position one unit beyond the 21-bit range aliases to the opposite boundary (known, unresolved limit)", () => {
  // 1,048,576 is not representable -- encoding it demonstrates the exact
  // silent-wrap behavior documented in resourceFieldId.js's header comment.
  // This is a property of the packing itself, not a bug in this decoder.
  assert.deepEqual(decodeFieldId(encodeFieldId(1048576, 0, 0)), { x: -1048576, y: 0, z: 0 });
});

test("accepts a numeric string, matching how a pg bigint column arrives via node-pg", () => {
  assert.deepEqual(decodeFieldId(String(encodeFieldId(5, -5, 0))), { x: 5, y: -5, z: 0 });
});

test("returns null for a negative field_id", () => {
  assert.equal(decodeFieldId(-1n), null);
});

test("returns null for a non-numeric input instead of throwing", () => {
  assert.equal(decodeFieldId("not-a-number"), null);
  assert.equal(decodeFieldId(undefined), null);
  assert.equal(decodeFieldId(null), null);
});
