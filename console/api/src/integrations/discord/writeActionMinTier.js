// Per-action minimum tier for the Discord write bridge (docs/rw-architecture.md
// section 3.3a). Neither console policy.js (whose players:mutate action is too
// coarse to distinguish kick from give-item) nor Discord's own CAPABILITY_BY_TIER
// (which computes admin and owner as the identical set) can enforce the tier
// ladder Section 1 requires -- this table is the explicit, independent check.
const TIER_RANK = { moderator: 0, admin: 1, owner: 2 };

export const WRITE_ACTION_MIN_TIER = {
  "player.kick": "admin",
  "player.ban": "admin",
  "player.unban": "admin",
  "player.warn": "moderator",
  "player.give-item": "owner",
  "player.clear-backpack": "owner",
  "player.fill-water": "admin",
  "base.refill-generators": "admin",
  "base.refill-water": "admin",
  "server.restart": "owner",
  "server.stop": "owner",
  "server.start": "admin",
  "server.restart-service": "admin",
  "map.spawn": "admin",
  "map.despawn": "admin",
  "map.respawn": "admin",
  "map.teleport": "admin",
  "carepackage.grant": "admin",
  "carepackage.grant-all": "owner",
  "carepackage.enable": "admin",
  "carepackage.disable": "admin",
  "carepackage.scan": "admin",
  "carepackage.history-clear": "owner",
  "guild.add": "admin",
  "guild.remove": "admin"
};

// broadcast.* is intentionally absent -- gated by the existing, separate
// requireDiscordCapability() path instead (docs/rw-architecture.md section 1).

export function meetsMinTier(actorTier, action) {
  if (!Object.hasOwn(WRITE_ACTION_MIN_TIER, action)) {
    // Fail closed, not open: a WRITE_ACTION_ROUTES entry with no corresponding
    // minimum-tier entry must never silently default to the lowest tier.
    throw new Error(`No minimum tier defined for action "${action}"`);
  }
  return TIER_RANK[actorTier] >= TIER_RANK[WRITE_ACTION_MIN_TIER[action]];
}
