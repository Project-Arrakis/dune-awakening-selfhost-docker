// Server-side scheduled market reseed for the EDA Exchange Bot.
//
// Mirrors the buyback job in addonJobs.js: typed schedule parameters only,
// SQL built server-side from the addon's bundled web/market-seed-plan.json,
// RedBlink backup before every write, and a shared running lock with buyback
// so the two jobs never mutate the exchange at the same time.
//
// Every seed run always clears the bot's own listings for the saved exchange
// before writing the plan (player listings are never touched). Without that
// clear, a repeat interval would stack another full bot market every cycle.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Keep identity helpers local so this module does not circular-import addonJobs.js.
export const EDA_EXCHANGE_BOT_ADDON_ID = "eda-exchange-bot";
const EXCHANGE_ID_PATTERN = /^[1-9][0-9]*$/;
const PG_BIGINT_MAX = 9223372036854775807n;

export function normalizeExchangeId(value) {
  const raw = String(value ?? "").trim();
  if (!EXCHANGE_ID_PATTERN.test(raw)) return null;
  if (BigInt(raw) > PG_BIGINT_MAX) return null;
  return raw;
}

const PAYMENT_SENTINEL_EXPIRY = 999999999;
const MAX_RUN_DETAIL_LENGTH = 500;
const MAX_SEED_PLAN_BYTES = 10 * 1024 * 1024;

// Bot-sold standalone augments are pinned to the bottom 20% of their stat
// ranges: crafting from the schematic keeps the chance of a better roll.
// Whether those bottom-roll items also undercut their schematics is the
// schedule's augmentPricing choice ("discounted", the default) or keep the
// plan's original augment item prices ("original").
const AUGMENT_TEMPLATE_PATTERN = /^T\d+_Augment_/i;
const AUGMENT_STAT_ROLL = 0.2;

export function normalizeAugmentPricing(value) {
  return value === "original" ? "original" : "discounted";
}

// Per-category price multipliers layered on top of the schedule's base
// priceMultiplier, so an operator can price hard-to-get gear above the rest
// of the market. Three categories are recognized:
//   - augments and augment schematics (matched by template, like the augment
//     pricing logic above, so both features always agree on what an augment is);
//   - ranked armor: worn gear at grades 1-5, including stillsuits and
//     radiation suits;
//   - ranked weapons: weapons at grades 1-5.
// Armor and weapons are identified by the exchange's own taxonomy: the high
// byte of category_mask holds the top-level category (0 = armor/garments,
// 1 = weapons). Every other row — and grade-0 stock of the same gear — keeps
// the base multiplier alone.
const CATEGORY_MASK_TOP_LEVEL_DIVISOR = 0x1000000;
const ARMOR_TOP_LEVEL_CATEGORY = 0;
const WEAPON_TOP_LEVEL_CATEGORY = 1;
const MIN_RANKED_QUALITY_LEVEL = 1;
const CATEGORY_MULTIPLIER_MIN = 1;
const CATEGORY_MULTIPLIER_MAX = 5;
export const CATEGORY_MULTIPLIER_FIELDS = ["augmentMultiplier", "rankedArmorMultiplier", "rankedWeaponMultiplier"];
const CATEGORY_MULTIPLIER_LABELS = {
  augmentMultiplier: "augments",
  rankedArmorMultiplier: "ranked armor",
  rankedWeaponMultiplier: "ranked weapons"
};

export function normalizeCategoryMultipliers(payload = {}, previous = {}, scheduleLabel = "Schedule") {
  const multipliers = {};
  for (const field of CATEGORY_MULTIPLIER_FIELDS) {
    multipliers[field] = categoryMultiplierField(payload?.[field] ?? previous?.[field] ?? 1, field, scheduleLabel);
  }
  return multipliers;
}

// Accepts 1-5x with up to two decimals (e.g. 1.5); out-of-range values are
// rejected rather than clamped so a typo cannot quietly reprice the market.
function categoryMultiplierField(value, name, scheduleLabel) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < CATEGORY_MULTIPLIER_MIN || number > CATEGORY_MULTIPLIER_MAX) {
    throw new Error(`${scheduleLabel} ${name} must be a number from ${CATEGORY_MULTIPLIER_MIN} to ${CATEGORY_MULTIPLIER_MAX}.`);
  }
  return Math.round(number * 100) / 100;
}

