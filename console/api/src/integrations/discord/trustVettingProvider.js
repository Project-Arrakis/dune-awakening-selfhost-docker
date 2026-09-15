import { playerCheaterTracking } from "../../duneDb.js";

// trustVettingProvider.js: read-only signals Mentat's bot uses to vet
// Chronicles of Kanly trust-role applications (meta#64) -- always an
// explicit staff-supplied target player, never the calling staff member's
// own character. Admin/owner tier only (see policy.js CHEATER_TRACKING_READ).

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
