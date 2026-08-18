const PLAYER_IDENTIFIERS = ["action_player_id", "funcom_id", "fls_id", "account_id", "actor_id", "player_pawn_id"];

export function findPlayerForLiveAction(rows, playerId) {
  const target = String(playerId || "").trim().toLowerCase();
  if (!target || !Array.isArray(rows)) return null;
  return rows.find((row) => PLAYER_IDENTIFIERS.some((key) => String(row?.[key] || "").trim().toLowerCase() === target)) || null;
}

export function playerIsOnlineForLiveAction(player) {
  return String(player?.actual_online_status || player?.online_status || "").trim().toLowerCase() === "online";
}
