import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILLABLE_GROUPS = new Set(["refined_resource", "component"]);

export function resolveCatalogItem(repoRoot, { itemName = "", itemId = "" } = {}) {
  const value = String(itemId || itemName || "").trim();
  if (!value || value.length > 240 || /[\r\n]/.test(value)) throw new Error("Item name or id is required");

  const items = JSON.parse(readFileSync(resolve(repoRoot, "runtime/data/admin-items.json"), "utf8"));
  const mode = itemId ? "id" : "name";
  if (mode === "id") {
    const exact = items.find((item) => String(item.id || "") === value);
    return normalizeItem(exact || { id: value, name: value, category: "manual", source: "manual" }, repoRoot);
  }

  const folded = value.toLowerCase();
  const exactNames = items.filter((item) => String(item.name || "").toLowerCase() === folded);
  if (exactNames.length === 1) return normalizeItem(exactNames[0], repoRoot);
  if (exactNames.length > 1) {
    throw new Error(`Ambiguous item name: ${value}. Select the item by its exact catalog ID.`);
  }

  const exactId = items.find((item) => String(item.id || "") === value);
  if (exactId) return normalizeItem(exactId, repoRoot);
  throw new Error(`No item found for: ${value}`);
}

export function resolveFillableCatalogItem(repoRoot, query = {}) {
  const resolved = resolveCatalogItem(repoRoot, query);
  if (!resolved.group || !FILLABLE_GROUPS.has(resolved.group)) {
    throw new Error("Item type not allowed for fill operation");
  }
  return resolved;
}

export function isFillableItem(item = {}) {
  return FILLABLE_GROUPS.has(String(item.group || ""));
}

export function resolveItemVolume(repoRoot, templateId) {
  const items = JSON.parse(readFileSync(resolve(repoRoot, "runtime/data/admin-items.json"), "utf8"));
  const match = items.find((item) => String(item.id || "") === templateId);
  return Number(match?.volume) || 0;
}

export function listCatalogItems(repoRoot, { q = "", limit = 500 } = {}) {
  const items = JSON.parse(readFileSync(resolve(repoRoot, "runtime/data/admin-items.json"), "utf8"));
  const term = String(q || "").trim().toLowerCase();
  const max = Math.max(1, Math.min(Number(limit) || 500, 10000));
  return items
    .filter((item) => {
      if (!term) return true;
      return String(item.id || "").toLowerCase().includes(term) ||
        String(item.name || "").toLowerCase().includes(term) ||
        String(item.category || "").toLowerCase().includes(term);
    })
    .slice(0, max)
    .map((item) => normalizeItem(item, repoRoot));
}

export function itemRequiresDatabaseGrant(item = {}) {
  const id = String(item.itemId || item.id || "").trim();
  const category = String(item.category || "").toLowerCase();
  const source = String(item.source || "").toLowerCase();
  return category === "schematics" ||
    source === "schematics" ||
    category.includes("augment") ||
    source.includes("augment") ||
    /^schematic(pattern|_)/i.test(id) ||
    /_schematic$/i.test(id) ||
    /schematic$/i.test(id);
}

export function itemIsSchematic(item = {}) {
  const id = String(item.itemId || item.id || "").trim();
  const category = String(item.category || "").toLowerCase();
  const source = String(item.source || "").toLowerCase();
  return category === "schematics" ||
    source === "schematics" ||
    /^schematic(pattern|_)/i.test(id) ||
    /_schematic$/i.test(id) ||
    /schematic$/i.test(id);
}

export function itemIsRankedSchematic(item = {}, grade = 0) {
  const value = Number(grade);
  return itemIsSchematic(item) && Number.isInteger(value) && value > 0 && value <= 5;
}

function normalizeItem(item, repoRoot = "") {
  const id = String(item.id || "").trim();
  if (!/^[A-Za-z0-9_./:-]{1,240}$/.test(id)) throw new Error("Invalid resolved item id");
  const image = itemImagePath(repoRoot, id);
  const result = {
    id,
    itemId: id,
    name: String(item.name || id),
    category: String(item.category || "manual"),
    source: String(item.source || "manual"),
    image
  };
  if (item.group) result.group = String(item.group);
  if (item.volume !== undefined && item.volume !== null) result.volume = Number(item.volume);
  return result;
}

function itemImagePath(repoRoot, id) {
  if (!repoRoot) return "/images/items/image-unavailable.png";
  const filename = `${id}.png`;
  const relativePath = `images/items/${filename}`;
  const absolutePath = resolve(repoRoot, "console/web/public", relativePath);
  return existsSync(absolutePath) ? `/${relativePath}` : "/images/items/image-unavailable.png";
}
