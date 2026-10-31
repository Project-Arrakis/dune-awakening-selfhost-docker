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
// route listed here is either world data with no host or player detail, or is
// scoped to the caller inside its own handler or reduced by a view below. Being
// admitted does not make a route safe: /api/players/<id>/teleport-destinations
// passes the own-id check yet lists other players, which is why sub-resources
// are listed one by one. A route not listed is refused for the player tier, so
// adding a route elsewhere cannot silently expose it.
//
// Widening this list is a reviewed change: test/playerRouteAllowlist.test.js
// pins the exact set reachable by default.

const PLAYER_EXACT_GET_ROUTES = new Set([
  // Home: server health only. /api/server/status is reduced to a safe projection
  // (playerServerStatusView). /api/server/readiness and /api/map/status are NOT
  // here: they return raw CLI output / per-partition server ids and ports.
  "/api/server/status",
  "/api/server/performance",
  "/api/server/restart-history",
  // Own character and guild; the handlers scope these to the caller.
  "/api/players",
  "/api/players/online",
  "/api/players/search",
  "/api/guilds",
  // Map: world data only. /api/map/players is reduced to the caller's own
  // marker in its handler.
  "/api/map/capabilities",
  "/api/map/partitions",
  "/api/map/poi",
  "/api/map/spice",
  "/api/map/players",
  // Owned assets: the handlers force the caller's own id and rank-1 access,
  // ignore any client-supplied filter and strip other players' names.
  "/api/bases",
  "/api/vehicles",
  "/api/storage",
]);

// /api/players/<id>[/<resource>] is admitted for these own-data resources only.
// The handlers check the id is the caller's own (requireOwnPlayerAccess), but
// that proves the id, not that the payload is own-scoped: teleport-destinations
// lists every other player and base owner in the partition, so it is excluded,
// as are ban and character-recovery (operator tools). A new resource is denied
// until it is added here on purpose.
const PLAYER_OWN_RESOURCES = new Set([
  "crafting-recipes", "research-items", "building-unlocks", "customizations", "journey",
  "inventory", "vehicles", "bases", "currency", "solaris-coin", "factions", "intel",
  "specs", "position", "progression", "vitals", "events", "stats", "history",
]);
// First segments that are routes of their own, not player ids.
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
    const [id, resource, ...rest] = path.slice(PLAYER_ID_PREFIX.length).split("/");
    if (id === "" || PLAYER_PATH_RESERVED_SEGMENTS.has(id) || rest.length > 0) return false;
    return resource === undefined || PLAYER_OWN_RESOURCES.has(resource);
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

// Bases and vehicles list rows carry `shared_with`: the names and ranks of every
// other player with access. A player may see the assets they own, never who
// else is on them (#1276).
//
// The same view also drops what is not the caller's: totalVehicles is a count
// over every vehicle on the server, and a failed query's `reason` carries raw
// database error text.
export function redactSharedWith(result) {
  if (!result || !Array.isArray(result.rows)) return result;
  const out = { ...result, rows: result.rows.map((row) => ({ ...row, shared_with: [] })) };
  if ("totalVehicles" in out) out.totalVehicles = Number(out.totalCount) || 0;
  if ("reason" in out) out.reason = "This list is unavailable right now.";
  return out;
}

// Pawn actor id of the session's linked character, or null when it is not a
// positive safe integer (unlinked, or the "0" getLinkedPlayer falls back to).
export function ownPawnId(linked) {
  const id = Number(linked?.player_pawn_id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Options for duneDb.listBases / listVehicles for a player session. Everything
// the client could use to widen the scope (playerId, access) is fixed here;
// only paging, sort and search pass through, and page size is capped.
export function ownedListOptions(linked, query) {
  const playerId = ownPawnId(linked);
  if (playerId === null) return null;
  const size = Number(query?.pageSize);
  return {
    playerId,
    access: "owner",
    q: typeof query?.q === "string" ? query.q : "",
    page: query?.page ?? 0,
    pageSize: Number.isSafeInteger(size) && size >= 1 && size <= 200 ? size : 50,
    // shared_with would order the caller's rows by how many other players have access.
    sortColumn: query?.sortColumn && query.sortColumn !== "shared_with" ? query.sortColumn : "name",
    sortDirection: query?.sortDirection || "asc",
    ...(query?.status ? { status: query.status } : {}),
  };
}

// /api/server/status for a player: overall state, title, region, mode,
// population and the per-map game server states. Everything else the CLI prints
// (raw stdout, server ip, battlegroup id, container names, listener ports,
// RabbitMQ and FLS details) is dropped.
export function playerServerStatusView(body) {
  const data = body?.data || {};
  const summary = data.summary || {};
  return {
    schemaVersion: body?.schemaVersion ?? 1,
    ok: body?.ok === true,
    data: {
      summary: { overall: summary.overall ?? null, title: summary.title ?? null, region: summary.region ?? null, mode: summary.mode ?? null, population: summary.population ?? null },
      gameServers: Array.isArray(data.gameServers) ? data.gameServers.map((g) => ({ map: g?.map ?? null, status: g?.status ?? null, uptime: g?.uptime ?? null })) : [],
    },
  };
}

// Body of GET /api/bases | /api/vehicles | /api/storage for a `player` session.
// Dependencies are injected so the whole handler runs under test against a real
// database without a running server. `notLinked` is returned (not thrown) for an
// unlinked character and for a linked one whose pawn id is not a positive integer.
export async function playerOwnedAssetsBody({ duneDb, db, session, path, query, linkInstructions }) {
  const linked = await duneDb.getLinkedPlayer(db, session.userId);
  const options = ownedListOptions(linked, query);
  if (!linked || !options) {
    return { capabilities: {}, totalCount: 0, rows: [], notLinked: true, reason: linkInstructions.reason, linkInstructions };
  }
  if (path === "/api/storage") return duneDb.listOwnedStorage(db, linked.player_controller_id);
  const result = path === "/api/bases" ? await duneDb.listBases(db, options) : await duneDb.listVehicles(db, options);
  return redactSharedWith(result);
}

// The `access` filter for /api/players/<id>/bases|vehicles: a player always gets
// owner-only, whatever the query asked for; other tiers keep the requested value.
export function effectiveAccess(session, requested) {
  return session?.tier === "player" ? "owner" : requested;
}

// Player-tier view of a bases/vehicles list; other tiers get the result untouched.
export function ownedViewForSession(session, result) {
  return session?.tier === "player" ? redactSharedWith(result) : result;
}

// Status body for a session: players get the reduced projection.
export function statusBodyForSession(session, body) {
  return session?.tier === "player" ? playerServerStatusView(body) : body;
}
