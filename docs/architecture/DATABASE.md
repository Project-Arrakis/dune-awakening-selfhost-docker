# Database Reference

**Status:** Observed — verified against game build 2117304-0-shipping (September 2026). Re-verify after a game update.

The dedicated server keeps all world state in one PostgreSQL 17.4 database,
`dune`. The console reads and writes the same database. Almost none of that
schema is defined by this repo — it ships inside the closed-source server
image and changes when Funcom ships a build.

That last point governs how to read this document. It describes *mechanisms*
that have been stable across builds — how encryption is layered, how
partitions are created, how the game signals running map servers — and
deliberately does **not** transcribe the ~490 functions or ~186 tables, which
drift. For the current inventory, regenerate it ([§10](#10-patches-and-drift)) rather than trusting a
list written down months ago.

Related: [SYSTEM-OVERVIEW.md](SYSTEM-OVERVIEW.md) for the surrounding
components, [database-backups.md](../console/database-backups.md) for backup
and restore.

---

## 1. Scope and vintage

One database serves everything: world state, player accounts, guilds, the
exchange, Landsraad, and the console's own bookkeeping. There is no separate
admin database — the console stores its settings in JSON files under
`runtime/generated/`, not in Postgres.

### Checking your own vintage

The game records its own schema patches. This is the authoritative marker,
and it is available on any deployment:

```bash
docker exec dune-postgres psql -U dune -d dune -Atc "select name, date from dune.applied_patches order by date desc limit 5"
```

Recent rows look like `DA-22428_implement_retroactive_story_completion_rewards`
with a timestamp. Compare against the vintage in this document's status line
before relying on any specific claim below.

Do **not** use `dune.get_schema_version()` for this. It exists, but returns
the sentinel `999999` rather than a meaningful version.

### Two roles

The console connects as the **`dune`** role (`console/api/src/db.js`).
`runtime/scripts/update-db.sh` connects as **`postgres`** — patch application
needs privileges the console deliberately does not hold. If you are writing a
console query, assume the `dune` role's permissions, not yours at a `psql`
prompt.

---

## 2. Connections and ownership

Two independent writers share this database:

| Writer | Connection | Owns |
|---|---|---|
| The dedicated server (closed source) | its own, not visible to us | virtually the entire schema |
| The console (`console/api`) | one `pg` pool, `console/api/src/db.js` | five tables ([§9](#9-console-authored-objects)) |

They are separate OS processes. The console's pool object is not shared with
the game server in any way; the two simply agree on a database.

Connection settings resolve in `discoverDbConfig()`
([db.js:19](../../console/api/src/db.js)): `ADMIN_DATABASE_URL` wins outright
if set, otherwise the `DUNE_DB_*` / `PG*` variables supply host, database,
user and password. **Port is the exception** — it always delegates to
`resolvePorts()` rather than reading `DUNE_DB_PORT` directly, so that the
port the console connects on can never disagree with the port
status/preflight reports. The source comment explains the misconfiguration
this prevents; don't reimplement the precedence chain anywhere else.

---

## 3. Schemas and extensions

Three schemas:

- **`dune`** — the game. All tables, views, functions, procedures and types
  discussed below live here unless stated otherwise.
- **`ext`** — extensions only, kept out of `dune` deliberately:
  `pg_trgm` (trigram text search) and `pgcrypto` ([§4](#4-the-encryption-layer)).
- **`console_market_history`** — console-owned, created by us ([§9](#9-console-authored-objects)). The only
  schema in this database that this repo defines.

---

## 4. The encryption layer

Player-identifying data is encrypted at rest, and the tables you would expect
to query are **views that decrypt on read**:

| What you query | What actually stores it |
|---|---|
| `dune.accounts` | `dune.encrypted_accounts` |
| `dune.player_state` | `dune.encrypted_player_state` |

`dune.accounts` is defined as a projection over `dune.encrypted_accounts` that
passes `encrypted_funcom_id` through `dune.decrypt_user_data()` to produce the
`funcom_id` column. The encrypted columns are not readable without it.

Consequences worth knowing before writing a query:

- **You cannot index or efficiently filter on a decrypted column.** A
  `where funcom_id = $1` scans and decrypts. Filter on `id` or another
  plaintext column where possible.
- **Writes must go to the underlying table**, not the view.
- Encryption is toggled by the procedure
  `dune.setup_user_data_encryption(boolean)`. Do not call it casually — it
  rewrites stored data.

The third view, `dune.active_server_ids`, is unrelated to encryption but easy
to miss: it reports which map servers are *currently connected* by joining
`dune.farm_state` against `pg_stat_activity`, matching the connection's
`application_name` against `DuneSandbox - (.*)`. It reflects live connections,
not configuration — a configured-but-down map does not appear.

---

## 5. Table domain map

| Subsystem | Tables | Deep-dive doc |
|---|---|---|
| Actors & world | `actors`, `actor_audit`, `actor_fgl_entities`, `actor_spawner_actors`, `actor_spawners`, `actor_state`, `fgl_entities`, `building_instances`, `placeables`, `totems`, `encounters_static`, `farm_state`, `farm_variables`, `map_areas`, `map_names`, `markers`, `player_markers`, `overmap_players` | [live-map.md](../console/live-map.md) |
| Buildings & bases | `buildings`, `building_progression`, `building_favorites`, `building_blueprints`, `building_blueprint_instances`, `building_blueprint_pentashields`, `building_blueprint_placeables`, `base_backups`, `base_backup_linked_actors`, `landclaim_segments` | [blueprints.md](../console/blueprints.md), [base-backups.md](../console/base-backups.md), [base-deletion.md](../console/base-deletion.md) |
| Inventory & items | `inventories`, `items`, `actor_inventories`, `removed_items`, `removed_recipes` | [base-inventory.md](../console/base-inventory.md) |
| Players & accounts | `encrypted_accounts`, `account_removal_log`, `encrypted_player_state`, `character_transfer_imports`, `player_access_codes`, `player_faction`, `player_faction_reputation`, `player_tags`, `player_respawn_locations`, `player_virtual_currency_balances`, `communinet_player`, `communinet_player_channels`, `cheater_tracking` | — |
| Guilds & parties | `guilds`, `guild_members`, `guild_invites`, `parties`, `party_members`, `party_invites`, `platform_parties_mapping` | — |
| Landsraad | `landsraad_decrees`, `landsraad_decree_rotation`, `landsraad_decree_term`, `landsraad_decree_votes`, `landsraad_tasks`, `landsraad_task_progress`, `landsraad_task_progress_guild`, `landsraad_task_progress_player`, `landsraad_task_progress_processed`, `landsraad_task_faction_contributions`, `landsraad_task_guild_contributions`, `landsraad_task_player_contributions`, `landsraad_task_reveal_state`, `landsraad_task_rewards`, `landsraad_house_rewards` | — |
| Exchange | `dune_exchanges`, `dune_exchange_accesspoints`, `dune_exchange_categories_hash`, `dune_exchange_orders`, `dune_exchange_sell_orders`, `dune_exchange_fulfilled_orders`, `dune_exchange_users` | [exchange.md](../console/exchange.md) |
| Specializations & skills | `specialization_tracks`, `specialization_keystones_map`, `purchased_specialization_keystones`, `specialization_refund_id` | — |
| Journey & tutorial | `journey_story_node`, `journey_story_node_cooldown`, `journey_tracked_cards`, `tutorial_per_player`, `tutorials`, `consumed_per_player_lore`, `consumed_temporary_per_player_lore`, `lore_pickups`, `lore_pickups_temporary`, `dialogue_met_npcs`, `dialogue_taken_nodes`, `mnemonic_recall`, `dungeon_completion`, `dungeon_completion_players` | — |
| Spice & resource fields | `resourcefield_state`, `spicefield_types`, `spicefield_server_availability` | — |
| Vehicles | `vehicles`, `vehicle_modules`, `vehicle_module_inventories`, `backup_vehicles`, `recovered_vehicles` | [vehicle-deletion.md](../console/vehicle-deletion.md), [vehicle-permissions.md](../console/vehicle-permissions.md), [vehicle-storage.md](../console/vehicle-storage.md) |
| Permissions | `permission_actor`, `permission_actor_rank` | [base-permissions.md](../console/base-permissions.md), [base-child-permissions.md](../console/base-child-permissions.md) |
| Travel | `player_travel_state`, `travel_actor_parent`, `travel_return_info` | — |
| Coriolis & reset seeds | `world_farm_reset_seed`, `world_map_reset_seed`, `world_partition`, `world_partition_reset_seed` | — |
| Misc/operational | `applied_patches`, `game_events`, `factions`, `network_address_config`, `sinkcharts`, `shiftingsands_data`, `tax_invoice`, `vendor_stock_cycle`, `vendor_stock_state` | — |

One warning that belongs here regardless. The shipped schema contains the
studio's own debugging and migration debris. These are not console tables,
are not documented by Funcom, and must never be written to or cleaned up:

`da_6358_broken_players_1300`, `da_6358_broken_players_12400`,
`da_6358_pre_broken_players`, `da_12319_faction_rank_backup`,
`debug_test_table`, `demo_users`, `temp_items_dune_161802`,
`temp_contract_tags_backup_164545`

Their presence is normal. Their absence on a newer build is also normal.

---

## 6. Partitioning

`dune.world_partition` is the driver. Inserting a row there fires two
triggers, and the event log for that partition is created as a side effect:

- `partitions_inserted_trigger` → `dune.determine_partition_label_trigger()`
- `trigger_create_event_log_partition` → `dune.create_event_log_partition()`,
  which calls the procedure
  `dune.create_event_log_partition_table(table_name text, partition_id bigint)`

The result is the `dune.event_log_p*` family — 58 tables on the verified
build, which is why a raw table count (186) looks alarming next to the ~127
tables that actually carry distinct meaning.

Practical effect: **never `insert into dune.world_partition` by hand.** A row
there provisions tables.

`world_partition` is also where the game's map/dimension/partition addressing
lives — the `map`, `dimension_index` and `partition_definition` columns. That
model, and why world state must be keyed by `(map, dimension_index)`, is
covered in [`WORLD-MODEL.md`](WORLD-MODEL.md).

---

## 7. Routines, and why direct DML often does nothing

The single most important thing to understand about this database: **the game
ships stored procedures that notify running map servers, and a plain
`UPDATE` does not.**

A map server holds world state in memory. Writing a row that the server
already has loaded changes the database and nothing else — the server
overwrites it on its next flush, or simply never reads it again. The shipped
procedures exist precisely to emit the notification that makes a change take
effect live.

So before writing any mutation, check whether a shipped procedure covers it.
If one does, call it.

### Notify channels

Eight channels exist on the verified build, listed with how many call sites
each has in the schema:

| Channel | Call sites |
|---|---|
| `guild_notify_channel` | 12 |
| `landsraad_notify_channel` | 11 |
| `party_notify_channel` | 9 |
| `permission_notify_channel` | 7 |
| `taxation_notify_channel` | 6 |
| `faction_notify_channel` | 2 |
| `vehicle_recovery_notify_channel` | 1 |
| `player_info_notify_channel` | 1 |

**There is no channel for inventory or buildings.** No amount of correct SQL
will make an inventory change appear in a running client — the player must
relog. Any console feature touching items has to say so in its UI rather than
implying a live effect. See
[base-inventory.md](../console/base-inventory.md).

### Procedures

Six, on the verified build — five Landsraad plus one operational:

| Procedure | Purpose |
|---|---|
| `landsraad_insert_tasks(bigint, landsraadtask[], landsraadtaskreward[])` | seed a term's tasks |
| `landsraad_update_decrees(landsraaddecree[])` | update decrees |
| `landsraad_nominate_decrees_for_voting(bigint, integer)` | open decrees for voting |
| `landsraad_update_factions(text[])` | reconcile faction names |
| `create_event_log_partition_table(text, bigint)` | [§6](#6-partitioning) |
| `setup_user_data_encryption(boolean)` | [§4](#4-the-encryption-layer) |

### Triggers

Nine on the verified build — eight shipped by the game, one installed by the
console. Landsraad accounts for four of the game's, which is why Landsraad
writes have side effects well beyond the row you touched:

| Trigger | On table | Function |
|---|---|---|
| `landsraad_task_faction_contributions_check_task_completion` | `landsraad_task_faction_contributions` | `landsraad_check_task_completion()` |
| `landsraad_tasks_check_term_won_state` | `landsraad_tasks` | `landsraad_check_term_won()` |
| `landsraad_tasks_house_rewards_changed` | `landsraad_house_rewards` | `landsraad_notify_house_rewards_changed()` |
| `landsraad_tasks_process_house_rewards` | `landsraad_task_player_contributions` | `landsraad_process_house_rewards()` |
| `actor_fgl_entities_cleanup_orphaned_entities` | `actor_fgl_entities` | `cleanup_orphaned_entities()` |
| `normalize_farm_state_addresses` | `farm_state` | `normalize_farm_state_addresses()` |
| `partitions_inserted_trigger` | `world_partition` | `determine_partition_label_trigger()` |
| `trigger_create_event_log_partition` | `world_partition` | `create_event_log_partition()` |
| `console_market_history_capture` **(ours)** | `dune_exchange_fulfilled_orders` | `console_market_history.capture_fulfilled_order()` |

If you are enumerating triggers to reason about game behavior, exclude the
last one — it is ours, and [§9](#9-console-authored-objects) covers it.

---

## 8. Capability probes

Because the schema drifts with each build, the console does not assume any
game-owned object exists. Two helpers in `console/api/src/duneDb.js`:

```js
tableExists(db, name, schema = "dune")   // select to_regclass($1) is not null
functionExists(db, signature)            // select to_regprocedure($1) is not null
```

A missing object raises `UnsupportedCapabilityError` via `requireCapability()`,
which surfaces to the UI as an unsupported feature rather than a 500.

**The rule: a new query must probe every relation it names, including ones
reached only through a `LEFT JOIN`.** A partial probe passes, then fails in
production against the one build that dropped the un-probed table. This has
been the cause of repeated regressions.

Three objects the console still references no longer exist on the verified
build, all handled this way — they are the worked example of why the
machinery exists:

| Object | Fate | Guard |
|---|---|---|
| `dune.actor_state` | folded into `dune.actors.state` by game Patch 1.5 | legacy path retained, `duneDb.js:5307` |
| `dune.spicefield_types` | removed | `tableExists`, `duneDb.js:349` |
| `dune.get_solaris_id()` | removed | `functionExists`, `duneDb.js:1014`, `:2836` |

---

## 9. Console-authored objects

There is no migrations directory. Everything the console owns is created
lazily with `if not exists`, on first use of the feature that needs it.
Because creation is lazy, **absence is not a fault** — a deployment that has
never used the relevant feature simply will not have the object yet.

### Five tables inside the game's schema

| Table | Created in |
|---|---|
| `dune.console_player_playtime` | `duneDb.js:1518` |
| `dune.discord_player_links` | `duneDb.js:14933` |
| `dune.discord_pending_links` | `duneDb.js:14950` |
| `dune.admin_choam_terminals` | `services/choamTerminals.js:49` |
| `dune.player_death_log` (+2 indexes) | `deathPoller.js:39` |

### The `console_market_history` schema

Exchange history is the one place the console does more than add a table. In
`console/api/src/services/exchangeHistory.js` it creates its own schema, a
`transactions` table with four indexes, **a function**, and a trigger on one
of the *game's* tables:

| Object | Kind |
|---|---|
| `console_market_history` | schema |
| `console_market_history.transactions` (+4 indexes) | table |
| `console_market_history.capture_fulfilled_order()` | function |
| `console_market_history_capture` on `dune.dune_exchange_fulfilled_orders` | trigger |

This is the only `CREATE FUNCTION` and the only trigger this repo issues. Two
details matter if you touch it:

- **The function swallows every exception.** Its body ends in
  `exception when others then raise warning ... return new`, deliberately:
  history capture is observability, and a schema drift or recorder fault must
  never roll back a player's market transaction. Do not "fix" this into a
  hard failure.
- **It is attached to a game-owned table.** A game build that reshapes
  `dune_exchange_fulfilled_orders` can break capture silently — the warning
  goes to the Postgres log, not the console UI.

See [exchange.md](../console/exchange.md) for the feature itself.

---

## 10. Patches and drift

`runtime/scripts/update-db.sh` applies the SQL under `runtime/sql/` and
records what the game has applied in `dune.applied_patches` ([§1](#1-scope-and-vintage)). It connects
as `postgres` and reconciles trigger definitions as part of the run.

Repo-supplied patches currently in `runtime/sql/`:

- `patch-blueprint-array-bounds.sql`
- `patch-coriolis-base-backup-preservation.sql`
- `patch-vehicle-recovery-guard-schema.sql`

### Detecting drift

`runtime/scripts/schema-report.sh` regenerates everything in this document
that can go stale, against a live database:

```bash
runtime/scripts/schema-report.sh
```

It is read-only, and reports: the patch-log vintage ([§1](#1-scope-and-vintage)), object counts,
notify channels ([§7](#7-routines-and-why-direct-dml-often-does-nothing)), non-internal triggers ([§7](#7-routines-and-why-direct-dml-often-does-nothing)), and a drift check that
extracts every `dune.*` name referenced in `console/api/src` and lists the
ones that do not resolve in the database.

Container, role and database default to `dune-postgres` / `dune` / `dune`,
overridable with `DUNE_POSTGRES_CONTAINER`, `DUNE_POSTGRES_ROLE` and
`DUNE_POSTGRES_DB`.

A name in the drift list is **not automatically a bug.** It is one of:

1. correctly guarded by a capability probe ([§8](#8-capability-probes)) — the usual case;
2. a console table not yet created, because the feature has not run ([§9](#9-console-authored-objects));
3. prose — the extraction is textual, so `dune.<word>` in a comment or an
   error string is reported too;
4. an actual latent bug.

On the verified build the list is eight names, and none are case 4.
