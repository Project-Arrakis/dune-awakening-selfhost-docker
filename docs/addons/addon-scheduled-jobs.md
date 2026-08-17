# Market Bot Scheduled Jobs and EDA Retirement

**Status:** Current | **Last Updated:** August 2026

The console API runs Market Bot reseed and buyback schedules in the background.
No browser page or addon needs to remain open. Market Bot is managed from
**Exchange > Bot** and uses the console-bundled
`runtime/data/market-seed-plan.json`.

## How scheduled jobs work

The scheduler ticks with the console's other background tasks. A due buyback run:

1. Runs a read-only eligibility probe.
2. Takes a database backup only when eligible player listings exist
   (`DB_BACKUP_ORIGIN=market-bot-buyback`).
3. Runs the buyback in a transaction and re-arms from completion time.
4. Appends a Buyback Sweep Log batch of purchases and leftover eligible
   listings (`0x5` Max Buys / `0x6` skipped locked). Idle ticks still classify
   skip reasons without a backup so the log explains why nothing was bought.

A due reseed always takes a backup (`DB_BACKUP_ORIGIN=market-bot-seed`), clears
only the bot's listings on the selected exchange, and writes the bundled seed
plan. Seed and buyback share a running lock, so they cannot mutate the exchange
at the same time. Player listings are never removed by reseeding.

The SQL is built server-side from validated schedule parameters. SQL text from a
browser or addon is never persisted or replayed. Buyback uses row locks with
`SKIP LOCKED`, and failures roll back before the database connection returns to
the pool.

## Schedule state

The console stores owner-only, atomically written schedules at:

- `runtime/generated/market-bot/buyback.json`
- `runtime/generated/market-bot/seed.json`
- `runtime/generated/market-bot/buyback-log.json` (sweep log batches; kept for
  5 days, 20 most recent). The scheduler tick removes expired batches even when
  buyback is disabled.

The schedules are `source: "console"`. If the console was down when a run came due, it
recomputes `nextRunAt` one interval out at boot instead of immediately writing to
the database.

Key buyback fields include `enabled`, `intervalMinutes`, `exchangeId`,
`priceMultiplier`, category multipliers, `buybackPercent`, `buybackPriceBasis`,
and `maxBuys`. Seed schedules include the same target, timing, and pricing fields
plus augment pricing. Both record `lastRunAt`, `lastRunStatus`, `lastRunDetail`,
and `nextRunAt`.

## EDA Exchange Bot retirement

EDA Exchange Bot (`eda-exchange-bot`) is superseded by the native Market Bot.
Install and update requests for it are rejected, and its old bridge returns HTTP
410 after retirement succeeds.

On the first console startup after upgrading:

1. Any legacy schedules are parsed and validated before anything is removed.
2. Valid values, including enabled state and next-run time, are copied to the
   core schedule paths and changed to `source: "console"`.
3. Installed addon and legacy schedule files are backed up under
   `runtime/backups/market-bot-eda-retirement/<timestamp>/`.
4. The EDA addon, addon state, and legacy job directory are removed.
5. Completion is recorded in
   `runtime/generated/market-bot/eda-retirement.json`.

If EDA was already uninstalled, the startup still creates valid disabled core
schedules. EDA uninstall does not delete exchange listings from the game
database, and retirement does not modify those listings. Schedule preferences
that were already deleted by an earlier uninstall cannot be reconstructed, so
the safe default is disabled until the operator configures Market Bot.

A malformed legacy schedule aborts migration before removal, leaving it available
for repair. If core state is committed but addon cleanup fails, the console uses
the core state and retries cleanup at the next startup.

See [exchange.md](../console/exchange.md#market-bot) for Market Bot behavior and
[addon-provenance.md](../security/addon-provenance.md) for the addon trust model.
