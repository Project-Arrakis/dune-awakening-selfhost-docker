# Market Board (Exchange)

**Status:** Current | **Last Updated:** August 2026

The Market Board is a **read-only** view of the in-game CHOAM exchange. It reads the
game's own exchange tables (the game writes them; the console never mutates them) so
an admin can see what is currently listed for sale — prices, stock, and sellers — at
a glance. It is modeled on the Market tab from
[Icehunter/dune-admin](https://github.com/Icehunter/dune-admin), rendered in the
console's own theme and components.

See [API-REFERENCE.md](API-REFERENCE.md#market-board) for the endpoint contract.

## What it shows

The board is **aggregated by item**: one row per `(template_id, quality_level)`,
with the **lowest price**, **total stock**, and **listing count** across all matching
sell orders. Item name, category, and icon come from the local
`runtime/data/admin-items.json` catalog (`template_id` falls through as the name when
the catalog has no entry); tier is parsed from a `T<n>_` template prefix when present.

Clicking a row drills down to the **individual sell orders** for that item, each with
its resolved seller, price, quantity, and grade.

### Seller resolution

A listing's seller (`owner_id`) is resolved the same way the Players page resolves a
character: `dune.actors.owner_account_id → dune.player_state.character_name`, falling
back to the actor's `class`, then `Unknown`. `player_state` is the decryption view, so
this works without touching encrypted account data.

## Bot listing identification

This is the one piece worth understanding before trusting the `Bot listings` filter.

- The **only** database-level signal that an order is not a real player's is
  `dune.dune_exchange_orders.is_npc_order` (a boolean).
- Every `is_npc_order = true` order belongs to the in-game CHOAM broker NPC (a single
  actor whose class is `Revy`). External market-bot tools operate by posting their
  sell orders **as this NPC**, so in practice `is_npc_order = true` is *the bot
  channel*.

Consequences, by design:

- `is_npc_order = true` lumps the game's own NPC vendor together with any bot posting
  through it — you **cannot** distinguish one bot tool from another at the database
  level.
- A bot that instead lists through a **normal player account** would be classified as
  a *Player* listing, not a *Bot* listing. So `is_npc_order` alone is a **necessary
  but not complete** definition of "bot".

To cover that gap without a schema change, the board lets an admin widen the
definition with a configurable **allowlist of bot owner ids** (see below). The
effective rule is:

- **bot** = `is_npc_order` **OR** `owner_id ∈ botOwnerIds`
- **player** = not a bot (not `is_npc_order` and not in `botOwnerIds`)
- **all** = no owner filter

The board defaults to **All listings**; switch to **Player listings** to focus on
real player activity (most servers are dominated by NPC/broker stock) or **Bot
listings** to see only bot/broker stock.

## Filter configuration (gear icon)

The gear beside the owner selector opens a small overlay with two editable lists:

- **Bot user ids** — owner ids to treat as bot listings, unioned with `is_npc_order`
  as described above. Use this to capture bots that post through player accounts, or
  bots run by other tools. The in-game broker (Revy) appears here as a built-in,
  removable entry: it is classified as a bot via `is_npc_order` rather than an id, and
  removing it (persisted as `includeNpcBroker: false`) stops treating its orders as
  bot — they then fall under player/all like any other seller. Restore it any time.
- **Blacklisted ids** — owner ids to hide from the market entirely. A blacklisted
  seller is excluded from **every** view and every owner filter (including "All").

Both lists are stored **console-side only**, in
`runtime/generated/exchange-config.json` — **no game data is changed**. Ids are
validated as numeric owner-id strings, deduped, and length-capped. Saving the config
is a mutation: it is rate-limited and written to the audit log (only the id counts
are recorded, no personal data). Blacklisting is a moderation action — it changes
what the market shows — which is why every change is audited.

## Market Bot

The Bot button beside the filter gear opens the console-managed **Market Bot**
(ported from [jeffstokes72/eda-exchange-bot](https://github.com/jeffstokes72/eda-exchange-bot),
which itself ports Easy Dune Admin's exchange seeder — the same engine the EDA
Exchange Bot addon drives through the scheduler bridge, now first-class):

- **Market reseed** stocks the CHOAM exchange with NPC sell listings from a bundled
  seed plan (`runtime/data/market-seed-plan.json`; an installed EDA Exchange Bot
  addon's plan copy wins when present) at a configurable price multiplier. Every run
  is **backup → clear the bot's own listings on that exchange → seed**; player
  listings are never touched.
- **Buyback sweeps** buy player sell listings whose per-unit ask is at or below the
  buyback percentage of the chosen **price basis** — seeded NPC price at that
  listing's grade (default), or the live player-market average / lowest ask with
  seeded fallback. Whole listed stacks are bought in one pass, sellers are paid
  through never-expiring "Take Solari" payment entries, and concurrent sweeps are
  safe at the database level (`FOR UPDATE ... SKIP LOCKED`). Every run probes
  eligibility with a read-only query first and only takes a backup + sweeps when
  something qualifies.
- **Schedules** run unattended inside the console API process (no browser page needs
  to stay open) and survive restarts. Schedules saved from this UI are
  `source: "console"`: they are authorized by RBAC at save time and do not require
  the addon to be installed. Schedules saved by the EDA Exchange Bot addon through
  the bridge stay `source: "addon"` and keep re-verifying the addon's approved
  permissions on every run. Both kinds share one running lock, so console and addon
  jobs can never write the exchange concurrently.

Reads and the eligibility probe require the `exchange:market` action; schedule saves
and run-now require `exchange:market-write`. Neither is granted to the viewer tiers
that receive `exchange:read`, so by default only the admin tier (`exchange:*`) sees
the Market Bot button at all. All mutations are rate-limited and audited.

## Scope

The board itself is strictly read-only over game data — it only *classifies and
hides* listings. The Market Bot above is the deliberate exception: its seed and
buyback runs write the game's exchange tables, always behind an explicit RBAC
action, a confirm dialog (for manual runs), an audit entry, and a pre-write
database backup.
