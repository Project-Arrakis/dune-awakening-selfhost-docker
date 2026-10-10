import { normalizeTier } from "./policy.js";

// Which player controller ids a session may see. Only the player tier is
// restricted; every other principal (owner/admin/moderator, password and
// ADMIN_AUTH_DISABLED sessions, API keys, write-bridge principals) is unscoped.
//
// Fails closed for the player tier: no user id, no linked characters, or a failed
// lookup all yield an EMPTY scope, which listPlayers/listGuilds treat as "nothing".
// The tier check must come first: owner sessions legitimately have no userId.
export async function resolvePlayerScope(session, getLinkedPlayers, log = console.error) {
  if (!session) return { scoped: true, ids: new Set() };
  if (normalizeTier(session.tier) !== "player") return { scoped: false, ids: new Set() };
  if (!session.userId) return { scoped: true, ids: new Set() };
  try {
    const chars = await getLinkedPlayers(session.userId);
    // Drop null/empty/zero ids: "0" is player_state's placeholder controller id
    // and would match unlinked rows (issue #1116 review).
    const ids = chars
      .map((c) => c.player_controller_id)
      .filter((id) => id !== null && id !== undefined && String(id) !== "" && String(id) !== "0");
    return { scoped: true, ids: new Set(ids.map(String)) };
  } catch (error) {
    log(`player scope lookup failed: ${error && error.message ? error.message : error}`);
    return { scoped: true, ids: new Set() };
  }
}
