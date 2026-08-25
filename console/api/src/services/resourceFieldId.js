// Decodes dune.resourcefield_state.field_id into a world-space (x, y, z)
// position. Verified live against dune-dev (DeepDesert PID 390735, Coriolis
// seed 2) on 2026-08-24 by Project-Arrakis/dune-resource-scanner: spice
// 53/57 exact XY matches against memory-scan ground truth, flour sand
// 45/59 -- see that repo's CONTINUATION.md section 2.
//
// field_id packs three 21-bit signed integers (x, y, z), raw world units,
// no scaling. It exceeds Number.MAX_SAFE_INTEGER, so it must be decoded as
// a BigInt -- a JS Number silently loses the low bits.
//
// Known, unresolved limit (see dune-resource-scanner's
// findings/2026-08-24-field-id-21bit/README.md): three 21-bit signed fields
// can only represent -1,048,576..1,048,575 per axis, but real map extents
// exceed this (Deep Desert reaches roughly +/-1.27M; ~12.9% of its real
// markers fall outside the range). A field whose true position is out of
// range does not fail to decode -- it silently wraps into a plausible-
// looking in-range value, and there is no escape bit or other signal in
// field_id itself to detect this. That R&D repo's own investigation found
// no correlation between "decoded value sits near the boundary" and "this
// decode is actually wrong" for the cases it could test, so this function
// deliberately does NOT attempt to flag likely-wrapped values -- doing so
// would imply a detection capability that doesn't exist and hasn't been
// verified. Positions from this decode for the outer ~13% of a map's
// extent should be treated as unverified by design, not flagged
// per-value.

const BIT_WIDTH = 21n;
const MASK_21 = (1n << BIT_WIDTH) - 1n; // 0x1FFFFF
const SIGN_BIT = 1n << (BIT_WIDTH - 1n); // 0x100000
const WRAP = 1n << BIT_WIDTH; // 0x200000

function decodeSigned21(raw) {
  const value = raw & MASK_21;
  return value >= SIGN_BIT ? value - WRAP : value;
}

/**
 * @param {bigint|string|number} fieldId
 * @returns {{ x: number, y: number, z: number } | null} null for a
 *   non-numeric or negative input (field_id is always a non-negative
 *   64-bit value in practice; bit 63 is confirmed always 0).
 */
export function decodeFieldId(fieldId) {
  let id;
  try {
    id = BigInt(fieldId);
  } catch {
    return null;
  }
  if (id < 0n) return null;

  return {
    x: Number(decodeSigned21(id & MASK_21)),
    y: Number(decodeSigned21((id >> BIT_WIDTH) & MASK_21)),
    z: Number(decodeSigned21((id >> (BIT_WIDTH * 2n)) & MASK_21))
  };
}
