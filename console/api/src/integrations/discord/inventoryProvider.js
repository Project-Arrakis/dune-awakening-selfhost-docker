import {
  playerInventory,
  playerOwnedStorageQuery,
  guildStorageQuery,
  searchItemsInContainers,
  searchItemsInPlayerInventory,
  adminItemMetadata
} from "../../duneDb.js";

// enrichWithDisplayName: adds a display_name field to every row using the
// same local item catalog (runtime/data/admin-items.json,
// adminItemMetadata() in duneDb.js) already used by
// addonOpsInventorySummary() for the server-wide OPS aggregate
// (/dune ops armory).
//
// Real bug (found via a live user report, 2026-07-26/27): every
// player-facing route in this file (player:inventory, player:storage,
// player:find) returned only the raw template_id (e.g. "AzuriteOre",
// "Bloodsack_01") with no lookup against the catalog at all -- a player
// running /dune player inventory saw a wall of internal game-engine
// identifiers instead of real item names ("Copper Ore", "Small Blood
// Sack"), even though the exact lookup table needed to fix this already
// existed and was already correctly used by the unrelated server-wide
// OPS command. This function closes that gap for every player-facing
// route in one place, rather than patching each raw duneDb.js query
// function separately (which risks missing one, or duplicating the
// lookup logic four times).
//
// Falls back to the raw template_id (current, pre-fix behavior) for any
// item not found in the catalog -- an unrecognized/new item ID should
// never disappear or show as "Unknown", it should just show its raw ID
// exactly as it always has.
function enrichWithDisplayName(rows) {
  const metadata = adminItemMetadata();
  return rows.map((row) => {
    const templateId = row.template_id || row.templateId;
    const meta = templateId ? metadata.get(String(templateId)) : null;
    return { ...row, display_name: meta?.name || templateId || "Unknown Item" };
  });
}

export function groupByMap(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.template_id || item.templateId || "unknown";
    if (!map.has(key)) {
      map.set(key, {
        template_id: key,
        total_count: 0,
        items: []
      });
    }
    const entry = map.get(key);
    entry.total_count += Number(item.stack_size || item.quantity || 1);
    entry.items.push(item);
  }
  return Array.from(map.values());
}

export function groupByContainer(items, containerField = "container_id") {
  const map = new Map();
  for (const item of items) {
    const key = item[containerField] || "unknown";
    if (!map.has(key)) {
      map.set(key, {
        container_id: key,
        container_name: item.container_name || item.name || "",
        item_count: 0,
        items: []
      });
    }
    const entry = map.get(key);
    entry.item_count += 1;
    entry.items.push(item);
  }
  return Array.from(map.values());
}

export async function playerInventoryProvider(db, { playerPawnId, characterName } = {}) {
  const result = await playerInventory(db, playerPawnId);
  const rows = enrichWithDisplayName(result.rows || []);
  return {
    ok: true,
    characterName: characterName || `Player ${playerPawnId}`,
    capabilities: result.capabilities || {},
    grouped: groupByMap(rows),
    rows,
    count: rows.length
  };
}

export async function playerStorageProvider(db, { playerControllerId, scope = "owned" }) {
  if (scope === "owned") {
    const result = await playerOwnedStorageQuery(db, playerControllerId);
    const rows = enrichWithDisplayName(result.rows || []);
    return {
      ok: true,
      scope: "owned",
      grouped: groupByContainer(rows, "id"),
      rows,
      count: rows.length
    };
  }
  if (scope === "guild") {
    const result = await guildStorageQuery(db, playerControllerId);
    const rows = enrichWithDisplayName(result.rows || []);
    return {
      ok: true,
      scope: "guild",
      grouped: groupByContainer(rows, "id"),
      rows,
      count: rows.length
    };
  }
  throw new Error(`Unsupported storage scope: ${scope}. Use "owned" or "guild".`);
}

export async function itemSearchProvider(db, { playerControllerId, query, scope = "owned" }) {
  if (!query || !String(query).trim()) {
    throw new Error("Search query is required.");
  }
  const result = await searchItemsInContainers(db, {
    playerControllerId,
    query: String(query).trim(),
    scope
  });
  const rows = enrichWithDisplayName(result.rows || []);
  return {
    ok: true,
    scope,
    query,
    grouped: groupByMap(rows),
    rows,
    count: rows.length
  };
}

export async function inventorySearchProvider(db, { playerPawnId, query }) {
  if (!query || !String(query).trim()) {
    throw new Error("Search query is required.");
  }
  const result = await searchItemsInPlayerInventory(db, playerPawnId, String(query).trim());
  const rows = enrichWithDisplayName(result.rows || []);
  return {
    ok: true,
    query,
    grouped: groupByMap(rows),
    rows,
    count: rows.length
  };
}
