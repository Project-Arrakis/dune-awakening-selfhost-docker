// Deny-by-default route allowlist for the `player` console tier (#1276).
//
// Operator contract: a `player` session sees only its own character, the
// bases/vehicles/storage it owns (permission rank 1, not co-owner or shared),
// and its guild including the roster. It never sees another player's
// information.
//
// This is a SECOND gate, applied after the IAM policy check in handleApi. The
// IAM policy alone is not enough: a stored policy file replaces the default
// player policy entirely, and several routes the default grants (`maps:read`,
// `players:read`, `server:read`) return fleet-wide data or host details. Every
// route listed here is either global and harmless, or is scoped to the caller
// inside its own handler. A route not listed is refused for the player tier,
// so adding a route elsewhere cannot silently expose it.
//
// Widening this list is a reviewed change: test/playerRouteAllowlist.test.js
// pins the exact set reachable by default.

const PLAYER_EXACT_GET_ROUTES = new Set([
  // Home: server health only.
  "/api/server/status",
  "/api/server/performance",
  "/api/server/readiness",
  "/api/server/restart-history",
  // Own character and guild; the handlers scope these to the caller.
  "/api/players",
  "/api/players/online",
  "/api/players/search",
  "/api/guilds",
  // Map: world data only. /api/map/players is reduced to the caller's own
  // marker in its handler.
  "/api/map/status",
  "/api/map/capabilities",
  "/api/map/partitions",
  "/api/map/poi",
  "/api/map/spice",
  "/api/map/players",
]);

// /api/players/<id>[/...] is guarded per handler by requireOwnPlayerAccess.
// These first segments are routes of their own, not player ids.
const PLAYER_PATH_RESERVED_SEGMENTS = new Set([
  "deleted-characters",
  "list-settings",
  "online",
  "search",
  "kick-all-online",
]);

const PLAYER_ID_PREFIX = "/api/players/";
const GUILD_ROSTER_PATH = /^\/api\/guilds\/[^/]+\/members$/;

export function playerMayCall(method, path) {
  if (typeof method !== "string" || typeof path !== "string") return false;
  if (method.toUpperCase() !== "GET") return false;
  if (PLAYER_EXACT_GET_ROUTES.has(path)) return true;
  if (GUILD_ROSTER_PATH.test(path)) return true;
  if (path.startsWith(PLAYER_ID_PREFIX)) {
    const firstSegment = path.slice(PLAYER_ID_PREFIX.length).split("/", 1)[0];
    return firstSegment !== "" && !PLAYER_PATH_RESERVED_SEGMENTS.has(firstSegment);
  }
  return false;
}

// /api/map/players returns every player on the map (names, FLS/Funcom/account
// ids, positions). A player session gets only its own marker. `ownPawnId` is
// the linked character's pawn actor id; anything that is not a positive
// integer matching a row returns nothing (fail closed).
export function ownMapPlayerRows(rows, ownPawnId) {
  if (!Array.isArray(rows)) return [];
  const own = Number(ownPawnId);
  if (!Number.isSafeInteger(own) || own <= 0) return [];
  return rows.filter((row) => Number(row?.id) === own);
}

// Applies the own-marker rule to a liveMapPlayers() result for a session.
// `getLinkedPlayer` is injected (duneDb.getLinkedPlayer) so this is testable
// without a database. Non-player tiers get the result untouched.
export async function mapPlayersForSession(session, result, getLinkedPlayer) {
  if (session?.tier !== "player") return result;
  const linked = await getLinkedPlayer(session.userId);
  return { capabilities: result?.capabilities, rows: ownMapPlayerRows(result?.rows, linked?.player_pawn_id) };
}
