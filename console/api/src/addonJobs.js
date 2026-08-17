// Server-side scheduled jobs for the native Market Bot, retained in this
// module to keep the original engine API stable during the EDA retirement.
//
// The engine began as the EDA Exchange Bot buyback sweep. The console API now
// owns and runs the loop unattended: a read-only
// eligibility probe every interval, and a buyback sweep (preceded by a
// database backup) only when eligible player listings exist. Every considered
// player listing is classified into the Buyback Sweep Log (purchased or skipped
// with the mismatch reason), including idle ticks that buy nothing.
//
// No SQL from the addon iframe is ever persisted or replayed. The SQL below
// is built server-side from the console-bundled market-seed-plan.json and
// a strictly validated schedule config, following the typed-action precedent
// of admin.items.grant.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildDuneArgs, runDune } from "./runner.js";
import { assertInstalledAddonPermission } from "./addons.js";
import { runSql } from "./duneDb.js";
import { writeJsonAtomic } from "./jsonStore.js";
import { audit } from "./audit.js";
import { redact } from "./redact.js";
import {
  readSeedSchedule,
  saveSeedSchedule,
  writeSeedSchedule,
  persistSeedRunCompletion,
  executeSeedRun,
  normalizeCategoryMultipliers,
  normalizeScheduleSource,
  resolveMarketSeedPlanPath,
  legacySeedSchedulePath,
  seedSchedulePath,
  seedRowCategoryMultiplier
} from "./addonSeedJob.js";

export { CATEGORY_MULTIPLIER_FIELDS, readSeedSchedule, normalizeSeedSchedule, saveSeedSchedule, normalizeCategoryMultipliers, normalizeScheduleSource, resolveMarketSeedPlanPath, legacySeedSchedulePath, seedSchedulePath, loadMarketSeedPlan, seedRowCategoryMultiplier } from "./addonSeedJob.js";

export const EDA_EXCHANGE_BOT_ADDON_ID = "eda-exchange-bot";
export const ADDON_SCHEDULER_PERMISSION = "scheduler:server";
export const ADDON_SCHEDULED_RUN_RATE_SCOPE = `addon-scheduler:${EDA_EXCHANGE_BOT_ADDON_ID}`;

// Sentinel expiration used by EDA's market bot for seller "Take Solari"
// payment entries. The game server's exchange housekeeping procs purge
// past-dated orders; a payment entry must never expire or the seller's item
// is consumed with no Solari paid out.
//
// Time-base note: dune_exchange_orders.expiration_time is NOT a Unix epoch.
// The exchange procs compare it against the game server's own clock, whose
// values sit well below 999,999,999 — Easy Dune Admin's marketbot
// (internal/marketbot/exchange.go, the source this fix is ported from)
// reconstructs "gameNow" from real player/bot listing expirations using
// `WHERE expiration_time < 999_999_999` as the non-sentinel filter, which
// only works because live expirations are below that cutoff. Its deployed
// sellerPaymentExpiry() returns exactly this sentinel. Do not "fix" this to a
// far-future Unix timestamp; it must simply stay far above the game clock and
// aligned with the sentinel the addon's own browser sweep writes.
const PAYMENT_SENTINEL_EXPIRY = 999999999;

// PostgreSQL BIGINT ids can exceed Number.MAX_SAFE_INTEGER (2^53 - 1), so
// exchange ids are kept as validated decimal strings end-to-end and are never
// converted with Number().
const EXCHANGE_ID_PATTERN = /^[1-9][0-9]*$/;
const PG_BIGINT_MAX = 9223372036854775807n;

const MAX_RUN_DETAIL_LENGTH = 500;
const MAX_SEED_PLAN_BYTES = 10 * 1024 * 1024;
const MAX_BUYBACK_LOG_BATCHES = 20;
const MAX_BUYBACK_LOG_ENTRIES = 1000;

// Per-listing buyback outcomes shown in the Market Bot sweep log. 0x0 is a
// purchase on a write sweep, or "eligible" on a dry-run. 0x1–0x4 are criteria
// mismatches; 0x5 is past Max Buys; 0x6 is SKIP LOCKED / concurrent remove.
export const BUYBACK_RESULT_CODES = {
  0: { label: "success", summary: "Bought (or eligible on dry-run)" },
  1: { label: "price too high", summary: "Ask exceeds buyback cap (threshold % of the selected price basis)" },
  2: { label: "no reference price", summary: "Template not in the seed plan (no seeded or live reference)" },
  3: { label: "invalid price", summary: "Non-positive item_price" },
  4: { label: "invalid stack", summary: "Stack size is zero or missing" },
  5: { label: "max buys limit", summary: "Eligible but past Max Buys Per Sweep this run" },
  6: { label: "skipped locked", summary: "Eligible but locked by a concurrent sweep" }
};

export function normalizeExchangeId(value) {
  const raw = String(value ?? "").trim();
  if (!EXCHANGE_ID_PATTERN.test(raw)) return null;
  if (BigInt(raw) > PG_BIGINT_MAX) return null;
  return raw;
}

function normalizeBuybackPriceBasis(value) {
  const text = String(value || "seeded").trim().toLowerCase();
  if (text === "average" || text === "lowest") return text;
  return "seeded";
}

export function normalizeBuybackSchedule(payload = {}, previous = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Buyback schedule must be a JSON object.");
  const enabled = payload.enabled === undefined ? Boolean(previous.enabled) : payload.enabled;
  if (typeof enabled !== "boolean") throw new Error("Buyback schedule enabled must be true or false.");

  const rawExchangeId = payload.exchangeId === undefined ? String(previous.exchangeId ?? "").trim() : String(payload.exchangeId ?? "").trim();
  let exchangeId = "";
  if (rawExchangeId) {
    exchangeId = normalizeExchangeId(rawExchangeId) ?? "";
    if (!exchangeId) throw new Error("Buyback schedule exchangeId must be a positive whole number (PostgreSQL BIGINT).");
  }
  if (enabled && !exchangeId) throw new Error("Buyback schedule requires an exchangeId before it can be enabled.");

  return {
    enabled,
    intervalMinutes: clampedIntegerField(payload.intervalMinutes ?? previous.intervalMinutes ?? 30, "intervalMinutes", 10, 1440),
    exchangeId,
    priceMultiplier: integerField(payload.priceMultiplier ?? previous.priceMultiplier ?? 5, "priceMultiplier", 1, 100),
    // Category multipliers mirror the seed schedule's: keep them in sync so
    // the reconstructed "seeded" price basis matches what the market actually
    // sells at (buybackPercent then means percent of the real market price).
    ...normalizeCategoryMultipliers(payload, previous, "Buyback schedule"),
    buybackPercent: integerField(payload.buybackPercent ?? previous.buybackPercent ?? 60, "buybackPercent", 1, 100),
    buybackPriceBasis: normalizeBuybackPriceBasis(payload.buybackPriceBasis ?? previous.buybackPriceBasis ?? "seeded"),
    maxBuys: integerField(payload.maxBuys ?? previous.maxBuys ?? 500, "maxBuys", 1, 5000),
    // Never read from the payload: only the save-path options can set this
    // (see saveBuybackSchedule), so a bridge payload cannot mark a schedule
    // console-sourced and skip the addon permission re-checks.
    source: normalizeScheduleSource(previous.source),
    lastRunAt: isoField(previous.lastRunAt),
    lastRunStatus: String(previous.lastRunStatus ?? "").slice(0, 40),
    lastRunDetail: String(previous.lastRunDetail ?? "").slice(0, MAX_RUN_DETAIL_LENGTH),
    nextRunAt: isoField(previous.nextRunAt)
  };
}

