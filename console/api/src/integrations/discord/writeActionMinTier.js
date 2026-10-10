// Per-action minimum tier for the Discord write bridge. Neither console
// policy.js (whose players:mutate action is too coarse to distinguish kick
// from give-item) nor Discord's own CAPABILITY_BY_TIER (which computes admin
// and owner as the identical set) can enforce the DISCORD_ROLE_TIERS ladder
// this table needs -- this table is the explicit, independent check.
import { DISCORD_ROLE_TIERS } from "./policy.js";

// TIER_RANK is deliberately derived directly from DISCORD_ROLE_TIERS's own
// order, not a separately hand-maintained encoding of the tier hierarchy --
// a hand-duplicated table drifting from its source of truth is a real,
// recurring bug class in this codebase. Only "moderator" and above are
// ranked here since a write-bridge principal can never resolve at
// "public"/"observer" tier in the first place (VALID_TIERS in
// writeBridgeCredential.js enforces that boundary).
const WRITE_BRIDGE_TIER_ORDER = DISCORD_ROLE_TIERS.slice(DISCORD_ROLE_TIERS.indexOf("moderator"));
const TIER_RANK = Object.fromEntries(WRITE_BRIDGE_TIER_ORDER.map((tier, index) => [tier, index]));

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
  "guild.remove": "admin",
  "backup.create": "owner",
  "updates.apply-game": "owner",
  "updates.fix-steamcmd": "owner"
};

// broadcast.* is intentionally absent -- gated by the existing, separate
// requireDiscordCapability() path instead.

export function meetsMinTier(actorTier, action) {
  if (!Object.hasOwn(WRITE_ACTION_MIN_TIER, action)) {
    // Fail closed, not open: a WRITE_ACTION_ROUTES entry with no corresponding
    // minimum-tier entry must never silently default to the lowest tier.
    throw new Error(`No minimum tier defined for action "${action}"`);
  }
  return TIER_RANK[actorTier] >= TIER_RANK[WRITE_ACTION_MIN_TIER[action]];
}
