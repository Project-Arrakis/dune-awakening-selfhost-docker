import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { intParam } from "../db.js";
import { adminItemMetadata, tableExists } from "../duneDb.js";
import { itemImagePath } from "../adminCatalog.js";
import { writeJsonAtomic } from "../jsonStore.js";
import { redact } from "../redact.js";

// The Market Board is a READ-ONLY viewer over the game's own CHOAM exchange
// tables (the game writes them; we never mutate them here). Data model verified
// against a real dump: dune_exchange_orders holds one row per order with
// is_npc_order / item_price / quality_level / owner_id / item_id / template_id;
// dune_exchange_sell_orders carries initial_stack_size; stock comes from
// items.stack_size. Seller identity resolves the same way the Players page does:
// actors.owner_account_id -> player_state.character_name.
const REQUIRED_TABLES = ["dune_exchange_orders", "dune_exchange_sell_orders", "items", "actors", "player_state"];

const OWNER_FILTERS = new Set(["player", "bot", "all"]);

// owner_id is a bigint (beyond JS safe-int range), so ids are handled as
// digit-strings everywhere and passed to Postgres as bigint[] parameters.
const MAX_IDS = 1000;

const EXCHANGE_CONFIG_PATH = "runtime/generated/exchange-config.json";

// Sort keys the board accepts. display_name/category/tier are catalog-derived
// (not DB columns), which is why sorting happens in the service after enrichment
// rather than in SQL. Keys must match the frontend ExchangeTable column ids.
const EXCHANGE_SORT_COLUMNS = {
  display_name: "str",
  template_id: "str",
  category: "str",
  quality_level: "num",
  tier: "num",
  lowest_price: "num",
  total_stock: "num",
  listing_count: "num"
};

// Short-TTL cache of the enriched, unfiltered aggregate keyed by owner +
// config version, so rapid paging/sorting/searching runs the GROUP BY at most
// once per window. The active-market set is bounded by the item catalog, so this
// stays small. Process-local, like the console's other in-memory caches.
const AGG_CACHE_TTL_MS = 30_000;
const aggregateCache = new Map();

function configFile(repoRoot) {
  return resolve(repoRoot || "", EXCHANGE_CONFIG_PATH);
}