export function readBuybackSchedule(config) {
  const corePath = buybackSchedulePath(config);
  const legacyPath = legacyBuybackSchedulePath(config);
  const path = existsSync(corePath) ? corePath : legacyPath;
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
    return normalizeBuybackSchedule({}, raw);
  } catch {
    // A corrupt or hand-edited schedule never blocks the console: fall back
    // to a disabled schedule and let the operator re-save it from the addon.
    return normalizeBuybackSchedule({}, {});
  }
}

// Read-modify-write over the schedule file. This function and
// persistRunCompletion in createAddonJobScheduler are deliberately fully
// synchronous (no await between read and write), so within the single console
// process they cannot interleave and clobber each other's fields; the atomic
// temp-file rename covers crash safety. Multiple console processes sharing one
// repoRoot are not a supported deployment for runtime/ state files.
export function saveBuybackSchedule(config, payload = {}, { now = () => Date.now(), source } = {}) {
  const previous = readBuybackSchedule(config);
  const next = normalizeBuybackSchedule(payload, previous);
  if (source !== undefined) next.source = normalizeScheduleSource(source);
  if (!next.enabled) {
    next.nextRunAt = "";
  } else if (!previous.enabled || next.intervalMinutes !== previous.intervalMinutes || !previous.nextRunAt) {
    // Arm one full interval out so enabling (or shortening the interval)
    // never fires an immediate surprise write.
    next.nextRunAt = new Date(now() + next.intervalMinutes * 60000).toISOString();
  } else {
    next.nextRunAt = previous.nextRunAt;
  }
  writeBuybackSchedule(config, next);
  return next;
}

