// Hard cap and ownership gate for the `player` console tier.
//
// The player tier is "own items and own guild only". The policy engine says
// which ACTIONS a tier may use; it cannot say whose DATA. This module is the
// second gate, applied after the policy check and independent of whatever an
// operator saved in iam-policies.json (a saved `player` document that grants
// more still cannot read more than this allows).
//
// It is a deny-by-default allow-list over the SAME path shapes the route
// handlers use (`[^/]+$`, matched on the raw pathname). Anything under
// /api/players/ or /api/guilds/ that is not listed here is refused, so a route
// added later is closed to players until it is listed deliberately.

// Actions a player-tier session may ever hold, whatever its saved policy says.
export const PLAYER_TIER_ACTIONS = Object.freeze(new Set(["players:read", "guilds:read"]));

// Own-character sub-resources a player may read: their profile and their items.
// Deliberately excluded: position, vitals, teleport-destinations,
// character-recovery, ban state, and every other sub-route.
const PLAYER_OWN_SUBRESOURCES = ["inventory", "vehicles", "bases", "currency", "solaris-coin"];
const OWN_PLAYER_RE = new RegExp(`^/api/players/([^/]+)(?:/(${PLAYER_OWN_SUBRESOURCES.join("|")}))?$`);
const OWN_GUILD_MEMBERS_RE = /^\/api\/guilds\/([^/]+)\/members$/;
const CANONICAL_ID_RE = /^[1-9][0-9]{0,17}$/;
const LIST_PATHS = new Set(["/api/players", "/api/players/online", "/api/players/search", "/api/guilds"]);
// Server-wide settings the Players tab loads on mount. Not per-player data, so a
// player may read them; denying them put an error banner on the tab for every player.
const GLOBAL_READ_PATHS = new Set(["/api/players/list-settings"]);

// -> { kind: "open" }                      not a players/guilds route, this gate has no opinion
//    { kind: "scoped-list" }               list route, scoped in the query
//    { kind: "global-read" }               server-wide config, no per-player data
//    { kind: "own-player", id }            must resolve to one of the caller's characters
//    { kind: "own-guild", id }             must be a guild the caller belongs to
//    { kind: "deny" }                      refuse (reported as 404)
export function classifyPlayerTierRequest(path, method) {
  const guarded = path === "/api/players" || path === "/api/guilds"
    || path.startsWith("/api/players/") || path.startsWith("/api/guilds/");
  if (!guarded) return { kind: "open" };
  if (method !== "GET") return { kind: "deny" };
  if (LIST_PATHS.has(path)) return { kind: "scoped-list" };
  if (GLOBAL_READ_PATHS.has(path)) return { kind: "global-read" };
  const guild = OWN_GUILD_MEMBERS_RE.exec(path);
  if (guild) return CANONICAL_ID_RE.test(guild[1]) ? { kind: "own-guild", id: guild[1] } : { kind: "deny" };
  const player = OWN_PLAYER_RE.exec(path);
  // Only a plain positive integer names a player. That also keeps named routes such as
  // /api/players/deleted-characters (a server-wide list) from ever being read as an id.
  if (player && CANONICAL_ID_RE.test(player[1])) return { kind: "own-player", id: player[1] };
  return { kind: "deny" };
}
