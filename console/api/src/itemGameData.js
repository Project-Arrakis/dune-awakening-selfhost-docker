import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Unit volume and stack limit for the game's items, from the game's own item
// tables (runtime/data/item-game-data.PROVENANCE.md). Kept beside
// admin-items.json rather than inside it, so the shared catalog does not have to
// carry thousands of edits. Callers pass the admin-items.json path they loaded:
// the two files are always read from the same checkout.
export const ITEM_GAME_DATA_FILE = "item-game-data.json";

const cache = new Map();
const catalogCache = new Map();

// admin-items.json with the game data filled in. adminCatalog (the routes) and
// duneDb (stack limits and volume totals) both read through this cache, which is
// checked against both files on every call, so a changed, deleted or restored
// file reaches the two at the same time. Throws when admin-items.json cannot be
// read or is not a list.
export function loadItemCatalog(adminItemsFile) {
  const file = resolve(adminItemsFile);
  const gameData = loadItemGameData(file);
  const fileStamp = stampOf(file);
  const stamp = fileStamp && `${fileStamp}|${gameData.stamp}`;
  const cached = catalogCache.get(file);
  if (stamp && cached?.stamp === stamp) return cached;
  const rows = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(rows)) throw new Error("expected a list of items");
  const items = rows.map((row) => withItemGameData(row, gameData));
  // An id listed twice resolves to its first row.
  const byId = new Map();
  const curatedById = new Map();
  items.forEach((item, index) => {
    const id = String(item?.id || "");
    if (!id || byId.has(id)) return;
    byId.set(id, item);
    curatedById.set(id, rows[index]);
  });
  const entry = { stamp, items, byId, curatedById, gameData };
  if (catalogCache.size > 16) catalogCache.clear();
  catalogCache.set(file, entry);
  return entry;
}

export function loadItemGameData(adminItemsFile) {
  const file = resolve(dirname(adminItemsFile), ITEM_GAME_DATA_FILE);
  // A missing file is reported by the read below, once.
  const stamp = stampOf(file) || "missing";
  const cached = cache.get(file);
  if (cached && cached.stamp === stamp) return cached;
  let entry;
  try {
    entry = buildLookup(JSON.parse(readFileSync(file, "utf8")), stamp);
  } catch (error) {
    console.warn(`${ITEM_GAME_DATA_FILE} could not be loaded -- items without curated catalog data have no known volume or stack limit: ${error?.message || "unknown error"}`);
    entry = { stamp, get: () => null };
  }
  if (cache.size > 16) cache.clear();
  cache.set(file, entry);
  return entry;
}

// A value curated in admin-items.json always wins; this only fills gaps.
export function withItemGameData(item, gameData) {
  const known = gameData.get(String(item?.id || "").trim());
  if (!known) return item;
  const merged = { ...item };
  if (item.volume === undefined || item.volume === null) merged.volume = known.volume;
  if (!isStackSize(item.stackSize)) merged.stackSize = known.stackSize;
  return merged;
}

function buildLookup(data, stamp) {
  if (!isObject(data?.volume) || !isObject(data?.maxStack)) throw new Error("expected \"volume\" and \"maxStack\" objects");
  const stacks = new Map(Object.entries(data.maxStack).filter(([, value]) => isStackSize(value)));
  const byId = new Map();
  const byLowerId = new Map();
  for (const [id, volume] of Object.entries(data.volume)) {
    if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0) continue;
    // An item with no stack limit listed holds one per slot.
    const row = Object.freeze({ volume, stackSize: stacks.get(id) || 1 });
    byId.set(id, row);
    const lower = id.toLowerCase();
    // Two ids differing only by case: neither may answer for a third spelling.
    byLowerId.set(lower, byLowerId.has(lower) ? null : row);
  }
  return { stamp, get: (id) => byId.get(id) || byLowerId.get(String(id).toLowerCase()) || null };
}

function stampOf(file) {
  try {
    const stat = statSync(file, { bigint: true });
    return `${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
  } catch {
    return "";
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStackSize(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