export function loadBuybackSeedPlan(config, addonId = EDA_EXCHANGE_BOT_ADDON_ID) {
  // The console-bundled plan is authoritative. An installed addon copy is a
  // compatibility fallback for deployments upgrading from older releases.
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
  const rows = plan.rows.map((row, index) => {
    const templateId = String(row?.template_id ?? "").trim();
    if (!templateId || templateId.length > 200) throw new Error(`Addon market seed plan row ${index + 1} has an invalid template_id.`);
    const price = Number(row?.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Addon market seed plan row ${index + 1} has an invalid price.`);
    return {
      templateId,
      displayName: String(row?.display_name || "").trim(),
      price,
      qualityLevel: clampInteger(row?.quality_level, 0, 0, 5),
      categoryMask: Math.trunc(Number(row?.category_mask) || 0)
    };
  });
  return { sourceMultiplier, rows };
}

// A listing can carry its grade on either the exchange order or its backing
// item. The order column defaults to zero, so COALESCE would hide a real grade
// stored only on the item; use the higher validated value instead.
const BUYBACK_ORDER_GRADE_SQL = "LEAST(GREATEST(COALESCE(o.quality_level, 0), COALESCE(i.quality_level, 0), 0), 5)";

// Player resource listings can retain a stale items.stack_size of 1 while the
// sell order holds the full quantity. The sweep removes the whole listing, so
// it must also pay for the larger positive quantity.
const BUYBACK_STACK_SQL = "GREATEST(COALESCE(i.stack_size, 0), COALESCE(s.initial_stack_size, 0))";

const BUYBACK_ELIGIBLE_PREDICATE = `o.item_price > 0 AND ${BUYBACK_STACK_SQL} > 0 AND o.item_price <= p.max_unit_price`;

// Prefer the exact seeded grade. When a template does not seed every grade,
// use the closest seeded grade below the listing so the cap stays
// conservative; only listings below every seeded grade fall up to the lowest
// available row.
const BUYBACK_PLAN_LATERAL = `LEFT JOIN LATERAL (
        SELECT pp.template_id, pp.quality_level, pp.max_unit_price
        FROM market_buy_plan pp
        WHERE pp.template_id = o.template_id
        ORDER BY (pp.quality_level <= ${BUYBACK_ORDER_GRADE_SQL}) DESC,
                 CASE WHEN pp.quality_level <= ${BUYBACK_ORDER_GRADE_SQL} THEN -pp.quality_level ELSE pp.quality_level END
        LIMIT 1
    ) p ON TRUE`;

// Shared by the write-sweep log table and the read-only dry-run classify query.
const BUYBACK_RESULT_CODE_SQL = `CASE
        WHEN p.template_id IS NULL THEN 2
        WHEN o.item_price <= 0 THEN 3
        WHEN ${BUYBACK_STACK_SQL} <= 0 THEN 4
        WHEN o.item_price > p.max_unit_price THEN 1
        ELSE 0
    END`;
const BUYBACK_RESULT_LABEL_SQL = `CASE
        WHEN p.template_id IS NULL THEN 'no reference price'
        WHEN o.item_price <= 0 THEN 'invalid price'
        WHEN ${BUYBACK_STACK_SQL} <= 0 THEN 'invalid stack'
        WHEN o.item_price > p.max_unit_price THEN 'price too high'
        ELSE 'eligible'
    END`;
const BUYBACK_RESULT_DETAIL_SQL = `CASE
        WHEN p.template_id IS NULL THEN 'template not in seed plan (no seeded or live reference for this template)'
        WHEN o.item_price <= 0 THEN 'item_price must be > 0'
        WHEN ${BUYBACK_STACK_SQL} <= 0 THEN 'stack size must be > 0'
        WHEN o.item_price > p.max_unit_price THEN 'ask ' || o.item_price::text || ' > cap ' || p.max_unit_price::text
        ELSE 'ask ' || o.item_price::text || '/unit <= cap ' || p.max_unit_price::text || '; buy whole stack ' || (${BUYBACK_STACK_SQL})::text
    END`;

function buybackLiveBasisAggregateSql(priceBasis) {
  return priceBasis === "lowest" ? "MIN(o.item_price)" : "AVG(o.item_price)";
}

const BUYBACK_PLAYER_SELL_SQL = "COALESCE(o.is_npc_order, FALSE) = FALSE AND (b.owner_id IS NULL OR o.owner_id IS DISTINCT FROM b.owner_id)";

// Buyback plan: one exact cap per (template, grade), scaled from each bundled
// seed row. Seed prices use stepped rounding, so reconstructing higher grades
// from a grade-0 base can differ from the actual configured market price.
// The schedule's category multipliers reprice each row the same way the seed
// run does, so the "seeded" basis tracks the boosted market.
export function buybackPlanValuesSql(plan, schedule) {
  const { priceMultiplier, buybackPercent } = schedule;
  const maxPrice = new Map();
  for (const row of plan.rows) {
    const repriced = roundPrice((row.price / plan.sourceMultiplier) * priceMultiplier * seedRowCategoryMultiplier(row, schedule));
    const key = `${row.templateId}\0${row.qualityLevel}`;
    maxPrice.set(key, Math.max(maxPrice.get(key) || 0, repriced));
  }
  return Array.from(maxPrice.entries())
    .map(([key, price]) => {
      const separator = key.indexOf("\0");
      return {
        templateId: key.slice(0, separator),
        qualityLevel: Number(key.slice(separator + 1)),
        maxUnitPrice: Math.max(1, Math.floor((price * buybackPercent + 99) / 100))
      };
    })
    .sort((a, b) => a.templateId.localeCompare(b.templateId) || a.qualityLevel - b.qualityLevel)
    .map((entry) => `(${sqlLiteral(entry.templateId)},${entry.qualityLevel},${entry.maxUnitPrice})`)
    .join(",\n");
}

function buybackMarketPlanCteSql(plan, schedule) {
  const exchangeId = requireScheduleExchangeId(schedule);
  const valuesSql = buybackPlanValuesSql(plan, schedule) || "(NULL::text,NULL::bigint,NULL::bigint)";
  const priceBasis = normalizeBuybackPriceBasis(schedule.buybackPriceBasis);
  if (priceBasis === "seeded") {
    return `market_buy_plan(template_id, quality_level, max_unit_price) AS (
    VALUES
${valuesSql}
)`;
  }
  const threshold = schedule.buybackPercent;
  const aggregate = buybackLiveBasisAggregateSql(priceBasis);
  return `seed_buy_caps(template_id, quality_level, max_unit_price) AS (
    VALUES
${valuesSql}
),
live_buy_basis AS (
    SELECT o.template_id,
           ${BUYBACK_ORDER_GRADE_SQL} AS quality_level,
           ${aggregate} AS basis_price
    FROM dune.dune_exchange_orders o
    JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id
    LEFT JOIN dune.items i ON i.id = o.item_id
    LEFT JOIN (SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1) b ON TRUE
    WHERE o.exchange_id = ${exchangeId}
      AND ${BUYBACK_PLAYER_SELL_SQL}
      AND o.item_price > 0
      AND ${BUYBACK_STACK_SQL} > 0
      AND EXISTS (SELECT 1 FROM seed_buy_caps sc WHERE sc.template_id IS NOT NULL AND sc.template_id = o.template_id)
    GROUP BY o.template_id, ${BUYBACK_ORDER_GRADE_SQL}
),
live_buy_caps AS (
    SELECT template_id,
           quality_level,
           GREATEST(1, FLOOR((basis_price * ${threshold} + 99) / 100))::bigint AS max_unit_price
    FROM live_buy_basis
),
market_buy_plan AS (
    SELECT template_id, quality_level, max_unit_price FROM live_buy_caps
    UNION ALL
    SELECT s.template_id, s.quality_level, s.max_unit_price
    FROM seed_buy_caps s
    WHERE s.template_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM live_buy_caps l
        WHERE l.template_id = s.template_id AND l.quality_level = s.quality_level
      )
)`;
}

function buybackPlanPopulateSql(plan, schedule) {
  const exchangeId = requireScheduleExchangeId(schedule);
  const valuesSql = buybackPlanValuesSql(plan, schedule);
  const priceBasis = normalizeBuybackPriceBasis(schedule.buybackPriceBasis);
  if (priceBasis === "seeded") {
    if (!valuesSql) return `-- buyback plan empty: no seeded caps\n`;
    return `INSERT INTO market_buy_plan (template_id, quality_level, max_unit_price) VALUES
${valuesSql};`;
  }
  const seedValues = valuesSql || "(NULL::text,NULL::bigint,NULL::bigint)";
  const threshold = schedule.buybackPercent;
  const aggregate = buybackLiveBasisAggregateSql(priceBasis);
  return `INSERT INTO market_buy_plan (template_id, quality_level, max_unit_price)
SELECT template_id, quality_level, max_unit_price FROM (
    WITH seed_buy_caps(template_id, quality_level, max_unit_price) AS (
        VALUES
${seedValues}
    ),
    live_buy_basis AS (
        SELECT o.template_id,
               ${BUYBACK_ORDER_GRADE_SQL} AS quality_level,
               ${aggregate} AS basis_price
        FROM dune.dune_exchange_orders o
        JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id
        LEFT JOIN dune.items i ON i.id = o.item_id
        LEFT JOIN (SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1) b ON TRUE
        WHERE o.exchange_id = ${exchangeId}
          AND ${BUYBACK_PLAYER_SELL_SQL}
          AND o.item_price > 0
          AND ${BUYBACK_STACK_SQL} > 0
          AND EXISTS (SELECT 1 FROM seed_buy_caps sc WHERE sc.template_id IS NOT NULL AND sc.template_id = o.template_id)
        GROUP BY o.template_id, ${BUYBACK_ORDER_GRADE_SQL}
    ),
    live_buy_caps AS (
        SELECT template_id,
               quality_level,
               GREATEST(1, FLOOR((basis_price * ${threshold} + 99) / 100))::bigint AS max_unit_price
        FROM live_buy_basis
    )
    SELECT template_id, quality_level, max_unit_price FROM live_buy_caps
    UNION ALL
    SELECT s.template_id, s.quality_level, s.max_unit_price
    FROM seed_buy_caps s
    WHERE s.template_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM live_buy_caps l
        WHERE l.template_id = s.template_id AND l.quality_level = s.quality_level
      )
) plan_rows;`;
}

// Read-only eligibility probe. This runs without a backup, so idle scheduled
// ticks are cheap; the write sweep only runs when this finds at least one
// player listing at or below the threshold.
export function buildBuybackEligibilitySql(plan, schedule) {
  const exchangeId = requireScheduleExchangeId(schedule);
  return `WITH ${buybackMarketPlanCteSql(plan, schedule)},
bot AS (
    SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1
)
SELECT
  COUNT(*)::text AS player_sell_orders,
  COUNT(*) FILTER (WHERE p.template_id IS NOT NULL)::text AS known_player_sell_orders,
  COUNT(*) FILTER (WHERE p.template_id IS NOT NULL AND ${BUYBACK_ELIGIBLE_PREDICATE})::text AS eligible_orders,
  COUNT(*) FILTER (WHERE p.template_id IS NOT NULL AND o.item_price > 0 AND ${BUYBACK_STACK_SQL} > 0 AND o.item_price > p.max_unit_price)::text AS above_threshold_sell_orders,
  COUNT(*) FILTER (WHERE p.template_id IS NULL)::text AS unknown_template_sell_orders,
  COUNT(*) FILTER (WHERE p.template_id IS NOT NULL AND (COALESCE(o.item_price, 0) <= 0 OR ${BUYBACK_STACK_SQL} <= 0))::text AS invalid_price_or_stack_sell_orders
FROM dune.dune_exchange_orders o
JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id
LEFT JOIN dune.items i ON i.id = o.item_id
${BUYBACK_PLAN_LATERAL}
LEFT JOIN bot b ON TRUE
WHERE o.exchange_id = ${exchangeId}
  AND ${BUYBACK_PLAYER_SELL_SQL};`;
}

// Read-only per-listing classification for the Buyback Sweep Log dry-run.
export function buildBuybackClassifySql(plan, schedule) {
  const exchangeId = requireScheduleExchangeId(schedule);
  return `WITH ${buybackMarketPlanCteSql(plan, schedule)},
bot AS (
    SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1
)
SELECT
    o.id::text AS order_id,
    o.template_id,
    (${BUYBACK_ORDER_GRADE_SQL})::text AS quality_level,
    o.item_price::text AS item_price,
    (${BUYBACK_STACK_SQL})::text AS stack_size,
    COALESCE(p.max_unit_price, 0)::text AS max_unit_price,
    (${BUYBACK_RESULT_CODE_SQL})::text AS result_code,
    ${BUYBACK_RESULT_LABEL_SQL} AS result_label,
    ${BUYBACK_RESULT_DETAIL_SQL} AS detail
FROM dune.dune_exchange_orders o
JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id
LEFT JOIN dune.items i ON i.id = o.item_id
${BUYBACK_PLAN_LATERAL}
LEFT JOIN bot b ON TRUE
WHERE o.exchange_id = ${exchangeId}
  AND ${BUYBACK_PLAYER_SELL_SQL}
ORDER BY (${BUYBACK_RESULT_CODE_SQL}) ASC, o.item_price ASC, o.id ASC;`;
}

export function buildBuybackSql(plan, schedule) {
  const exchangeId = requireScheduleExchangeId(schedule);
  const threshold = schedule.buybackPercent;
  const maxBuys = schedule.maxBuys;
  const planInsert = buybackPlanPopulateSql(plan, schedule);
  return `CREATE TEMP TABLE market_buy_plan (template_id TEXT NOT NULL, quality_level BIGINT NOT NULL, max_unit_price BIGINT NOT NULL, PRIMARY KEY (template_id, quality_level)) ON COMMIT DROP;
CREATE TEMP TABLE market_buy_result (purchased INTEGER NOT NULL, total_units BIGINT NOT NULL, total_solari BIGINT NOT NULL, threshold_percent INTEGER NOT NULL, max_buys INTEGER NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE market_buy_diagnostics (player_sell_orders BIGINT NOT NULL, known_player_sell_orders BIGINT NOT NULL, eligible_player_sell_orders BIGINT NOT NULL, above_threshold_sell_orders BIGINT NOT NULL, unknown_template_sell_orders BIGINT NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE market_buy_log (order_id BIGINT NOT NULL, template_id TEXT NOT NULL, quality_level BIGINT NOT NULL, item_price BIGINT NOT NULL, stack_size BIGINT NOT NULL, max_unit_price BIGINT, result_code INTEGER NOT NULL, result_label TEXT NOT NULL, detail TEXT NOT NULL) ON COMMIT DROP;
${planInsert}
DO $$
DECLARE
    v_owner_id BIGINT; v_partition_id BIGINT; v_log_order_id BIGINT; v_balance BIGINT; v_purchased INTEGER := 0; v_units BIGINT := 0; v_solari BIGINT := 0; rec RECORD;
BEGIN
    SELECT id INTO v_owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1;
    IF v_owner_id IS NULL THEN
        SELECT partition_id INTO v_partition_id FROM dune.world_partition ORDER BY partition_id LIMIT 1;
        INSERT INTO dune.actors (class, serial, gas_attributes, properties, dimension_index, partition_id) VALUES ('Revy', 0, '{}', '{}', 0, v_partition_id) RETURNING id INTO v_owner_id;
    END IF;
    -- No dune_exchange_get_user_id call here: its INSERT .. ON CONFLICT would
    -- wait on another sweep's uncommitted balance update, serializing sweeps
    -- that SKIP LOCKED lets run side by side. The top-up below creates the
    -- users row itself when it is missing (balance coalesces to 0 < floor).
    SELECT COALESCE(dune.dune_exchange_retrieve_solari_balance(v_owner_id), 0) INTO v_balance;
    IF v_balance < 1000000000000 THEN
        PERFORM dune.dune_exchange_modify_user_solari_balance(v_owner_id, 9000000000000 - v_balance);
    END IF;
    INSERT INTO market_buy_log (order_id, template_id, quality_level, item_price, stack_size, max_unit_price, result_code, result_label, detail)
    SELECT o.id, o.template_id, ${BUYBACK_ORDER_GRADE_SQL}, o.item_price, ${BUYBACK_STACK_SQL}, p.max_unit_price, ${BUYBACK_RESULT_CODE_SQL}, ${BUYBACK_RESULT_LABEL_SQL}, ${BUYBACK_RESULT_DETAIL_SQL}
    FROM dune.dune_exchange_orders o
    JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id
    LEFT JOIN dune.items i ON i.id = o.item_id
    ${BUYBACK_PLAN_LATERAL}
    WHERE o.exchange_id = ${exchangeId} AND COALESCE(o.is_npc_order, FALSE) = FALSE AND o.owner_id IS DISTINCT FROM v_owner_id;
    INSERT INTO market_buy_diagnostics SELECT COUNT(*), COUNT(*) FILTER (WHERE p.template_id IS NOT NULL), COUNT(*) FILTER (WHERE p.template_id IS NOT NULL AND ${BUYBACK_ELIGIBLE_PREDICATE}), COUNT(*) FILTER (WHERE p.template_id IS NOT NULL AND o.item_price > 0 AND ${BUYBACK_STACK_SQL} > 0 AND o.item_price > p.max_unit_price), COUNT(*) FILTER (WHERE p.template_id IS NULL) FROM dune.dune_exchange_orders o JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id LEFT JOIN dune.items i ON i.id = o.item_id ${BUYBACK_PLAN_LATERAL} WHERE o.exchange_id = ${exchangeId} AND COALESCE(o.is_npc_order, FALSE) = FALSE AND o.owner_id IS DISTINCT FROM v_owner_id;
    -- FOR UPDATE OF o, s SKIP LOCKED is the database-level concurrency guard:
    -- a scheduled sweep racing a manual browser sweep locks the selected order
    -- rows, so concurrent sweeps skip anything already claimed and rows
    -- deleted by a committed sweep drop out of the re-checked result.
    FOR rec IN SELECT o.id AS order_id, o.exchange_id, o.access_point_id, o.owner_id AS seller_actor_id, o.template_id, o.item_price, o.item_id, ${BUYBACK_STACK_SQL} AS actual_stack, p.max_unit_price FROM dune.dune_exchange_orders o JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id LEFT JOIN dune.items i ON i.id = o.item_id ${BUYBACK_PLAN_LATERAL} WHERE o.exchange_id = ${exchangeId} AND COALESCE(o.is_npc_order, FALSE) = FALSE AND o.owner_id IS DISTINCT FROM v_owner_id AND ${BUYBACK_ELIGIBLE_PREDICATE} ORDER BY o.item_price ASC, o.id ASC LIMIT ${maxBuys} FOR UPDATE OF o, s SKIP LOCKED LOOP
        -- Seller "Take Solari" payment entry. item_price stays the per-unit
        -- price (the game multiplies by stack_size itself) and expiration is
        -- the never-expires sentinel so the game server's expire proc cannot
        -- purge an uncollected payment (EDA "items eaten without payment" fix).
        INSERT INTO dune.dune_exchange_orders (exchange_id, access_point_id, owner_id, template_id, expiration_time, durability_cur, durability_max, item_price, category_mask, category_depth, is_npc_order) VALUES (rec.exchange_id, rec.access_point_id, rec.seller_actor_id, rec.template_id, ${PAYMENT_SENTINEL_EXPIRY}, 1.0, 1.0, rec.item_price, 0, 0, FALSE) RETURNING id INTO v_log_order_id;
        INSERT INTO dune.dune_exchange_fulfilled_orders (order_id, source_order_id, completion_type, stack_size, original_order_id) VALUES (v_log_order_id, NULL, 4, rec.actual_stack, rec.order_id);
        UPDATE dune.dune_exchange_users SET solari_balance = solari_balance - (rec.item_price * rec.actual_stack) WHERE owner_id = v_owner_id;
        DELETE FROM dune.dune_exchange_sell_orders WHERE order_id = rec.order_id;
        DELETE FROM dune.dune_exchange_orders WHERE id = rec.order_id;
        IF rec.item_id IS NOT NULL THEN DELETE FROM dune.items WHERE id = rec.item_id; END IF;
        UPDATE market_buy_log SET result_code = 0, result_label = 'success', detail = 'bought stack ' || rec.actual_stack::text || ' at ' || rec.item_price::text || '/unit (cap ' || rec.max_unit_price::text || ')' WHERE order_id = rec.order_id;
        v_purchased := v_purchased + 1; v_units := v_units + rec.actual_stack; v_solari := v_solari + (rec.item_price * rec.actual_stack);
    END LOOP;
    -- Remaining eligible rows: rank by the same price/id order the FOR loop
    -- uses. Ranks past Max Buys were never selected (0x5). Ranks within the
    -- limit that we did not buy were SKIP LOCKED or taken concurrently (0x6).
    UPDATE market_buy_log l
    SET result_code = CASE WHEN r.rn > ${maxBuys} THEN 5 ELSE 6 END,
        result_label = CASE WHEN r.rn > ${maxBuys} THEN 'max buys limit' ELSE 'skipped locked' END,
        detail = CASE
            WHEN r.rn > ${maxBuys} THEN 'eligible but past Max Buys Per Sweep (' || ${maxBuys}::text || ')'
            ELSE 'eligible but locked by a concurrent sweep'
        END
    FROM (
        SELECT order_id, ROW_NUMBER() OVER (ORDER BY item_price ASC, order_id ASC) AS rn
        FROM market_buy_log
        WHERE result_label IN ('eligible', 'success')
    ) r
    WHERE l.order_id = r.order_id AND l.result_label = 'eligible';
    INSERT INTO market_buy_result (purchased, total_units, total_solari, threshold_percent, max_buys) VALUES (v_purchased, v_units, v_solari, ${threshold}, ${maxBuys});
END $$;
SELECT r.purchased, r.total_units, r.total_solari, r.threshold_percent, r.max_buys, d.player_sell_orders, d.known_player_sell_orders, d.eligible_player_sell_orders, d.above_threshold_sell_orders, d.unknown_template_sell_orders, (SELECT COALESCE(json_agg(to_jsonb(l) ORDER BY l.result_code ASC, l.item_price ASC, l.order_id ASC), '[]'::json) FROM market_buy_log l)::text AS buyback_log FROM market_buy_result r CROSS JOIN market_buy_diagnostics d;`;
}

export async function probeBuybackEligibility(config, db, overrides = {}) {
  const saved = readBuybackSchedule(config);
  const schedule = normalizeBuybackSchedule({
    exchangeId: overrides.exchangeId,
    priceMultiplier: overrides.priceMultiplier,
    augmentMultiplier: overrides.augmentMultiplier,
    rankedArmorMultiplier: overrides.rankedArmorMultiplier,
    rankedWeaponMultiplier: overrides.rankedWeaponMultiplier,
    buybackPercent: overrides.buybackPercent,
    buybackPriceBasis: overrides.buybackPriceBasis,
    maxBuys: overrides.maxBuys
  }, saved);
  if (!schedule.exchangeId) throw new Error("An exchangeId is required to probe buyback eligibility.");
  const plan = loadBuybackSeedPlan(config);
  const result = await runSql(db, buildBuybackEligibilitySql(plan, schedule), false);
  const diagnostics = buybackDiagnostics(result?.rows?.[0]);
  return {
    ...diagnostics,
    exchangeId: schedule.exchangeId,
    priceMultiplier: schedule.priceMultiplier,
    augmentMultiplier: schedule.augmentMultiplier,
    rankedArmorMultiplier: schedule.rankedArmorMultiplier,
    rankedWeaponMultiplier: schedule.rankedWeaponMultiplier,
    buybackPercent: schedule.buybackPercent,
    buybackPriceBasis: schedule.buybackPriceBasis,
    maxBuys: schedule.maxBuys
  };
}

function buybackScheduleOverrides(overrides = {}) {
  return {
    exchangeId: overrides.exchangeId,
    priceMultiplier: overrides.priceMultiplier,
    augmentMultiplier: overrides.augmentMultiplier,
    rankedArmorMultiplier: overrides.rankedArmorMultiplier,
    rankedWeaponMultiplier: overrides.rankedWeaponMultiplier,
    buybackPercent: overrides.buybackPercent,
    buybackPriceBasis: overrides.buybackPriceBasis,
    maxBuys: overrides.maxBuys
  };
}

export async function classifyBuybackListings(config, db, overrides = {}) {
  const saved = readBuybackSchedule(config);
  const schedule = normalizeBuybackSchedule(buybackScheduleOverrides(overrides), saved);
  if (!schedule.exchangeId) throw new Error("An exchangeId is required to classify buyback listings.");
  const plan = loadBuybackSeedPlan(config);
  const result = await runSql(db, buildBuybackClassifySql(plan, schedule), false);
  const names = seedPlanDisplayNames(plan);
  const entries = applyDryRunMaxBuysRanking(
    (result?.rows || []).map((row) => normalizeBuybackLogEntry(row, names)),
    schedule.maxBuys
  );
  return {
    entries,
    schedule,
    exchangeId: schedule.exchangeId,
    priceMultiplier: schedule.priceMultiplier,
    augmentMultiplier: schedule.augmentMultiplier,
    rankedArmorMultiplier: schedule.rankedArmorMultiplier,
    rankedWeaponMultiplier: schedule.rankedWeaponMultiplier,
    buybackPercent: schedule.buybackPercent,
    buybackPriceBasis: schedule.buybackPriceBasis,
    maxBuys: schedule.maxBuys
  };
}

export async function refreshBuybackLog(config, db, overrides = {}) {
  const classified = await classifyBuybackListings(config, db, overrides);
  appendBuybackLogBatch(config, classified.entries, {
    source: "Dry-run classify",
    exchangeId: classified.exchangeId,
    note: "read-only; nothing purchased",
    schedule: classified.schedule
  });
  return { ...classified, ...readBuybackLog(config) };
}

function buybackDiagnostics(row = {}) {
  return {
    playerListings: diagnosticCount(row.player_sell_orders),
    knownListings: diagnosticCount(row.known_player_sell_orders),
    eligible: diagnosticCount(row.eligible_orders),
    aboveThreshold: diagnosticCount(row.above_threshold_sell_orders),
    unknownTemplate: diagnosticCount(row.unknown_template_sell_orders),
    invalidPriceOrStack: diagnosticCount(row.invalid_price_or_stack_sell_orders)
  };
}

function diagnosticCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

export function createAddonJobScheduler(config, options = {}) {
  const {
    getDb = () => null,
    runDuneImpl = runDune,
    now = () => Date.now(),
    assertPermission = assertInstalledAddonPermission,
    auditImpl = audit,
    mutationLimiter = null,
    failureBackoffMs = 60000,
    log = console
  } = options;

  // Shared lock across buyback and seed so the two jobs never write together.
  let running = false;
  let nextAllowedAttemptAt = 0;
  let buybackArmedForThisProcess = false;
  let seedArmedForThisProcess = false;

  function persistBuybackRunCompletion(completedAtMs, status, detail) {
    const current = readBuybackSchedule(config);
    writeBuybackSchedule(config, {
      ...current,
      lastRunAt: new Date(completedAtMs).toISOString(),
      lastRunStatus: status,
      lastRunDetail: String(detail || "").slice(0, MAX_RUN_DETAIL_LENGTH),
      nextRunAt: current.enabled ? new Date(completedAtMs + current.intervalMinutes * 60000).toISOString() : ""
    });
  }

  function auditJob(job, trigger, detail) {
    try {
      auditImpl(config, null, "addons.scheduled-job", { id: EDA_EXCHANGE_BOT_ADDON_ID, job, trigger, ...detail });
    } catch (error) {
      log.error(`Addon scheduled job audit failed: ${redact(error?.message || "Unexpected error.")}`);
    }
  }

  function consumeMutationSlot(startedAt) {
    if (!mutationLimiter) return true;
    const limit = mutationLimiter.check(ADDON_SCHEDULED_RUN_RATE_SCOPE);
    if (!limit.allowed) {
      nextAllowedAttemptAt = startedAt + failureBackoffMs;
      return false;
    }
    mutationLimiter.record(ADDON_SCHEDULED_RUN_RATE_SCOPE);
    return true;
  }

  // Returns: "ran" | "deferred" | "idle"
  function prepareDueSchedule(schedule, armedRef, writeFn, startedAt) {
    if (!schedule.enabled) {
      armedRef.value = false;
      return "idle";
    }
    const dueAtMs = Date.parse(schedule.nextRunAt || "") || 0;
    if (!armedRef.value) {
      armedRef.value = true;
      if (!dueAtMs || dueAtMs <= startedAt) {
        // Restart recovery: recompute nextRunAt one interval out instead of
        // firing a write immediately at boot.
        writeFn(config, { ...schedule, nextRunAt: new Date(startedAt + schedule.intervalMinutes * 60000).toISOString() });
        return "deferred";
      }
    }
    if (!dueAtMs) {
      writeFn(config, { ...schedule, nextRunAt: new Date(startedAt + schedule.intervalMinutes * 60000).toISOString() });
      return "deferred";
    }
    if (startedAt < dueAtMs) return "idle";
    return "due";
  }

  async function tick() {
    if (running) return;
    const startedAt = now();
    if (startedAt < nextAllowedAttemptAt) return;

    const seedArmed = { value: seedArmedForThisProcess };
    const seedState = prepareDueSchedule(readSeedSchedule(config), seedArmed, writeSeedSchedule, startedAt);
    seedArmedForThisProcess = seedArmed.value;
    if (seedState === "due") {
      if (!consumeMutationSlot(startedAt)) return;
      await runSeedJob("schedule", readSeedSchedule(config));
      return;
    }

    const buybackArmed = { value: buybackArmedForThisProcess };
    const buybackState = prepareDueSchedule(readBuybackSchedule(config), buybackArmed, writeBuybackSchedule, startedAt);
    buybackArmedForThisProcess = buybackArmed.value;
    if (buybackState === "due") {
      if (!consumeMutationSlot(startedAt)) return;
      await runBuybackJob("schedule", readBuybackSchedule(config));
    }
  }

  // Addon-sourced schedules re-verify the addon's approved permissions on
  // every scheduled run (the owner can revoke them at any time). A schedule
  // saved from the console's own Market Bot UI ("console" source) was
  // authorized by RBAC at save time and does not require the addon to be
  // installed at all, so the addon permission re-check is skipped.
  function assertScheduleRunAllowed(schedule) {
    if (schedule?.source === "console") return;
    assertPermission(config, EDA_EXCHANGE_BOT_ADDON_ID, "database:read");
    assertPermission(config, EDA_EXCHANGE_BOT_ADDON_ID, "database:write");
    assertPermission(config, EDA_EXCHANGE_BOT_ADDON_ID, ADDON_SCHEDULER_PERMISSION);
  }

  async function runBuybackJob(trigger, schedule) {
    running = true;
    try {
      assertScheduleRunAllowed(schedule);
      const outcome = await executeBuybackRun(config, getDb(), schedule, { runDuneImpl, trigger });
      const completedAt = now();
      persistBuybackRunCompletion(completedAt, outcome.status, outcome.detail);
      nextAllowedAttemptAt = 0;
      auditJob("buyback", trigger, {
        status: outcome.status,
        eligible: outcome.eligible,
        purchased: outcome.purchased,
        totalUnits: outcome.totalUnits,
        totalSolari: outcome.totalSolari,
        exchangeId: schedule.exchangeId,
        ok: true
      });
    } catch (error) {
      const completedAt = now();
      const message = redact(String(error?.message || "Unexpected error."));
      nextAllowedAttemptAt = completedAt + failureBackoffMs;
      try { persistBuybackRunCompletion(completedAt, "error", message); } catch { /* best effort */ }
      auditJob("buyback", trigger, { status: "error", exchangeId: schedule.exchangeId, ok: false, error: message });
      if (trigger === "schedule") log.error(`Addon scheduled buyback run failed: ${message}`);
      else throw error;
    } finally {
      running = false;
    }
  }

  async function runSeedJob(trigger, schedule) {
    running = true;
    try {
      assertScheduleRunAllowed(schedule);
      const outcome = await executeSeedRun(config, getDb(), schedule, { runDuneImpl, buildDuneArgs, runSql });
      const completedAt = now();
      persistSeedRunCompletion(config, completedAt, outcome.status, outcome.detail);
      nextAllowedAttemptAt = 0;
      auditJob("seed", trigger, {
        status: outcome.status,
        listingCount: outcome.listingCount,
        exchangeId: schedule.exchangeId,
        ok: true
      });
    } catch (error) {
      const completedAt = now();
      const message = redact(String(error?.message || "Unexpected error."));
      nextAllowedAttemptAt = completedAt + failureBackoffMs;
      try { persistSeedRunCompletion(config, completedAt, "error", message); } catch { /* best effort */ }
      auditJob("seed", trigger, { status: "error", exchangeId: schedule.exchangeId, ok: false, error: message });
      log.error(`Addon scheduled seed run failed: ${message}`);
    } finally {
      running = false;
    }
  }

  async function runNow({ trigger = "manual", job = "buyback" } = {}) {
    if (running) throw new Error("An exchange scheduled job is already in progress.");
    if (job === "seed") {
      const schedule = readSeedSchedule(config);
      if (!schedule.exchangeId) throw new Error("Save a seed schedule with an exchangeId before running a manual reseed.");
      // Manual runs are gated by database:write on the bridge; scheduler:server
      // is only required to leave the unattended schedule enabled.
      running = true;
      try {
        const outcome = await executeSeedRun(config, getDb(), schedule, { runDuneImpl, buildDuneArgs, runSql });
        persistSeedRunCompletion(config, now(), outcome.status, outcome.detail);
        auditJob("seed", trigger, {
          status: outcome.status,
          listingCount: outcome.listingCount,
          exchangeId: schedule.exchangeId,
          ok: true
        });
        return { ...outcome, schedule: readSeedSchedule(config) };
      } catch (error) {
        const message = redact(String(error?.message || "Unexpected error."));
        try { persistSeedRunCompletion(config, now(), "error", message); } catch { /* best effort */ }
        auditJob("seed", trigger, { status: "error", exchangeId: schedule.exchangeId, ok: false, error: message });
        throw error;
      } finally {
        running = false;
      }
    }
    const schedule = readBuybackSchedule(config);
    if (!schedule.exchangeId) throw new Error("Save a schedule with an exchangeId before running a manual buyback sweep.");
    // runBuybackJob swallows schedule errors into log; for manual, rethrow via dedicated path.
    running = true;
    try {
      const outcome = await executeBuybackRun(config, getDb(), schedule, { runDuneImpl, trigger });
      persistBuybackRunCompletion(now(), outcome.status, outcome.detail);
      auditJob("buyback", trigger, {
        status: outcome.status,
        eligible: outcome.eligible,
        purchased: outcome.purchased,
        totalUnits: outcome.totalUnits,
        totalSolari: outcome.totalSolari,
        exchangeId: schedule.exchangeId,
        ok: true
      });
      return { ...outcome, schedule: readBuybackSchedule(config) };
    } catch (error) {
      const message = redact(String(error?.message || "Unexpected error."));
      try { persistBuybackRunCompletion(now(), "error", message); } catch { /* best effort */ }
      auditJob("buyback", trigger, { status: "error", exchangeId: schedule.exchangeId, ok: false, error: message });
      throw error;
    } finally {
      running = false;
    }
  }

  return { tick, runNow, isRunning: () => running };
}

async function executeBuybackRun(config, db, schedule, { runDuneImpl, trigger = "manual" } = {}) {
  const plan = loadBuybackSeedPlan(config);
  const names = seedPlanDisplayNames(plan);
  const source = trigger === "schedule" ? "Scheduled buyback" : "Buyback sweep";
  const probe = await runSql(db, buildBuybackEligibilitySql(plan, schedule), false);
  const eligible = eligibleCount(probe);
  if (eligible <= 0) {
    await persistIdleBuybackLog(config, db, plan, schedule, names, source);
    return {
      status: "idle",
      eligible: 0,
      purchased: 0,
      totalUnits: "0",
      totalSolari: "0",
      detail: `No eligible player listings at ${schedule.buybackPercent}% threshold on exchange ${schedule.exchangeId}; sweep and backup skipped.`
    };
  }
  if (typeof db?.transaction !== "function") {
    throw new Error("Exchange buyback requires database transaction support.");
  }
  if (!config.mockMode) {
    await runDuneImpl(config, buildDuneArgs("backupCreate"), { env: { DB_BACKUP_ORIGIN: "market-bot-buyback" } });
  }
  // Keep the entire sweep on one checked-out client. createDb.transaction()
  // guarantees ROLLBACK before releasing that client if any statement fails,
  // preventing an aborted transaction from being returned to the pool.
  const sweep = await db.transaction((tx) => runSql(tx, buildBuybackSql(plan, schedule), true));
  const row = sweep?.rows?.[0] || {};
  // purchased is a plain INTEGER bounded by maxBuys; the unit/solari totals
  // are BIGINT sums, so they stay decimal strings end-to-end like exchange
  // ids do (never converted with Number()).
  const purchased = Number(row.purchased || 0);
  const totalUnits = decimalString(row.total_units);
  const totalSolari = decimalString(row.total_solari);
  persistSweepBuybackLog(config, row, schedule, names, source);
  return {
    status: "swept",
    eligible,
    purchased,
    totalUnits,
    totalSolari,
    detail: `Bought ${purchased} listings (${totalUnits} units) for ${totalSolari} solari on exchange ${schedule.exchangeId} (${eligible} eligible).`
  };
}

async function persistIdleBuybackLog(config, db, plan, schedule, names, source) {
  try {
    const result = await runSql(db, buildBuybackClassifySql(plan, schedule), false);
    const entries = applyDryRunMaxBuysRanking(
      (result?.rows || []).map((row) => normalizeBuybackLogEntry(row, names)),
      schedule.maxBuys
    );
    appendBuybackLogBatch(config, entries, {
      source,
      exchangeId: schedule.exchangeId,
      note: "read-only; nothing purchased",
      schedule
    });
  } catch {
    // Classification is best-effort; an idle tick must still complete.
  }
}

function persistSweepBuybackLog(config, row, schedule, names, source) {
  try {
    const logRows = extractBuybackLogRows(row);
    if (!logRows) return;
    appendBuybackLogBatch(config, logRows.map((entry) => normalizeBuybackLogEntry(entry, names)), {
      source,
      exchangeId: schedule.exchangeId,
      schedule
    });
  } catch {
    // Logging must never fail a completed sweep.
  }
}

function decimalString(value) {
  const text = String(value ?? "0").trim();
  return /^-?[0-9]+$/.test(text) ? text : "0";
}

function eligibleCount(result) {
  const eligible = Number(result?.rows?.[0]?.eligible_orders || 0);
  return Number.isFinite(eligible) && eligible > 0 ? eligible : 0;
}

function requireScheduleExchangeId(schedule) {
  const exchangeId = normalizeExchangeId(schedule?.exchangeId);
  if (!exchangeId) throw new Error("Buyback schedule exchangeId is invalid.");
  return exchangeId;
}

export function buybackSchedulePath(config) {
  return resolve(config.repoRoot, "runtime/generated/market-bot", "buyback.json");
}

export function legacyBuybackSchedulePath(config) {
  return resolve(config.repoRoot, "runtime/addons/jobs", EDA_EXCHANGE_BOT_ADDON_ID, "buyback.json");
}

function writeBuybackSchedule(config, schedule) {
  const path = buybackSchedulePath(config);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(schedule, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

export function buybackLogPath(config) {
  return resolve(config.repoRoot, "runtime/generated/market-bot", "buyback-log.json");
}

function seedPlanDisplayNames(plan) {
  const names = new Map();
  for (const row of plan.rows || []) {
    const name = String(row.displayName || "").trim();
    if (row.templateId && name && !names.has(row.templateId)) names.set(row.templateId, name);
  }
  return names;
}

function buybackCodeHex(code) {
  const number = Number(code);
  if (!Number.isInteger(number) || number < 0) return "0x?";
  return `0x${number.toString(16)}`;
}

function decimalId(value) {
  const text = String(value ?? "").trim();
  return /^[0-9]+$/.test(text) ? text : "";
}

export function normalizeBuybackLogEntry(row = {}, names = new Map()) {
  const code = Number(row.resultCode ?? row.result_code);
  const meta = BUYBACK_RESULT_CODES[code] || { label: "unknown", summary: "" };
  const templateId = String(row.templateId ?? row.template_id ?? "");
  const displayName = String(row.displayName ?? row.display_name ?? names.get(templateId) ?? "");
  const maxUnitPrice = row.maxUnitPrice ?? row.max_unit_price;
  return {
    orderId: decimalId(row.orderId ?? row.order_id),
    templateId,
    displayName,
    qualityLevel: String(row.qualityLevel ?? row.quality_level ?? ""),
    itemPrice: String(row.itemPrice ?? row.item_price ?? ""),
    stackSize: String(row.stackSize ?? row.stack_size ?? ""),
    maxUnitPrice: maxUnitPrice == null || maxUnitPrice === "" ? "" : String(maxUnitPrice),
    resultCode: Number.isInteger(code) ? code : -1,
    resultHex: buybackCodeHex(Number.isInteger(code) ? code : -1),
    resultLabel: String(row.resultLabel ?? row.result_label ?? meta.label ?? "unknown"),
    detail: String(row.detail || meta.summary || "")
  };
}

function compareLogOrder(left, right) {
  const priceDelta = Number(left.itemPrice) - Number(right.itemPrice);
  if (Number.isFinite(priceDelta) && priceDelta !== 0) return priceDelta;
  try {
    const a = BigInt(left.orderId || "0");
    const b = BigInt(right.orderId || "0");
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  } catch {
    return String(left.orderId).localeCompare(String(right.orderId));
  }
}

export function applyDryRunMaxBuysRanking(entries, maxBuys) {
  const max = Math.max(1, Number(maxBuys) || 1);
  const eligible = entries
    .filter((entry) => entry.resultCode === 0 && entry.resultLabel === "eligible")
    .slice()
    .sort(compareLogOrder);
  const rank = new Map(eligible.map((entry, index) => [entry.orderId, index + 1]));
  return entries.map((entry) => {
    if (entry.resultCode !== 0 || entry.resultLabel !== "eligible") return entry;
    if ((rank.get(entry.orderId) || Number.POSITIVE_INFINITY) <= max) return entry;
    return normalizeBuybackLogEntry({
      ...entry,
      resultCode: 5,
      resultLabel: "max buys limit",
      detail: `eligible but past Max Buys Per Sweep (${max})`
    });
  });
}

function summarizeBuybackLogBatch(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const key = entry.resultHex || buybackCodeHex(entry.resultCode);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([hex, count]) => `${hex}×${count}`).join(", ");
}

export function readBuybackLog(config) {
  const path = buybackLogPath(config);
  if (!existsSync(path)) return { batches: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const batches = Array.isArray(parsed?.batches) ? parsed.batches : Array.isArray(parsed) ? parsed : [];
    return { batches: batches.filter((batch) => batch && typeof batch === "object").slice(0, MAX_BUYBACK_LOG_BATCHES) };
  } catch {
    return { batches: [] };
  }
}

export function clearBuybackLog(config) {
  writeJsonAtomic(buybackLogPath(config), { batches: [] });
  return { batches: [] };
}

export function appendBuybackLogBatch(config, entries, { source, exchangeId, note = "", schedule = {} } = {}) {
  const names = new Map();
  const normalized = (entries || []).map((row) => normalizeBuybackLogEntry(row, names)).filter((row) => row.orderId || row.templateId);
  const stored = normalized.slice(0, MAX_BUYBACK_LOG_ENTRIES);
  const truncatedFrom = normalized.length > stored.length ? normalized.length : 0;
  const extraNote = truncatedFrom ? `showing ${stored.length} of ${truncatedFrom} listings` : "";
  const batch = {
    source: String(source || "Buyback"),
    exchangeId: String(exchangeId || ""),
    at: new Date().toISOString(),
    note: [note, extraNote].filter(Boolean).join(" — "),
    summary: `${normalized.length} listing(s); ${summarizeBuybackLogBatch(normalized) || "none"}`,
    buybackPercent: schedule.buybackPercent ?? null,
    buybackPriceBasis: schedule.buybackPriceBasis || "",
    maxBuys: schedule.maxBuys ?? null,
    ...(truncatedFrom ? { truncatedFrom } : {}),
    entries: stored
  };
  const current = readBuybackLog(config);
  writeJsonAtomic(buybackLogPath(config), { batches: [batch, ...current.batches].slice(0, MAX_BUYBACK_LOG_BATCHES) });
  return batch;
}

function extractBuybackLogRows(row = {}) {
  const raw = row.buyback_log ?? row.buybackLog;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.log)) return raw.log;
    if (Array.isArray(raw.entries)) return raw.entries;
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.log)) return parsed.log;
      if (Array.isArray(parsed?.entries)) return parsed.entries;
    } catch {
      return null;
    }
  }
  return null;
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
    throw new Error(`Buyback schedule ${name} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function clampedIntegerField(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`Buyback schedule ${name} must be an integer.`);
  return Math.min(max, Math.max(min, number));
}

function isoField(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return Number.isFinite(Date.parse(text)) ? new Date(Date.parse(text)).toISOString() : "";
}
