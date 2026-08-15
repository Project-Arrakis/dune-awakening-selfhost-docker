const INVENTORY_UNCHANGED_RE = /inventory stack did not increase/i;
const INVENTORY_PARTIAL_RE = /inventory grant was incomplete: requested (\d+), verified (\d+)/i;

export function liveItemGrantWarning(result = {}) {
  const stderr = String(result.stderr || "");
  const partial = stderr.match(INVENTORY_PARTIAL_RE);
  if (partial) {
    return `Published to RabbitMQ, but only ${partial[2]} of ${partial[1]} requested items were verified. The missing quantity was not retried to avoid duplicate items.`;
  }
  if (INVENTORY_UNCHANGED_RE.test(stderr)) {
    return "Published to RabbitMQ, but the player's inventory did not change. The game server may have rejected the item.";
  }
  return "";
}

export function liveItemGrantOk(result = {}) {
  return Number(result.code || 0) === 0 && !liveItemGrantWarning(result);
}
