# Building Set (Patent) Grants

How building-category patents (refineries, fabricators, storage, decorative
placeables) actually become buildable in-game, and why a direct write to a
player's known-recipes list is not sufficient for this item class — found the
hard way granting a batch of patents to a player and having several silently
not work in-game despite the database write succeeding.

## Two separate ownership stores, one console tab each

The console tracks two independent things that both get loosely called
"crafting":

| Store | Column | What it actually gates |
|---|---|---|
| Crafting recipe library | `dune.actors.properties -> 'CraftingRecipesLibraryActorComponent' -> 'm_KnownItemRecipes'` (JSON array on the player's own actor row) | Handheld/portable **schematics** (weapons, tools, water discipline gear) — whether the item shows "known" in the Crafting tab and can be crafted at a workbench. `unlockCraftingRecipe()` / `playerCraftingRecipes()` (`console/api/src/duneDb.js`) read and write this directly. |
| Building-set ownership | `dune.building_progression.learned_building_sets` / `new_buildable_pieces` (text arrays, keyed by `character_id`) | Whether a **building placeable** (refinery, fabricator, storage container, decorative patent) actually appears in the in-game construction wheel. `playerBuildingUnlockState()` (`console/api/src/duneDb.js:6599`) is the only reader anywhere in this codebase — there is no writer. |

`craftingRecipeCatalogRows()` (`console/api/src/duneDb/presentation.js`)
deliberately includes `category: "buildings"` items ending in `_Patent`
alongside real schematics, labelled `source: "Building Patents"`, so the
Crafting tab's recipe list *displays* both kinds side by side. That is a
display convenience, not proof the two stores are interchangeable — writing a
building patent's ID into `m_KnownItemRecipes` makes it show as "known" in
that list, but the actual construction-menu availability in-game is governed
exclusively by `building_progression`, which that write never touches.

**Practical consequence:** a raw-SQL grant that appends `_Patent` IDs into
`m_KnownItemRecipes` will report success and will make the item list as
"unlocked" in the console's own Crafting tab, but the player will not be able
to see or place several of those buildings in-game. This was confirmed
directly: granting 40 `Construction`-category patents this way left the
player unable to construct three of them (Large Ore Refinery, Large Spice
Refinery, Medium Chemical Refinery) even after the database write succeeded
and the recipe list showed all 40 as known.

Schematics (plain `category: "schematics"` items, no separate ownership
table) are unaffected by any of this — `m_KnownItemRecipes` is the correct
and complete mechanism for those.

## The correct mechanism: deliver the real patent token

Nothing in this codebase writes to `building_progression` directly, by
design — it is state a closed-source game server process owns and updates on
its own schedule, not something an admin tool should guess the shape of (see
the fork's own command-auth-token incident writeup for why hand-writing
state a live process independently validates has caused real production
outages before).

The supported path, used by the console's own **Building Sets** tab
(`console/web/src/features/players/BuildingUnlocksTab.tsx` →
`grantBuildingUnlock()` → `server.js:5506`), is:

1. Deliver the real patent-token **item** into the player's inventory
   (`dune.items`, via `giveItemToPlayer()` — the same "Give Item" path used
   for any other item grant).
2. Dune's own server consumes that token on the player's next login and adds
   the corresponding entry to `building_progression.learned_building_sets`.

For an **offline** player this always goes through the database-insert path
in `giveItemToPlayer()` (`console/api/src/duneDb.js:12723`) rather than the
live in-game command path — the same function this doc's SQL below
replicates.

### Replicating this in raw SQL

`giveItemToPlayer()`'s insert has more moving parts than the recipe-list
write: per-item stack-size planning, a slot-collision-avoiding
`position_index` claim (`createStackPositionClaimer`, "lowest free slot"
direction for a player grant), and schema-capability detection for two
optional columns (`is_new`, `acquisition_time`). A naive
`INSERT INTO dune.items (...) VALUES (...)` that picks an arbitrary
`position_index` risks colliding with a slot the player's actual inventory
already occupies — this is real risk to a live account's inventory grid, not
a hypothetical.

A raw-SQL grant for building patents should therefore:

- Target `dune.inventories` where `actor_id = <player>` and
  `inventory_type = 0` (the player's backpack — same lookup
  `giveItemToPlayer()` uses).
- Claim the **lowest unoccupied** `position_index` in `[0, max_item_count)`
  when the inventory is slot-capped, or `max(position_index) + 1` when it
  isn't — matching `createStackPositionClaimer`'s player-grant direction
  exactly.
- Use the same default `stats` JSON `giveItemToPlayer()` builds for a
  non-weapon, non-clothing, non-augmented item:
  `{"FCustomizationStats":[[],{}],"FItemStackAndDurabilityStats":[[],{"CurrentDurability":100,"MaxDurability":100,"DecayedMaxDurability":100}]}`
- Detect `is_new`/`acquisition_time` via `information_schema.columns` rather
  than assuming either exists, matching `itemInsertShape()`'s own capability
  check.
- Skip an item already present in `building_progression` (owned) or already
  sitting as an unconsumed token in the inventory (pending), matching
  `buildingUnlockStatus()`'s alias check (`<id>` and `<id-without-_Patent>`,
  case-insensitive).
