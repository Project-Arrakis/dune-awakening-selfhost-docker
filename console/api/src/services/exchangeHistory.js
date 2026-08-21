import { adminItemMetadata } from "../duneDb.js";
import { itemImagePath } from "../adminCatalog.js";
import { intParam } from "../db.js";

const HISTORY_SCHEMA = "console_market_history";
const HISTORY_TABLE = "transactions";
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const TIME_RANGES = new Set([0, 24, 168, 720, 2160]);
const PARTY_TYPES = new Set(["all", "player", "bot", "npc"]);
const migrationState = new WeakMap();

function retentionDays(env = process.env) {
  const raw = String(env.ADMIN_MARKET_HISTORY_RETENTION_DAYS || "0").trim();
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isInteger(value) && (value === 0 || (value >= 7 && value <= 3650)) ? value : 0;
}

async function exchangeHistoryTablesSupported(db) {
  const result = await db.query(`
    select to_regclass('dune.dune_exchange_orders') is not null as orders,
           to_regclass('dune.dune_exchange_fulfilled_orders') is not null as fulfilled`);
  const row = result.rows?.[0] || {};
  return Boolean(row.orders && row.fulfilled);
}

async function migrateExchangeHistory(db, env) {
  if (!(await exchangeHistoryTablesSupported(db))) {
    return {
      supported: false,
      reason: "Unsupported by detected schema. Missing dune.dune_exchange_orders or dune.dune_exchange_fulfilled_orders."
    };
  }

  await db.query(`
    create schema if not exists ${HISTORY_SCHEMA};

    create table if not exists ${HISTORY_SCHEMA}.${HISTORY_TABLE} (
      id bigint generated always as identity primary key,
      captured_at timestamp with time zone not null default clock_timestamp(),
      event_kind text not null,
      order_id bigint not null,
      source_order_id bigint,
      original_order_id bigint,
      completion_type integer not null,
      stack_size bigint not null,
      cumulative_stack_size bigint not null,
      template_id text,
      unit_price bigint,
      quality_level bigint,
      durability_cur real,
      durability_max real,
      owner_id bigint,
      owner_is_npc boolean,
      source_owner_id bigint,
      source_owner_is_npc boolean,
      original_owner_id bigint,
      original_owner_is_npc boolean,
      exchange_id bigint,
      constraint transactions_event_kind_check check (event_kind in ('insert', 'update')),
      constraint transactions_stack_size_check check (stack_size > 0),
      constraint transactions_cumulative_stack_size_check check (cumulative_stack_size > 0)
    );

    create index if not exists transactions_captured_at_idx
      on ${HISTORY_SCHEMA}.${HISTORY_TABLE} (captured_at desc, id desc);
    create index if not exists transactions_exchange_captured_idx
      on ${HISTORY_SCHEMA}.${HISTORY_TABLE} (exchange_id, captured_at desc);
    create index if not exists transactions_template_captured_idx
      on ${HISTORY_SCHEMA}.${HISTORY_TABLE} (template_id, captured_at desc);
    create index if not exists transactions_owner_captured_idx
      on ${HISTORY_SCHEMA}.${HISTORY_TABLE} (owner_id, captured_at desc);

    create or replace function ${HISTORY_SCHEMA}.capture_fulfilled_order()
    returns trigger
    language plpgsql
    security definer
    set search_path = pg_catalog
    as $function$
    declare
      event_stack_size bigint;
    begin
      if tg_op = 'UPDATE' then
        event_stack_size := new.stack_size - old.stack_size;
        if event_stack_size <= 0 then
          return new;
        end if;
      else
        event_stack_size := new.stack_size;
      end if;

      insert into ${HISTORY_SCHEMA}.${HISTORY_TABLE} (
        event_kind, order_id, source_order_id, original_order_id,
        completion_type, stack_size, cumulative_stack_size,
        template_id, unit_price, quality_level, durability_cur, durability_max,
        owner_id, owner_is_npc, source_owner_id, source_owner_is_npc,
        original_owner_id, original_owner_is_npc, exchange_id
      )
      select lower(tg_op), new.order_id, new.source_order_id, new.original_order_id,
             new.completion_type, event_stack_size, new.stack_size,
             primary_order.template_id, primary_order.item_price, primary_order.quality_level,
             primary_order.durability_cur, primary_order.durability_max,
             primary_order.owner_id, primary_order.is_npc_order,
             source_order.owner_id, source_order.is_npc_order,
             original_order.owner_id, original_order.is_npc_order,
             primary_order.exchange_id
      from dune.dune_exchange_orders primary_order
      left join dune.dune_exchange_orders source_order on source_order.id = new.source_order_id
      left join dune.dune_exchange_orders original_order on original_order.id = new.original_order_id
      where primary_order.id = new.order_id;

      return new;
    exception when others then
      -- History is observability, never part of the game transaction. A schema
      -- drift or recorder problem must not reject a player's market action.
      raise warning 'Market history capture skipped (SQLSTATE %)', sqlstate;
      return new;
    end;
    $function$;

    revoke all on function ${HISTORY_SCHEMA}.capture_fulfilled_order() from public;

    do $block$
    begin
      if not exists (
        select 1
        from pg_catalog.pg_trigger
        where tgrelid = 'dune.dune_exchange_fulfilled_orders'::regclass
          and tgname = 'console_market_history_capture'
          and not tgisinternal
      ) then
        create trigger console_market_history_capture
        after insert or update of stack_size on dune.dune_exchange_fulfilled_orders
        for each row execute function ${HISTORY_SCHEMA}.capture_fulfilled_order();
      end if;
    end;
    $block$`);

  const keepDays = retentionDays(env);
  if (keepDays > 0) {
    await db.query(`
      delete from ${HISTORY_SCHEMA}.${HISTORY_TABLE}
      where captured_at < current_timestamp - make_interval(days => $1)`, [keepDays]);
  }

  return { supported: true, retentionDays: keepDays };
}

