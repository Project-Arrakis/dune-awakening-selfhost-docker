import { formatChatBodyMessage } from "../rmq.js";

// Keep variable expansion shared by in-game delivery and the Player Portal so
// both surfaces show the same player-specific message.
export function renderPlayerMessageTemplate(template, playerName) {
  const rendered = String(template || "").replaceAll("{playerName}", String(playerName || "Player"));
  return rendered.trim() ? formatChatBodyMessage(rendered) : "";
}