- Require the player to be **offline** before running it — the same
  precondition `requireOfflinePlayer()` enforces for every other
  database-direct mutation in this codebase, and the Advanced SQL Console
  does **not** enforce it for you.

A worked example generated for a real grant is archived at
`docs/archive/sessions/` (see the git history of this file's introducing PR
for the exact script) — copy its DO-block structure rather than writing the
position-claiming logic from scratch each time.

## Addendum (2026-09-02): Filmic Archive DLC content pre-loaded ahead of launch

Dune: Awakening's **Filmic Archive DLC** was announced at Gamescom 2026 —
$9.99, ships September 22, 2026, on PC/Xbox/PS5. It adds movie-tie-in
cosmetics and placeables (a Dune: Part One "Caladan Castle" furniture/decor
set, and a Dune: Part Two Sardaukar building/armor set), per
[the official announcement](https://duneawakening.com/news/dune-awakening-at-gamescom-ps5-gameplay-filmic-archive-dlc-and-cross-play-confirmed-for-post-launch/)
and [MMORPG.com's item breakdown](https://www.mmorpg.com/news/dune-awakenings-filmic-archive-dlc-revealed-in-new-trailer-and-details-on-everything-included-2000138813).

Checked against this fork's `runtime/data/admin-items.json` (2,558 items):
**27 of the "Caladan Castle" set's placeables are already present**,
`category: "buildings", source: "BuildingSets"`, i.e. real, gate-able
building patents right now, well ahead of the DLC's entitlement unlock —
confirming the same content the DLC will unlock already ships in the game's
files and this console's own catalog.

| Name (in-game) | `db_id` (template_id) |
|---|---|
| Chair | `MTX_Atre_Movie_Chair_Patent` |
| Bench | `MTX_Atre_Movie_Bench_Patent` |
| Large Carpet | `MTX_Atre_Movie_LargeCarpet_Patent` |
| Small Carpet | `MTX_Atre_Movie_SmallCarpet_Patent` |
| Wall Art | `MTX_Atre_Movie_DecorativePlate_Patent` |
| Painting | `MTX_Atre_Movie_Painting_Patent` |
| Desk | `MTX_Atre_Movie_LargeDesk_Patent` |
| Table | `MTX_Atre_Movie_Table_Patent` |
| Dresser | `MTX_Atre_Movie_Dresser_Patent` |
| Cabinet | `MTX_Atre_Movie_Cabinet_Patent` |
| Bonsai Tree | `MTX_Atre_Movie_Bonsai_Patent` |
| Bull Statue | `MTX_Atre_Movie_BullStatue_Patent` |
| Decorative Box | `MTX_Atre_Movie_DecorativeBox_Patent` |
| Wine Bottle | `MTX_Atre_Movie_DecorativeWineBottle_Patent` |
| Platter | `MTX_Atre_Movie_FoodPlatter_01_Patent` |
| Drinking Glass | `MTX_Atre_Movie_Glass_01_Patent` |
| Drinking Glass 2 | `MTX_Atre_Movie_Glass_02_Patent` |
| Plate | `MTX_Atre_Movie_PlateCutlery_Patent` |
| Castle Hologram | `MTX_Atre_Movie_CaladanCastle_Hologram_Patent` |
| Vase | `MTX_Atre_Movie_Vase_01_Patent` |
| Water Pitcher | `MTX_Atre_Movie_WaterPitcher_Patent` |
| Windchimes | `MTX_Atre_Movie_WindChimes_Patent` |
| Caladan Breakfast Room Window | `MTX_Atre_Movie_Window_Patent` |
| Caladan Bed | `MTX_Caladan_Movie_Bed_Patent` |
| Caladan Mural | `MTX_Caladan_Movie_Mural_Patent` |
| Caladan Cushion | `MTX_Caladan_Movie_Cushion_Patent` |
| Caladan Emblem Hologram Projector | `MTX_Atre_Hologram_CaladanEmblem_Patent` |

Five more items share the same asset family but were **not** treated as
confirmed — either their catalog `name` is an unlocalized placeholder
(`MTX_Atre_BreakfastRoomSet_Patent` → literal `EMPTY_TEXT`,
`MTX_Atreides_MovieGlowglobe_Patent` → literal template ID) or they carry an
ambiguous `Outpost` naming shared with a non-DLC Atreides building set
(`MTX_Atreides_Outpost_Bookshelf_Patent`,
`MTX_Atreides_Outpost_DoorFrame_Patent`,
`MTX_Atreides_Outpost_FloorLight_Movie_Patent`): treat these as probable, not
confirmed, without checking the shipped paks directly.

**Not found under any guessed naming** in this catalog snapshot: the Dune:
Part Two Sardaukar building set (the announcement's "73 Sardaukar building
pieces + 17 decorations"), Harkonnen Cataphract Armor, Longhaul Stillsuit,
Aegis of an Unwalked Path, Atreides Hoplite Armor, Benediction Disruptor, or
either of the two named emotes. `runtime/data/admin-items.json` is a
manually curated subset (per its own header comment), not a live dump of the
game's item templates — absence here is not proof of absence in the actual
shipped game files, only that this particular curated file doesn't have them
under any name tried.
