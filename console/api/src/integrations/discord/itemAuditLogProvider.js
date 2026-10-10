import { playerItemAuditLog } from "../../duneDb.js";

// itemAuditLogProvider.js: read-only item-movement history for a target
// player's inventories (meta#64 "Chronicles of Kanly", mentat#368 --
// proactive stolen-goods cross-reference against new Exchange listings) --
// always an explicit staff/system-supplied target player, never the
// calling actor's own character. Moderator tier and up (see policy.js
// ITEM_AUDIT_LOG_READ).
//
// Like trustVettingProvider.js's cheater-tracking response, `rows: []`
// alone does NOT distinguish "unsupported on this instance" from "no
// item-movement activity in the requested window" -- callers should check
// `capabilities.itemAuditLog` first.

export async function itemAuditLogProvider(db, { actorId, windowHours, limit } = {}) {
  const result = await playerItemAuditLog(db, actorId, { windowHours, limit });
  return {
    ok: true,
    capabilities: result.capabilities || {},
    player: result.player,
    windowHours: result.windowHours,
    rows: result.rows || [],
    count: (result.rows || []).length
  };
}
