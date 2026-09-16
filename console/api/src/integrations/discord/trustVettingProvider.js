import { playerCheaterTracking } from "../../duneDb.js";

// trustVettingProvider.js: read-only signals Mentat's bot uses to vet
// Chronicles of Kanly trust-role applications (meta#64) -- always an
// explicit staff-supplied target player, never the calling staff member's
// own character. Admin/owner tier only (see policy.js CHEATER_TRACKING_READ).
//
// `rows: []`/`count: 0` alone does NOT mean "clean record" -- it's also
// what an unsupported instance or an account with no FLS id returns.
// Callers MUST check `capabilities.cheaterTracking` and `flsId` first:
//   - capabilities.cheaterTracking === false -> feature unsupported on this
//     instance (dune.cheater_tracking table missing); no signal either way.
//   - capabilities.cheaterTracking === true, flsId === null -> player
//     resolved but has no stable FLS id; no signal either way.
//   - capabilities.cheaterTracking === true, flsId set, rows: [] -> a real,
//     verified clean record.
// Naively branching on `count === 0` alone conflates all three into the
// same "looks clean" result -- a real false-negative risk for a trust/
// safety gate. See docs/console/API-REFERENCE.md's entry for this route.

export async function cheaterTrackingProvider(db, { actorId } = {}) {
  const result = await playerCheaterTracking(db, actorId);
  return {
    ok: true,
    capabilities: result.capabilities || {},
    player: result.player,
    flsId: result.flsId,
    rows: result.rows || [],
    count: (result.rows || []).length
  };
}