// Digit-string owner ids: validate, dedupe, cap. Lenient by default (drops junk);
// pass throwOnInvalid for the save path so bad input is rejected, not silently
// swallowed.
function coerceIdList(value, { throwOnInvalid = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const id = String(raw).trim();
    if (!/^\d{1,19}$/.test(id)) {
      if (throwOnInvalid) throw Object.assign(new Error(`Invalid owner id: ${id.slice(0, 32) || "(empty)"}. Enter numeric owner ids only.`), { statusCode: 400 });
      continue;
    }
    if (seen.has(id)) continue;
    if (out.length >= MAX_IDS) {
      if (throwOnInvalid) throw Object.assign(new Error(`Too many owner ids (max ${MAX_IDS}).`), { statusCode: 400 });
      break;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function exchangeSupported(db) {
  for (const table of REQUIRED_TABLES) {
    if (!(await tableExists(db, table))) return false;
  }
  return true;
}

function unsupported() {
  return {
    capabilities: { exchange: false },
    rows: [],
    reason: `Unsupported by detected schema. Missing required table(s): ${REQUIRED_TABLES.map((t) => `dune.${t}`).join(", ")}`
  };
}

// Leading tier token (T6_Foo -> 6). Many templates carry no tier prefix; those
// stay null so they sort last / render as a dash.
function parseTier(templateId) {
  const match = /^T(\d{1,2})_/i.exec(templateId);
  return match ? Number(match[1]) : null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// player  -> real player sell orders (not NPC, not a configured bot id)
// bot     -> the in-game NPC broker OR any configured bot owner id
// all     -> no owner predicate
// Blacklisted owner ids are always excluded, on every owner value.
//
// Pushes the bot-id array onto `params` ONLY when the predicate references it.
// The `all` case references no bot param, so passing one would leave an
// unreferenced parameter that Postgres cannot type ("could not determine data
// type of parameter $N").
// The in-game NPC broker (Revy) is classified as a bot via is_npc_order rather
// than a configured owner id. `includeNpcBroker` (default true) lets an admin
// stop treating it as a bot; when false, its orders fall out of the bot bucket
// (and thus appear under player/all like any other seller).
function ownerClause(owner, botIds, includeNpcBroker, params) {
  const npc = includeNpcBroker ? "o.is_npc_order" : "false";
  if (owner === "player") {
    params.push(botIds);
    return `not (${npc} or o.owner_id = any($${params.length}::bigint[]))`;
  }
  if (owner === "bot") {
    params.push(botIds);
    return `(${npc} or o.owner_id = any($${params.length}::bigint[]))`;
  }
  return "true";
}

function enrichItem(row, metadata, repoRoot) {
  const templateId = String(row.template_id || "");
  const meta = metadata.get(templateId);
  return {
    template_id: templateId,
    quality_level: num(row.quality_level),
    display_name: meta?.name || templateId,
    category: meta?.category || "",
    tier: parseTier(templateId),
    lowest_price: num(row.lowest_price),
    total_stock: num(row.total_stock),
    npc_stock: num(row.npc_stock),
    listing_count: num(row.listing_count),
    icon: itemImagePath(repoRoot, templateId)
  };
}

async function queryAggregatedItems(db, { owner, botIds, blacklist, includeNpcBroker, repoRoot }) {
  const params = [];
  const ownerSql = ownerClause(owner, botIds, includeNpcBroker, params);
  params.push(blacklist);
  const blockParam = `$${params.length}::bigint[]`;
  // The INNER join to dune_exchange_sell_orders is load-bearing: it scopes the board
  // to ACTIVE sell listings. Orders that have been fulfilled have no sell_orders row
  // (they live in dune_exchange_fulfilled_orders) and are intentionally excluded.
  // Stock is items.stack_size (the live remaining stack); initial_stack_size is only a
  // fallback for the rare case of a missing items row, and reflects the original (not
  // remaining) quantity — harmless today because every active order has an items row.
  const result = await db.query(`
    select o.template_id,
           o.quality_level,
           min(o.item_price) as lowest_price,
           coalesce(sum(coalesce(i.stack_size, s.initial_stack_size)), 0) as total_stock,
           coalesce(sum(case when o.is_npc_order then coalesce(i.stack_size, s.initial_stack_size) else 0 end), 0) as npc_stock,
           count(*) as listing_count
    from dune.dune_exchange_orders o
    join dune.dune_exchange_sell_orders s on s.order_id = o.id
    left join dune.items i on i.id = o.item_id
    where ${ownerSql} and o.owner_id <> all(${blockParam})
    group by o.template_id, o.quality_level`, params);
  const metadata = adminItemMetadata();
  return result.rows.map((row) => enrichItem(row, metadata, repoRoot));
}

async function aggregatedItems(db, view) {
  const key = `${view.owner}|${view.includeNpcBroker ? 1 : 0}|${view.botIds.join(",")}|${view.blacklist.join(",")}`;
  const now = Date.now();
  const cached = aggregateCache.get(key);
  if (cached && now - cached.at < AGG_CACHE_TTL_MS) return cached.rows;
  const rows = await queryAggregatedItems(db, view);
  aggregateCache.set(key, { at: now, rows });
  return rows;
}

function sortItems(rows, column, direction) {
  const type = EXCHANGE_SORT_COLUMNS[column];
  const factor = direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    let cmp;
    if (type === "num") cmp = num(a[column]) - num(b[column]);
    else cmp = String(a[column] || "").toLowerCase().localeCompare(String(b[column] || "").toLowerCase());
    if (cmp === 0) cmp = String(a.template_id).localeCompare(String(b.template_id));
    return cmp * factor;
  });
}

export async function listExchangeItems(db, {
  q = "", page = 0, pageSize = 50,
  sortColumn = "display_name", sortDirection = "asc",
  owner = "all", category = "", botOwnerIds = [], blacklist = [], includeNpcBroker = true, repoRoot = ""
} = {}) {
  if (!(await exchangeSupported(db))) return { ...unsupported(), totalCount: 0, totalItems: 0, categories: [] };

  const safePageSize = intParam(pageSize, "pageSize", 1, 200);
  const safePage = intParam(page, "page", 0);
  const safeOwner = OWNER_FILTERS.has(owner) ? owner : "all";
  const safeCategory = String(category || "").trim().slice(0, 120);
  const safeSortColumn = Object.hasOwn(EXCHANGE_SORT_COLUMNS, sortColumn) ? sortColumn : "display_name";
  const safeSortDirection = String(sortDirection).toLowerCase() === "desc" ? "desc" : "asc";

  const all = await aggregatedItems(db, {
    owner: safeOwner,
    botIds: coerceIdList(botOwnerIds),
    blacklist: coerceIdList(blacklist),
    includeNpcBroker: includeNpcBroker !== false,
    repoRoot
  });

  // Category options are the distinct categories in the whole owner-scoped set
  // (before the category/search filters) so the dropdown stays stable while you
  // filter within it.
  const categories = [...new Set(all.map((row) => row.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  let filtered = all;
  if (safeCategory && safeCategory !== "all") filtered = filtered.filter((row) => row.category === safeCategory);
  const term = String(q || "").trim().toLowerCase();
  if (term) {
    filtered = filtered.filter((row) => row.display_name.toLowerCase().includes(term)
      || row.category.toLowerCase().includes(term)
      || row.template_id.toLowerCase().includes(term));
  }

  const sorted = sortItems(filtered, safeSortColumn, safeSortDirection);
  const offset = safePage * safePageSize;
  return {
    capabilities: { exchange: true },
    rows: sorted.slice(offset, offset + safePageSize),
    totalCount: filtered.length,
    totalItems: all.length,
    categories
  };
}

export async function listExchangeListings(db, {
  templateId = "", qualityLevel = "", owner = "all", botOwnerIds = [], blacklist = [], includeNpcBroker = true
} = {}) {
  if (!(await exchangeSupported(db))) return unsupported();

  const tid = String(templateId || "").trim();
  if (!tid || tid.length > 240 || /[\r\n\0]/.test(tid)) {
    throw Object.assign(new Error("A valid item template id is required."), { statusCode: 400 });
  }
  const safeOwner = OWNER_FILTERS.has(owner) ? owner : "all";
  const botIds = coerceIdList(botOwnerIds);
  const blacklistIds = coerceIdList(blacklist);

  const params = [tid];
  const ownerSql = ownerClause(safeOwner, botIds, includeNpcBroker !== false, params);
  params.push(blacklistIds);
  const blockParam = `$${params.length}::bigint[]`;
  let qualitySql = "";
  if (String(qualityLevel).trim() !== "") {
    params.push(intParam(qualityLevel, "quality", 0));
    qualitySql = ` and o.quality_level = $${params.length}`;
  }

  const result = await db.query(`
    select o.id::text as order_id,
           o.template_id,
           o.is_npc_order,
           o.owner_id::text as owner_id,
           coalesce(ps.character_name, a.class, 'Unknown') as owner_name,
           o.item_price,
           coalesce(i.stack_size, s.initial_stack_size) as stock,
           coalesce(o.quality_level, 0) as quality
    from dune.dune_exchange_orders o
    join dune.dune_exchange_sell_orders s on s.order_id = o.id
    left join dune.items i on i.id = o.item_id
    left join dune.actors a on a.id = o.owner_id
    left join dune.player_state ps on ps.account_id = a.owner_account_id
    where o.template_id = $1 and ${ownerSql} and o.owner_id <> all(${blockParam})${qualitySql}
    order by o.item_price asc, o.id asc`, params);

  const botSet = new Set(botIds);
  const rows = result.rows.map((row) => {
    const isBot = (includeNpcBroker !== false && Boolean(row.is_npc_order)) || botSet.has(String(row.owner_id));
    return {
      order_id: row.order_id,
      template_id: String(row.template_id || ""),
      owner_type: isBot ? "bot" : "player",
      owner_name: String(row.owner_name || "Unknown"),
      price: num(row.item_price),
      stock: num(row.stock),
      quality: num(row.quality)
    };
  });
  return { capabilities: { exchange: true }, rows };
}

export async function exchangeStats(db, { botOwnerIds = [], blacklist = [], includeNpcBroker = true } = {}) {
  if (!(await exchangeSupported(db))) return unsupported();
  const params = [coerceIdList(botOwnerIds), coerceIdList(blacklist)];
  const npc = includeNpcBroker !== false ? "o.is_npc_order" : "false";
  const result = await db.query(`
    select count(*) as total_listings,
           count(*) filter (where ${npc} or o.owner_id = any($1::bigint[])) as bot_listings,
           count(*) filter (where not (${npc} or o.owner_id = any($1::bigint[]))) as player_listings,
           count(distinct o.template_id) as unique_items
    from dune.dune_exchange_orders o
    join dune.dune_exchange_sell_orders s on s.order_id = o.id
    where o.owner_id <> all($2::bigint[])`, params);
  const row = result.rows[0] || {};
  return {
    capabilities: { exchange: true },
    totalListings: num(row.total_listings),
    botListings: num(row.bot_listings),
    playerListings: num(row.player_listings),
    uniqueItems: num(row.unique_items)
  };
}

export function readExchangeConfig(repoRoot) {
  const file = configFile(repoRoot);
  if (!existsSync(file)) return { includeNpcBroker: true, botOwnerIds: [], blacklistedOwnerIds: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      includeNpcBroker: raw?.includeNpcBroker !== false,
      botOwnerIds: coerceIdList(raw?.botOwnerIds),
      blacklistedOwnerIds: coerceIdList(raw?.blacklistedOwnerIds)
    };
  } catch (error) {
    console.warn(`Ignoring unreadable exchange config: ${redact(error?.message || error)}`);
    return { includeNpcBroker: true, botOwnerIds: [], blacklistedOwnerIds: [] };
  }
}

export function saveExchangeConfig(repoRoot, next) {
  const config = {
    includeNpcBroker: next?.includeNpcBroker !== false,
    botOwnerIds: coerceIdList(next?.botOwnerIds, { throwOnInvalid: true }),
    blacklistedOwnerIds: coerceIdList(next?.blacklistedOwnerIds, { throwOnInvalid: true })
  };
  writeJsonAtomic(configFile(repoRoot), config, 0o600);
  return config;
}

export const exchangeInternals = Object.freeze({
  REQUIRED_TABLES,
  EXCHANGE_SORT_COLUMNS,
  parseTier,
  coerceIdList,
  ownerClause,
  clearCache: () => aggregateCache.clear()
});