export function seedRowCategoryMultiplier(row, multipliers = {}) {
  if (AUGMENT_TEMPLATE_PATTERN.test(row.templateId)) return multipliers.augmentMultiplier ?? 1;
  if (row.qualityLevel >= MIN_RANKED_QUALITY_LEVEL) {
    const topLevelCategory = Math.floor(row.categoryMask / CATEGORY_MASK_TOP_LEVEL_DIVISOR);
    if (topLevelCategory === ARMOR_TOP_LEVEL_CATEGORY) return multipliers.rankedArmorMultiplier ?? 1;
    if (topLevelCategory === WEAPON_TOP_LEVEL_CATEGORY) return multipliers.rankedWeaponMultiplier ?? 1;
  }
  return 1;
}

// Human-readable suffix for run details: ", augments 3x, ranked armor 1.5x"
// listing only the categories that differ from the neutral 1x.
export function describeCategoryMultipliers(multipliers = {}) {
  const parts = CATEGORY_MULTIPLIER_FIELDS
    .filter((field) => (multipliers[field] ?? 1) !== 1)
    .map((field) => `${CATEGORY_MULTIPLIER_LABELS[field]} ${multipliers[field]}x`);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

export function normalizeSeedSchedule(payload = {}, previous = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Seed schedule must be a JSON object.");
  }
  const enabled = payload.enabled === undefined ? Boolean(previous.enabled) : payload.enabled;
  if (typeof enabled !== "boolean") throw new Error("Seed schedule enabled must be true or false.");

  const rawExchangeId = payload.exchangeId === undefined
    ? String(previous.exchangeId ?? "").trim()
    : String(payload.exchangeId ?? "").trim();
  let exchangeId = "";
  if (rawExchangeId) {
    exchangeId = normalizeExchangeId(rawExchangeId) ?? "";
    if (!exchangeId) throw new Error("Seed schedule exchangeId must be a positive whole number (PostgreSQL BIGINT).");
  }
  if (enabled && !exchangeId) throw new Error("Seed schedule requires an exchangeId before it can be enabled.");

  return {
    enabled,
    intervalMinutes: clampedIntegerField(payload.intervalMinutes ?? previous.intervalMinutes ?? 15, "intervalMinutes", 10, 1440),
    exchangeId,
    priceMultiplier: integerField(payload.priceMultiplier ?? previous.priceMultiplier ?? 5, "priceMultiplier", 1, 100),
    ...normalizeCategoryMultipliers(payload, previous, "Seed schedule"),
    augmentPricing: normalizeAugmentPricing(payload.augmentPricing ?? previous.augmentPricing),
    // Who owns this schedule: "addon" (bridge-managed; scheduled runs re-verify
    // the addon's approved permissions) or "console" (first-class Market Bot;
    // authorized by RBAC at save time). Deliberately NOT read from the payload —
    // only the save-path options can set it, so an addon iframe cannot flip a
    // schedule to console-sourced and escape its permission checks.
    source: normalizeScheduleSource(previous.source),
    lastRunAt: isoField(previous.lastRunAt),
    lastRunStatus: String(previous.lastRunStatus ?? "").slice(0, 40),
    lastRunDetail: String(previous.lastRunDetail ?? "").slice(0, MAX_RUN_DETAIL_LENGTH),
    nextRunAt: isoField(previous.nextRunAt)
  };
}

export function normalizeScheduleSource(value) {
  return value === "console" ? "console" : "addon";
}

export function readSeedSchedule(config) {
  const path = seedSchedulePath(config);
  let raw = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
    } catch {
      raw = {};
    }
  }
  try {
    return normalizeSeedSchedule({}, raw);
  } catch {
    return normalizeSeedSchedule({}, {});
  }
}

export function saveSeedSchedule(config, payload = {}, { now = () => Date.now(), source } = {}) {
  const previous = readSeedSchedule(config);
  const next = normalizeSeedSchedule(payload, previous);
  if (source !== undefined) next.source = normalizeScheduleSource(source);
  if (!next.enabled) {
    next.nextRunAt = "";
  } else if (!previous.enabled || next.intervalMinutes !== previous.intervalMinutes || !previous.nextRunAt) {
    next.nextRunAt = new Date(now() + next.intervalMinutes * 60000).toISOString();
  } else {
    next.nextRunAt = previous.nextRunAt;
  }
  writeSeedSchedule(config, next);
  return next;
}