export async function ensureExchangeHistory(db, { force = false, env = process.env } = {}) {
  const previous = migrationState.get(db);
  if (previous?.promise) return previous.promise;
  if (!force && previous?.result && Date.now() - previous.checkedAt < RECONCILE_INTERVAL_MS) return previous.result;

  const promise = migrateExchangeHistory(db, env);
  migrationState.set(db, { promise, checkedAt: Date.now(), result: previous?.result });
  try {
    const result = await promise;
    migrationState.set(db, { promise: null, checkedAt: Date.now(), result });
    return result;
  } catch (error) {
    migrationState.delete(db);
    throw error;
  }
}

function partySql(alias, botParam) {
  return `case
    when coalesce(${alias}.owner_is_npc, false) then 'npc'
    when ${alias}.owner_id = any(${botParam}::bigint[]) then 'bot'
    else 'player'
  end`;
}

function bigintText(value) {
  return value === null || value === undefined ? "0" : String(value);
}

export async function listExchangeTransactions(db, {
  q = "",
  page = 0,
  pageSize = 50,
  hours = 168,
  party = "all",
  exchangeId = "",
  botOwnerIds = [],
  blacklist = [],
  repoRoot = ""
} = {}) {
  const capability = await ensureExchangeHistory(db);
  if (!capability.supported) {
    return {
      capabilities: { exchangeHistory: false },
      reason: capability.reason,
      rows: [], totalCount: 0,
      summary: { events: 0, units: "0", solari: "0", firstCapturedAt: null },
      retentionDays: capability.retentionDays || 0
    };
  }

  const safePage = intParam(page, "page", 0);
  const safePageSize = intParam(pageSize, "pageSize", 1, 200);
  const requestedHours = intParam(hours, "hours", 0, 2160);
  const safeHours = TIME_RANGES.has(requestedHours) ? requestedHours : 168;
  const safeParty = PARTY_TYPES.has(String(party)) ? String(party) : "all";
  const safeExchangeId = String(exchangeId || "").trim();
  if (safeExchangeId && !/^\d{1,19}$/.test(safeExchangeId)) {
    throw Object.assign(new Error("Invalid exchange id."), { statusCode: 400 });
  }
  const term = String(q || "").trim().slice(0, 120);
  const metadata = adminItemMetadata();
  const catalogMatches = term
    ? [...metadata.entries()]
      .filter(([templateId, item]) => `${templateId} ${item?.name || ""} ${item?.category || ""}`.toLowerCase().includes(term.toLowerCase()))
      .map(([templateId]) => templateId)
      .slice(0, 2000)
    : [];

  const params = [botOwnerIds.map(String), blacklist.map(String)];
  const botParam = "$1";
  const blockedParam = "$2";
  const where = [
    `(h.owner_id is null or h.owner_id <> all(${blockedParam}::bigint[]))`,
    `(h.source_owner_id is null or h.source_owner_id <> all(${blockedParam}::bigint[]))`,
    `(h.original_owner_id is null or h.original_owner_id <> all(${blockedParam}::bigint[]))`
  ];
  if (safeHours > 0) {
    params.push(safeHours);
    where.push(`h.captured_at >= current_timestamp - make_interval(hours => $${params.length})`);
  }
  if (safeParty !== "all") {
    params.push(safeParty);
    where.push(`${partySql("h", botParam)} = $${params.length}`);
  }
  if (safeExchangeId) {
    params.push(safeExchangeId);
    where.push(`h.exchange_id = $${params.length}::bigint`);
  }
  if (term) {
    params.push(`%${term}%`);
    const likeParam = `$${params.length}`;
    params.push(catalogMatches);
    const catalogParam = `$${params.length}`;
    where.push(`(h.template_id ilike ${likeParam} or coalesce(ps.character_name, a.class, '') ilike ${likeParam} or h.template_id = any(${catalogParam}::text[]))`);
  }
  const from = `
    from ${HISTORY_SCHEMA}.${HISTORY_TABLE} h
    left join dune.actors a on a.id = h.owner_id
    left join dune.player_state ps on ps.account_id = a.owner_account_id`;
  const whereSql = `where ${where.join(" and ")}`;

  const summaryResult = await db.query(`
    select count(*)::int as events,
           coalesce(sum(h.stack_size), 0)::text as units,
           coalesce(sum(h.stack_size::numeric * coalesce(h.unit_price, 0)::numeric), 0)::text as solari,
           count(*) filter (where ${partySql("h", botParam)} = 'player')::int as player_events,
           count(*) filter (where ${partySql("h", botParam)} = 'bot')::int as bot_events,
           count(*) filter (where ${partySql("h", botParam)} = 'npc')::int as npc_events,
           min(h.captured_at) as first_captured_at
    ${from}
    ${whereSql}`, params);

  const rowParams = [...params, safePageSize, safePage * safePageSize];
  const rowsResult = await db.query(`
    select h.id::text, h.captured_at, h.event_kind,
           h.order_id::text, h.source_order_id::text, h.original_order_id::text,
           h.completion_type, h.stack_size::text, h.cumulative_stack_size::text,
           h.template_id, h.unit_price::text, h.quality_level::text,
           h.durability_cur, h.durability_max, h.owner_id::text,
           coalesce(ps.character_name, a.class, '') as owner_name,
           ${partySql("h", botParam)} as party_type,
           h.exchange_id::text
    ${from}
    ${whereSql}
    order by h.captured_at desc, h.id desc
    limit $${rowParams.length - 1} offset $${rowParams.length}`, rowParams);

  const rows = rowsResult.rows.map((row) => {
    const templateId = String(row.template_id || "");
    const item = metadata.get(templateId);
    return {
      id: String(row.id),
      capturedAt: row.captured_at,
      eventKind: String(row.event_kind),
      orderId: String(row.order_id),
      sourceOrderId: row.source_order_id === null ? null : String(row.source_order_id),
      originalOrderId: row.original_order_id === null ? null : String(row.original_order_id),
      completionType: Number(row.completion_type),
      units: bigintText(row.stack_size),
      cumulativeUnits: bigintText(row.cumulative_stack_size),
      templateId,
      displayName: item?.name || templateId || "Unknown Item",
      category: item?.category || "",
      icon: templateId ? itemImagePath(repoRoot, templateId) : null,
      unitPrice: bigintText(row.unit_price),
      qualityLevel: Number(row.quality_level || 0),
      durabilityCurrent: row.durability_cur === null ? null : Number(row.durability_cur),
      durabilityMaximum: row.durability_max === null ? null : Number(row.durability_max),
      ownerId: row.owner_id === null ? null : String(row.owner_id),
      ownerName: String(row.owner_name || ""),
      partyType: String(row.party_type),
      exchangeId: row.exchange_id === null ? null : String(row.exchange_id)
    };
  });
  const summary = summaryResult.rows?.[0] || {};
  return {
    capabilities: { exchangeHistory: true },
    rows,
    totalCount: Number(summary.events || 0),
    summary: {
      events: Number(summary.events || 0),
      units: bigintText(summary.units),
      solari: bigintText(summary.solari),
      playerEvents: Number(summary.player_events || 0),
      botEvents: Number(summary.bot_events || 0),
      npcEvents: Number(summary.npc_events || 0),
      firstCapturedAt: summary.first_captured_at || null
    },
    retentionDays: capability.retentionDays || 0
  };
}

export const exchangeHistoryInternals = Object.freeze({
  HISTORY_SCHEMA,
  HISTORY_TABLE,
  retentionDays,
  resetMigrationState: (db) => migrationState.delete(db)
});
