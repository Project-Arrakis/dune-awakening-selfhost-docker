const INVENTORY_UNCHANGED_RE = /inventory stack did not increase/i;
const INVENTORY_PARTIAL_RE = /inventory grant was incomplete: requested (\d+), verified (\d+)/i;
const GRANT_PUBLISHED_RE = /grant item command published/i;

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

export function liveItemGrantPublished(result = {}) {
  return Number(result.code ?? -1) === 0 && GRANT_PUBLISHED_RE.test(String(result.stdout || ""));
}

export function customizationGrantOutcome(result = {}) {
  const inventoryVerified = result.ok === true;
  const deliveryRequested = !inventoryVerified && result.published === true;
  return {
    ok: inventoryVerified || deliveryRequested,
    // Inventory delivery is observable; persistent cosmetic ownership is
    // controlled by Funcom/Steam entitlements and is not stored in this DB.
    verified: false,
    inventoryVerified,
    ownershipVerified: false,
    deliveryRequested
  };
}

export function summarizeCustomizationGrantResults(results = []) {
  return {
    ok: results.every((result) => result.ok),
    granted: results.filter((result) => result.ok && !result.skipped && !result.deliveryRequested).length,
    requested: results.filter((result) => result.deliveryRequested).length,
    skipped: results.filter((result) => result.skipped).length,
    failed: results.filter((result) => !result.ok).length
  };
}