// The plan ships with the console (runtime/data/market-seed-plan.json), so the
// first-class Market Bot works with no addon installed. An installed EDA
// Exchange Bot addon's bundled plan still wins when present: operators receive
// catalog updates through addon releases, so the addon copy is assumed newer.
export function resolveMarketSeedPlanPath(config, addonId = EDA_EXCHANGE_BOT_ADDON_ID) {
  const addonPath = resolve(config.repoRoot, "runtime/addons/installed", addonId, "web", "market-seed-plan.json");
  if (existsSync(addonPath)) return addonPath;
  const bundledPath = resolve(config.repoRoot, "runtime/data/market-seed-plan.json");
  if (existsSync(bundledPath)) return bundledPath;
  return null;
}

export function loadMarketSeedPlan(config, addonId = EDA_EXCHANGE_BOT_ADDON_ID) {
  const path = resolveMarketSeedPlanPath(config, addonId);
  if (!path) throw new Error("No market seed plan found: neither the bundled runtime/data/market-seed-plan.json nor an installed addon copy exists.");
  const text = readFileSync(path, "utf8");
  if (text.length > MAX_SEED_PLAN_BYTES) throw new Error("Addon market seed plan is too large.");
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new Error("Addon market seed plan is not valid JSON.");
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Addon market seed plan must be a JSON object.");
  if (!Array.isArray(plan.rows) || !plan.rows.length) throw new Error("Addon market seed plan has no seed rows.");
  const sourceMultiplier = Math.max(1, Number(plan.price_multiplier) || 1);
  const augmentRolls = augmentStatRollCounts(config);
  const rows = plan.rows.map((row, index) => {
    const templateId = String(row?.template_id ?? "").trim();
    if (!templateId || templateId.length > 200) throw new Error(`Addon market seed plan row ${index + 1} has an invalid template_id.`);
    const price = Number(row?.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Addon market seed plan row ${index + 1} has an invalid price.`);
    const kind = String(row?.kind || "equippable").slice(0, 40);
    const stackSize = Math.max(1, Math.trunc(Number(row?.stack_size) || 1));
    const listings = Math.max(1, Math.trunc(Number(row?.listings) || 1));
    const categoryMask = Math.trunc(Number(row?.category_mask) || 0);
    const categoryDepth = clampInteger(row?.category_depth, 1, 0, 4);
    const qualityLevel = clampInteger(row?.quality_level, 0, 0, 5);
    const durMax = clampInteger(row?.durability_max ?? row?.durability_cur ?? 100, 100, 100, 200);
    const durCur = Math.min(clampInteger(row?.durability_cur ?? durMax, durMax, 100, 200), durMax);
    const statRolls = kind !== "schematic" && AUGMENT_TEMPLATE_PATTERN.test(templateId)
      ? Array.from({ length: augmentRolls.get(templateId) ?? 1 }, () => AUGMENT_STAT_ROLL)
      : null;
    return {
      templateId,
      stackSize,
      price,
      categoryMask,
      categoryDepth,
      qualityLevel,
      kind,
      listings,
      itemStats: itemStatsJson(durCur, durMax, statRolls)
    };
  });
  return { sourceMultiplier, rows };
}

// Stat roll counts per augment template, derived from the bundled
// runtime/data/augment-compatibility.json the same way duneDb.js
// augmentRollCount() does: explicit rollCount, else the widest gradeEffects
// list, else the effectSummary segments. Missing catalog data falls back to a
// single roll in loadMarketSeedPlan.
function augmentStatRollCounts(config) {
  const counts = new Map();
  let augments = {};
  try {
    const parsed = JSON.parse(readFileSync(resolve(config.repoRoot, "runtime/data/augment-compatibility.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.augments && typeof parsed.augments === "object") {
      augments = parsed.augments;
    }
  } catch {
    return counts;
  }
  for (const [templateId, entry] of Object.entries(augments)) {
    const explicit = Number(entry?.rollCount ?? entry?.statRollCount);
    if (Number.isFinite(explicit) && explicit > 0) {
      counts.set(templateId, Math.trunc(explicit));
      continue;
    }
    const gradeEffects = entry?.gradeEffects && typeof entry.gradeEffects === "object" ? Object.values(entry.gradeEffects) : [];
    const effectCounts = gradeEffects.filter(Array.isArray).map((effects) => effects.length).filter((count) => count > 0);
    if (effectCounts.length > 0) {
      counts.set(templateId, Math.max(...effectCounts));
      continue;
    }
    if (typeof entry?.effectSummary === "string" && entry.effectSummary.trim()) {
      counts.set(templateId, Math.max(1, entry.effectSummary.split(";").map((part) => part.trim()).filter(Boolean).length));
    }
  }
  return counts;
}

export function buildMarketSeedSql(plan, schedule) {
  const exchangeId = requireSeedExchangeId(schedule);
  const multiplier = schedule.priceMultiplier;
  const augmentPricing = normalizeAugmentPricing(schedule.augmentPricing);
  const augmentSchematicPrices = augmentSchematicPriceMap(plan.rows);
  const valuesSql = plan.rows.map((row) => {
    // Price pipeline: plan price (with the augment pricing choice applied),
    // normalized back to the plan's own 1x scale, then the schedule's base
    // multiplier and the row's category multiplier, rounded to clean steps.
    const price = roundPrice((seedRowBasePrice(row, augmentPricing, augmentSchematicPrices) / plan.sourceMultiplier) * multiplier * seedRowCategoryMultiplier(row, schedule));
    return `(${sqlLiteral(row.templateId)},${row.stackSize},${price},${row.categoryMask},${row.categoryDepth},${row.qualityLevel},${sqlLiteral(row.kind)},${row.listings},${sqlLiteral(row.itemStats)})`;
  }).join(",\n") || "(NULL,1,0,0,0,0,'equippable',0,'{}')";

  // Always clear the bot's own listings for this exchange before seeding.
  const clearSql = `
DO $$
DECLARE
    v_owner_id BIGINT;
    v_exchange_id BIGINT;
    v_item_ids BIGINT[];
BEGIN
    v_exchange_id := ${exchangeId};
    SELECT id INTO v_owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1;
    IF v_owner_id IS NOT NULL THEN
        SELECT ARRAY_AGG(item_id) INTO v_item_ids
        FROM dune.dune_exchange_orders
        WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id AND item_id IS NOT NULL;
        DELETE FROM dune.dune_exchange_sell_orders WHERE order_id IN (SELECT id FROM dune.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id);
        DELETE FROM dune.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id;
        IF v_item_ids IS NOT NULL THEN DELETE FROM dune.items WHERE id = ANY(v_item_ids); END IF;
    END IF;
END $$;`;

  // No outer BEGIN/COMMIT: executeSeedRun wraps this in db.transaction(),
  // matching buildBuybackSql. Nested transaction delimiters end the outer txn
  // early and can zero out listingCount or fail the run.
  return `CREATE TEMP TABLE market_seed_plan (template_id TEXT NOT NULL, stack_size BIGINT NOT NULL, item_price BIGINT NOT NULL, category_mask INTEGER NOT NULL, category_depth SMALLINT NOT NULL, quality_level BIGINT NOT NULL, seed_kind TEXT NOT NULL, listing_count INTEGER NOT NULL, item_stats TEXT NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE market_seed_result (status TEXT NOT NULL, exchange_id BIGINT NOT NULL, access_point_id BIGINT NOT NULL, owner_id BIGINT NOT NULL, inventory_id BIGINT NOT NULL) ON COMMIT DROP;
INSERT INTO market_seed_plan (template_id, stack_size, item_price, category_mask, category_depth, quality_level, seed_kind, listing_count, item_stats) VALUES
${valuesSql};
DELETE FROM market_seed_plan WHERE template_id IS NULL;
${clearSql}
DO $$
DECLARE
    v_exchange_id BIGINT; v_access_point_id BIGINT; v_inventory_id BIGINT; v_owner_id BIGINT; v_user_id BIGINT; v_partition_id BIGINT; v_next_position BIGINT; v_expiration_time BIGINT; v_balance BIGINT; v_item_id BIGINT; v_order_id BIGINT; rec RECORD; idx INTEGER;
BEGIN
    v_exchange_id := ${exchangeId};
    SELECT COALESCE(
        (SELECT id FROM dune.dune_exchange_accesspoints WHERE exchange_id = v_exchange_id ORDER BY id LIMIT 1),
        (SELECT access_point_id FROM dune.dune_exchange_orders WHERE exchange_id = v_exchange_id LIMIT 1)
    ) INTO v_access_point_id;
    IF v_access_point_id IS NULL THEN
        RAISE EXCEPTION 'Exchange % has no access point yet. The game creates one when a player first opens an exchange terminal; seed after that happens.', v_exchange_id;
    END IF;
    SELECT dune.get_exchange_inventory_id(v_exchange_id) INTO v_inventory_id;
    SELECT id INTO v_owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1;
    IF v_owner_id IS NULL THEN
        SELECT partition_id INTO v_partition_id FROM dune.world_partition ORDER BY partition_id LIMIT 1;
        INSERT INTO dune.actors (class, serial, gas_attributes, properties, dimension_index, partition_id) VALUES ('Revy', 0, '{}', '{}', 0, v_partition_id) RETURNING id INTO v_owner_id;
    END IF;
    SELECT dune.dune_exchange_get_user_id(v_owner_id) INTO v_user_id;
    SELECT COALESCE(dune.dune_exchange_retrieve_solari_balance(v_owner_id), 0) INTO v_balance;
    IF v_balance < 1000000000000 THEN
        PERFORM dune.dune_exchange_modify_user_solari_balance(v_owner_id, 9000000000000 - v_balance);
    END IF;
    INSERT INTO dune.dune_exchange_categories_hash (id, hash) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET hash = 0;
    SELECT COALESCE(MAX(position_index), -1) + 1 INTO v_next_position FROM dune.items WHERE inventory_id = v_inventory_id;
    SELECT LEAST(COALESCE(MAX(expiration_time) + 604800, ${PAYMENT_SENTINEL_EXPIRY}), ${PAYMENT_SENTINEL_EXPIRY}) INTO v_expiration_time
    FROM dune.dune_exchange_orders WHERE expiration_time < ${PAYMENT_SENTINEL_EXPIRY};
    FOR rec IN SELECT * FROM market_seed_plan ORDER BY seed_kind, template_id, quality_level LOOP
        FOR idx IN 1..GREATEST(1, rec.listing_count) LOOP
            INSERT INTO dune.items (inventory_id, stack_size, position_index, template_id, quality_level, stats) VALUES (v_inventory_id, rec.stack_size, v_next_position, rec.template_id, rec.quality_level, rec.item_stats::jsonb) RETURNING id INTO v_item_id;
            v_next_position := v_next_position + 1;
            INSERT INTO dune.dune_exchange_orders (exchange_id, access_point_id, owner_id, is_npc_order, expiration_time, template_id, durability_cur, durability_max, category_mask, category_depth, item_price, quality_level, item_id) VALUES (v_exchange_id, v_access_point_id, v_owner_id, TRUE, v_expiration_time, rec.template_id, 1.0, 1.0, rec.category_mask, rec.category_depth, rec.item_price, rec.quality_level, v_item_id) RETURNING id INTO v_order_id;
            INSERT INTO dune.dune_exchange_sell_orders (order_id, initial_stack_size, wear_normalized_price) VALUES (v_order_id, rec.stack_size, rec.item_price);
        END LOOP;
    END LOOP;
    INSERT INTO market_seed_result (status, exchange_id, access_point_id, owner_id, inventory_id) VALUES ('seeded', v_exchange_id, v_access_point_id, v_owner_id, v_inventory_id);
END $$;
SELECT r.status, r.exchange_id, r.access_point_id, r.owner_id, r.inventory_id, SUM(listing_count) AS listing_count, SUM(listing_count) FILTER (WHERE seed_kind = 'equippable') AS equippable_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'schematic') AS schematic_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'resource') AS resource_listings, ${multiplier} AS price_multiplier FROM market_seed_plan CROSS JOIN market_seed_result r GROUP BY r.status, r.exchange_id, r.access_point_id, r.owner_id, r.inventory_id;`;
}

export async function executeSeedRun(config, db, schedule, { runDuneImpl, buildDuneArgs, runSql }) {
  const plan = loadMarketSeedPlan(config);
  if (typeof db?.transaction !== "function") {
    throw new Error("Exchange seed requires database transaction support.");
  }
  if (!config.mockMode) {
    await runDuneImpl(config, buildDuneArgs("backupCreate"), { env: { DB_BACKUP_ORIGIN: `addon-${EDA_EXCHANGE_BOT_ADDON_ID}` } });
  }
  const result = await db.transaction((tx) => runSql(tx, buildMarketSeedSql(plan, schedule), true));
  const row = result?.rows?.[0] || {};
  const listingCount = decimalString(row.listing_count);
  return {
    status: "seeded",
    listingCount,
    equippableListings: decimalString(row.equippable_listings),
    schematicListings: decimalString(row.schematic_listings),
    resourceListings: decimalString(row.resource_listings),
    priceMultiplier: schedule.priceMultiplier,
    exchangeId: schedule.exchangeId,
    detail: `Seeded ${listingCount} listings on exchange ${schedule.exchangeId} at ${schedule.priceMultiplier}x${describeCategoryMultipliers(schedule)} (bot listings cleared first).`
  };
}

export function writeSeedSchedule(config, schedule) {
  const path = seedSchedulePath(config);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(schedule, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

export function persistSeedRunCompletion(config, completedAtMs, status, detail) {
  const current = readSeedSchedule(config);
  writeSeedSchedule(config, {
    ...current,
    lastRunAt: new Date(completedAtMs).toISOString(),
    lastRunStatus: status,
    lastRunDetail: String(detail || "").slice(0, MAX_RUN_DETAIL_LENGTH),
    nextRunAt: current.enabled ? new Date(completedAtMs + current.intervalMinutes * 60000).toISOString() : ""
  });
}

export function seedSchedulePath(config) {
  return resolve(config.repoRoot, "runtime/addons/jobs", EDA_EXCHANGE_BOT_ADDON_ID, "seed.json");
}

function requireSeedExchangeId(schedule) {
  const exchangeId = normalizeExchangeId(schedule?.exchangeId);
  if (!exchangeId) throw new Error("Seed schedule exchangeId is invalid.");
  return exchangeId;
}

function augmentSchematicPriceMap(rows) {
  const prices = new Map();
  for (const row of rows) {
    if (row.kind === "schematic" && AUGMENT_TEMPLATE_PATTERN.test(row.templateId)) {
      prices.set(`${row.templateId}:${row.qualityLevel}`, row.price);
    }
  }
  return prices;
}

// "discounted" augment pricing sells the bot's ready-made (bottom-roll)
// augment items below their patterns: half the matching schematic's price at
// the same grade, or 1/20 of the item's own plan price when no schematic is
// listed — the plan's original augment item ladder (19M-37.5M) is 20x the
// discounted one, so both paths land on the same scale.
function seedRowBasePrice(row, augmentPricing, augmentSchematicPrices) {
  if (augmentPricing !== "discounted" || row.kind === "schematic" || !AUGMENT_TEMPLATE_PATTERN.test(row.templateId)) {
    return row.price;
  }
  const schematicPrice = augmentSchematicPrices.get(`${row.templateId}_Schematic:${row.qualityLevel}`);
  return schematicPrice ? schematicPrice / 2 : row.price / 20;
}

function itemStatsJson(durCur, durMax, statRolls = null) {
  const stats = {
    FItemStackAndDurabilityStats: [[], {
      CurrentDurability: durCur,
      MaxDurability: durMax,
      DecayedMaxDurability: durMax
    }]
  };
  if (Array.isArray(statRolls) && statRolls.length > 0) {
    stats.FAugmentItemStats = [[], { StatRolls: statRolls, AppliedEffectIndices: [] }];
  }
  return JSON.stringify(stats);
}

function decimalString(value) {
  const text = String(value ?? "0").trim();
  return /^-?[0-9]+$/.test(text) ? text : "0";
}

function sqlLiteral(value) {
  return "'" + String(value ?? "").replaceAll("'", "''") + "'";
}

function roundPrice(value) {
  const number = Math.max(1, Number(value) || 1);
  let step = 1;
  if (number >= 1000000) step = 10000;
  else if (number >= 100000) step = 1000;
  else if (number >= 10000) step = 100;
  else if (number >= 1000) step = 10;
  return Math.max(1, Math.round(number / step) * step);
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

function integerField(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Seed schedule ${name} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function clampedIntegerField(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return clampInteger(undefined, min, min, max);
  return Math.min(max, Math.max(min, number));
}

function isoField(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
