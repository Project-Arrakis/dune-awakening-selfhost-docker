# Base Inventory

The **Inventory** tab on an expanded base row (Bases panel → expand a base → Power / Water / Inventory / Sub-Fief Permissions) lists everything stored at that base. Reads are a snapshot; a container's contents can be opened per slot and individual items deleted.

Backed by `GET /api/bases/{baseId}/inventory` → `duneDb.baseInventory()`, plus
`GET /api/bases/{baseId}/containers/{placeableId}` → `duneDb.baseContainerSlots()` for one container's
slots and `DELETE …/containers/{placeableId}/items/{itemId}` to remove one.

## What counts as base inventory

Classification is an explicit `building_type` allowlist in `BASE_INVENTORY_TYPES` (`console/api/src/duneDb.js`), in four groups:

| Group | `building_type` (lowercased) → label |
|---|---|
| Storage | `storagecontainer` → Storage Container · `mediumstoragecontainer`† → Medium Storage Container (100 slots) · `developer_storagecontainer` → Developer Storage Container · `genericcontainer` → **Chest** · `spicesilo` and `smallstoragecontainer`† → **Small Storage Container** |
| Refining | `smallorerefinery` · `mediumorerefinery` · `largeorerefinery`† · `smallchemicalrefinery` · `mediumchemicalrefinery` → matching names; `spicerefinery` → Spice Refinery · `mediumspicerefinery`† · `largespicerefinery`† |
| Crafting | `fabricator` → Fabricator · `survivalfabricator` · `vehiclesfabricator` · `weaponsfabricator` · `wearablesfabricator` → Garment Fabricator · plus `advancedsurvivalfabricator`†, `advancedvehiclefabricator`† (singular), `advancedweaponsfabricator`†, `advancedwearablesfabricator`† → Advanced … |
| Other | `recycler` → Recycler · `repairstation` → Repair Station · `totem_small` → **Sub-Fief Console** · `totem` → **Advanced Sub-Fief** |

All suffixed `_placeable`. † marks a type not present in any database seen so far — it is in the allowlist because the game ships it, not because it has been observed in use.

`totem_small_placeable` and `totem_placeable` are the base's own claim structure — the totem, not a building placed inside the base. It carries a real 5-slot `dune.inventories` row like everything else here, reached through the same `placeables.owner_entity_id` join with no special-casing. Confirmed directly against a live restore of `kovalt_test.backup` rather than the paks grep below (the paks extraction is known-lossy, see below): 17 `totem_placeable` and 2 `totem_small_placeable` rows, each backed by a 5-slot inventory; base 3438's `totem_placeable` held 1 item (qty 83) and came back through the production `baseInventory` query unmodified. Display names are the catalog patent's, matching every other label in this table: `Totem_Small_Patent` is "Sub-Fief Console", `Totem_Patent` is "Advanced Sub-Fief".

Every string was verified against the shipped server paks, where each building carries a `DA_BLD_<building_type>.uasset`:

```bash
docker exec dune-server-survival-1 bash -c 'cat /home/dune/server/DuneSandbox/Content/Paks/*.pak | grep -aoE "DA_BLD_[A-Za-z0-9_]+_Placeable" | sed "s/^DA_BLD_//" | sort -u'
```

That is what caught `AdvancedVehicleFabricator_Placeable` being **singular** while its own base building, `VehiclesFabricator_Placeable`, is plural. The reverse does not hold: the extraction is lossy — `SpiceSilo_Placeable`, `SmallOreRefinery_Placeable` and `Fabricator_Placeable` all fail to appear despite being live on the same server, and a handful of results come back truncated at compression boundaries (`MediumorageContainer_Placeable`, `RepairSta_Placeable`). Presence is proof; absence is not.

`Developer_StorageContainer_Placeable` was verified from a live server database (9 placements). It is included explicitly in the Storage page, Live Map storage markers, and this base inventory allowlist; it is not inferred from `inventory_type`.

`SpiceSilo_Placeable` and `SmallStorageContainer_Placeable` are both listed and both labelled "Small Storage Container": the former is the legacy name every live placement still carries (48 on production against 0 of the latter), the latter is the asset name shipped in the paks. Anything not listed is omitted rather than bucketed, matching the allowlist reasoning in `portalGeneratorFuel`'s `generator_spec` CTE — an unrecognised placeable must not acquire a group and report an invented fill level.

Generator and windtrap fuel is deliberately absent; the Power and Water tabs own it.

## Why not classify on `inventory_type`

`dune.inventories.inventory_type` almost separates these groups on its own — verified against a real dump (373 placeables, 535 inventories, 493 `dune.actor_inventories` rows):

| `inventory_type` | `component_name_hash` | What it is |
|---|---|---|
| 4 | `1264785389` | Storage containers — `StorageContainer` 45 slots, `GenericContainer` 20, `SpiceSilo` 10 |
| 12 | `710548` and `26344419` | Refinery and fabricator inventories, two per placeable (split into the Refining and Crafting groups) |
| 3 | `1264785389` | Fuel and module slots — generators, wind turbines, windtraps — **and** `Recycler` and `RepairStation` |

Keying on the type would file a 25-slot `Recycler` — which held more items than anything outside storage in the reference dump — under "fuel", alongside the oil generators the Power tab already covers. Hence the building-type allowlist.

## The second refinery inventory

Every refinery and fabricator carries **two** `inventory_type = 12` inventories:

- `component_name_hash = 710548`, `max_item_count` 5 or 10 — holds the ore and crafting inputs.
- `component_name_hash = 26344419`, `max_item_count = -1` — empty on all 44 of them in the reference dump.

The query filters `inv.max_item_count >= 0`, which drops the second one. That agrees with the hash split on every row and avoids depending on `dune.actor_inventories`; it also keeps a slot bar from dividing by a negative capacity.

## Container names

`dune.permission_actor.actor_name` holds `'##' || building_type` for any placeable a player has never renamed, and whatever the player typed otherwise (real examples from the dump: "Ore Storage", "Aluminum Refinery", "Refinery Output NO ORES"). The query strips the `##`-prefixed defaults and `'None'`, exactly as `listStorage` does, and returns `""`; the frontend falls back to `<type name> #<placeable id>`.

The game stores **no** display name for a placeable *type*, so the type labels in `BASE_INVENTORY_TYPES` are this console's own. Where a `building_type` disagrees with the player-facing name, the catalog patent in `runtime/data/admin-items.json` wins — it is the same source the console already uses for item names.

`SpiceSilo_Placeable` is the case that matters. Its patent is named **"Small Storage Container"**, and the data agrees: across the 40 of them in the reference dump, 195 of 198 item rows were *not* spice — clothing, tools, ingots, bloodsacks. It is a general-purpose 10-slot container, and "Spice Silo" is only the internal blueprint name (`BP_SpiceSiloContainer`). The tab labels it "Small Storage Container".

Every label was ultimately read off the in-game build menu. Two would have been guessed wrong from the data alone, and both are worth recording:

**`GenericContainer_Placeable` is "Chest", not "Medium Storage Container".** Its 20 slots sit exactly between the confirmed 10-slot Small and 45-slot Storage Container, so the capacity ladder argues convincingly for "medium" — and is wrong. The real Medium Storage Container is a separate building with **100 slots**, which puts it *above* Storage Container rather than between.

**The fabricators are nine buildings, not five.** The plain and Advanced variants coexist in the build menu. The catalog cannot be taken at face value here: `SurvivalFabricator_Patent` is *named* "Advanced Survival Fabricator Patent" while a distinct `AdvancedSurvivalFabricator_Patent` carries the same display name, so one of the two entries is simply wrong. Reading the duplicate as "there is only an advanced tier" produces four wrong labels.

`SpiceRefinery_Placeable` is plain "Spice Refinery"; Medium and Large are separate buildables, unlike the size-prefixed ore refineries.

## Deleting a stored item

A container's contents overlay can delete a whole stack, or part of one. Backed by
`DELETE /api/bases/{baseId}/containers/{placeableId}/items/{itemId}` → `duneDb.deleteBaseContainerItem()`,
body `{ confirmation: "DELETE ITEM", count? }`. Omit `count` to clear the slot; pass a smaller number to
remove part of the stack. Whole-slot removal goes through the shipped `dune.delete_item(bigint)`, partial
through `dune.delete_inventory_item(bigint, bigint)`.

**A count larger than the stack is refused, not rounded down.** "Remove 400" and "remove everything" are
different requests, and the gap between them is a real race: the operator saw 500, asked for 400, and the
stack has since dropped to 300. Widening that into destroying all 300 would remove more than was ever
agreed to. The overlay is a snapshot, so this case is reachable in normal use.

**Ownership is re-resolved, never trusted.** The delete re-runs this page's claim CTEs from the base id
rather than believing the `placeableId` it was handed, and keeps the `inventory_types` allowlist join plus
`is_hologram = false` and `max_item_count >= 0`. That allowlist is what stops a delete reaching the
generator and windtrap fuel inventories the Power and Water tabs own — a placeable outside
`BASE_INVENTORY_TYPES` answers "not found" even when it genuinely belongs to the base.

The row lock is `for update of i, inv`, not a bare `for update`: Postgres cannot lock a CTE reference, and
locking only the item row locks nothing once that row is gone.

`DELETE …/items/{itemId}` requires its own IAM action, **`bases:delete-item`**, separate from the
`bases:mutate` bucket every other base mutation falls into. The reason differs from
[`bases:delete`](base-deletion.md)'s: not blast radius, but consent. This tab shipped read-only, so an
operator whose hand-authored policy grants `bases:mutate` agreed to refills and permission edits and could
not have agreed to item destruction — folding this in would silently widen every existing narrow policy.
The shipped `owner`/`admin` policies grant `bases:*`, so default access is unchanged.

Both of the usual base preconditions apply: a base with a queued delete, or one picked up via the game's
base-backup tool, rejects this with `409`.

## Why deletion requires a stopped map

An item delete is **not** queued: a specific inventory row may move, merge, or disappear before a deferred
operation runs. Instead, the route refuses the write until it can verify that the owning map is safely down.

The reason a queue exists at all still holds here:

- No `pg_notify` routine covers inventory or buildings. The game's 8 notify channels are guild, landsraad, party, permission, taxation, faction, vehicle_recovery, player_info.
- There are zero triggers on `dune.items`, `dune.inventories`, `dune.buildings`, `dune.placeables`.
- The RMQ command bus has no per-item edit or delete. `AddItemToInventory` addresses items by *template name*; every id here is a row id.

So a running map can neither miss the delete nor resurrect the row on its next autosave. The container GET
returns `deleteSafety`; the overlay disables deletion and explains why when the map is running or its state
cannot be verified. The DELETE route then repeats the check immediately before changing the database, so a
stale or hand-built request cannot bypass the UI.

Deletion is limited to plain **Storage** containers. Refinery and fabricator inventories are visible but
read-only because the game's crafting state can reference their item rows; removing a reserved ingredient
can leave an active job pointing at an item that no longer exists.

Item identifiers remain decimal strings from the URL through the PostgreSQL query. They are `bigint` values,
and converting one to JavaScript `Number` could round an id above `Number.MAX_SAFE_INTEGER` into a different
row — unacceptable for a destructive operation.

## Response shape

```
{ supported, baseId,
  groups:     [{ key, name, containerCount, itemCount }],
  containers: [{ placeableId, name, typeName, group, usedSlots, maxSlots, currentVolume, maxVolume, itemCount,
                 items: [{ templateId, name, quantity }] }],
  items:      [{ templateId, name, image, category, quantity, containerCount,
                 containers: [{ placeableId, name, typeName, group, quantity }] }],
  totals:     { items, distinct, containers, usedSlots, maxSlots, currentVolume, maxVolume } }
```

One response backs both views, so switching between Items and Containers never refetches. Item `name`/`category` come from `adminItemMetadata()` over `runtime/data/admin-items.json`, falling back to the raw `template_id`; `image` resolves through `itemImagePath()` and falls back to `image-unavailable.png`.

`usedSlots` counts item *rows* — one stack occupies one slot — while `quantity` sums `stack_size`. Capacity is summed once per inventory, not per item row, since every row repeats its inventory's `max_item_count`.

**`currentVolume`/`maxVolume` (issue #356) are column-probed the same way `positionIndex`/`qualityLevel` are
in "Per-container slots" below** — a schema without `dune.inventories.max_item_volume` or
`dune.items.volume_override` degrades both to `0` rather than failing the tab, and the UI shows "—" instead
of a percentage, or withholds the row entirely on a per-container card, whenever `maxVolume` is `0`.
`currentVolume` sums `volume_override` per inventory, which already stores the **TOTAL** volume of each
stack (per-unit volume × quantity, not the per-unit value alone) — the same convention
`giveItemToStorage`/`fillItemToStorage` use for their own volume-cap checks (see "Both Give and Fill enforce
the same slot and volume caps" below), so a displayed volume total always agrees with what the next
give/fill against that container will actually enforce.

**Why this exists instead of a backfill:** an item given via the storage give-item route before it started
recording `volume_override` (or given directly by the game engine) has a permanent `NULL` there, which
every `sum(coalesce(volume_override, 0))` query already treats as `0` — so a pre-existing container's real
volume usage was silently invisible rather than wrong. A one-time backfill script was considered and
rejected: it would mean running an `UPDATE` against every operator's live `dune.items` table on their next
pull, which is exactly the update-path risk Strict Requirement 0/26 exist to catch for a LOW-MEDIUM
accuracy gap in a capacity message, not a data-integrity or security issue. Surfacing the real, current
total directly — rather than trying to reconstruct history that was never recorded — was judged the lower-risk
fix.

**A container's `items[]` is not its stacks.** Rows sharing a template are merged into one entry, so `items.length` is the number of distinct templates and is **≤ `usedSlots`**. On the reference base, Chem Storage fills 8 slots with 3 templates, and 5 of 17 containers disagree the same way. The UI therefore says "3 distinct", never "3 stacks" — the stack count is `usedSlots`, already shown as Slots Used. The type is named `BaseInventoryEntry` rather than `…Stack` for the same reason.

This merge is deliberate and stays: `items[]` is what backs the "N distinct" label and the container search
filter, both of which genuinely mean distinct templates. The per-slot truth lives in a second response.

## Per-container slots

```
GET /api/bases/{baseId}/containers/{placeableId}
{ supported, found, baseId, placeableId, typeName, group, maxSlots, usedSlots, maxVolume, currentVolume,
  inventories: [{ inventoryId, maxSlots, usedSlots, maxVolume, currentVolume,
                  slots: [{ itemId, templateId, name, positionIndex, quantity,
                            qualityLevel, currentDurability, maxDurability }] }] }
```

`maxVolume`/`currentVolume` follow the exact same convention as `baseInventory`'s own totals above — summed
once per inventory, column-probed, degrading to `0`/`0` on a schema without volume support.

**Fetched per container, not with the tab.** Folding slots into `baseInventory` tripled that response —
238 KB to 656 KB on the largest base in the reference dump, +176% — on a tab that loads on every base
expand and auto-refresh, while the overlay only ever shows one container. One container is under a
kilobyte.

**Slots hang off an inventory, not the container.** A placeable can back more than one surviving inventory:
`container.maxSlots` is their sum, while `position_index` is scoped to a single inventory. A flat
per-container array would collide two slot 0s on anything with two inventories.

`itemId` is `dune.items.id` — the delete target, and the only stable key, since `templateId` repeats within
a container. `currentDurability`/`maxDurability` come out of the `stats` jsonb using the same expression as
`INVENTORY_ITEM_SELECT`, so the two paths cannot disagree about where durability lives.

`positionIndex`, `qualityLevel` and the durability pair are all **column-probed**, not assumed: a missing
column is a parse-time error rather than a null, so a schema without them would 500 a container that used
to open. They come back null instead, and the grid view is withheld.

### The contents overlay

Opened by **View Contents**, either on a container card or on any container listed under an expanded
item in the Items view — the same overlay, reached either way.

It offers two views, and **opens on Grid**:

- **Grid** lays the container out at its real capacity, one cell per slot, with empty slots marked by a
  plus. It is the closest thing to the in-game container and answers "what is in this box" at a glance.
  Empty cells are `aria-hidden` and non-interactive; the plus is decorative, drawn as two positioned
  bars rather than a `+` glyph, since a glyph centres on its line box rather than its ink.
- **List** is one row per slot with its slot number, quantity and a delete button. It sorts and scans
  better on a full 100-slot container, and is the automatic fallback whenever the grid is withheld.

Selecting a slot — a grid cell or an item name in the list — moves its controls into a strip below,
carrying the item, its slot, an amount field defaulting to the whole stack, and the delete button.
One strip rather than a control per row: a packed 100-slot container would otherwise render a hundred
quantity inputs.

Every inventory shares a single scroll region, so a placeable backing two inventories does not get two
independent scrollbars.

### position_index is not trustworthy

`dune.items` has no unique constraint on `(inventory_id, position_index)`, and nothing bounds the value by
`max_item_count`. All three of these are reachable, and the grid handles each rather than dropping a slot —
an item the delete control cannot reach is the worst outcome available:

| Case | Handling |
|---|---|
| Sparse / non-contiguous | Empty cells. This is the in-game look and the point of the view. |
| Two slots claim one index | First by `(positionIndex, itemId)` takes the cell; the other is listed as unplaced. |
| Index ≥ `maxSlots` | Listed as unplaced beneath the grid. |

The grid is also withheld when capacity is 0, above a 200-cell cap, or when every `positionIndex` is null;
the list stands in and can still delete.

A stack of exactly 1 shows no quantity badge in the grid — the badge is gated on `quantity > 1`, so a
single item renders as a bare icon.

## Adding items: Give, Give Multiple, and Fill

Storage containers only — the same allowlist restriction as deletion, one section down. The overlay's
"Add Item"/"Fill Container" panel is offered whenever `group === "storage"`; it does not additionally
require `deleteSafety.safe`, unlike every delete action on this page. See "Why Give/Fill do not require a
stopped map" below for why that asymmetry is deliberate, not an oversight.

| Action | Route | Backend function | Confirmation phrase |
|---|---|---|---|
| Give one item | `POST …/containers/{placeableId}/give-item` | `duneDb.giveItemToStorage()` | `GIVE ITEM TO STORAGE` |
| Give several items in one call | `POST …/containers/{placeableId}/give-items` | `duneDb.giveMultipleItemsToStorage()` | `GIVE ITEMS TO STORAGE` |
| Fill with a raw/refined resource or component | `POST …/containers/{placeableId}/fill-item` | `duneDb.fillItemToStorage()` | `FILL ITEM TO STORAGE` |

**Give accepts any catalog item; Fill does not.** `resolveCatalogItem()` (Give) has no group restriction —
weapons, clothing, schematics, anything in `runtime/data/admin-items.json` is acceptable.
`resolveFillableCatalogItem()` (Fill) additionally requires the item's `group` to be `raw_resource`,
`refined_resource`, or `component` (`FILLABLE_GROUPS` in `adminCatalog.js`) — the UI states this
restriction directly above the Fill inputs, and the server independently re-enforces it rather than
trusting the client to have filtered correctly.

**Give Multiple is one transaction, capped at 50 distinct items.** Every check `giveItemToStorage` performs
(slot cap, volume cap) is repeated fresh for each item in the batch — re-queried after each insert, not
computed once up front — so item 3 correctly sees the slots/volume items 1 and 2 already consumed within
the same call.

**Neither Give nor Fill ever rejects a request just because it would exceed the container's remaining
volume.** Per explicit operator direction (found during manual UI review of #347): an earlier version threw
`"Storage is full by volume"` and inserted nothing at all, forcing the operator to guess a smaller quantity
and retry. Both functions now **clamp the requested quantity down to whatever actually fits** and insert
that instead — asking for 500 of an item that only has room for 375 gives 375, not 0. The response always
reports `requested`, `given`, and `clamped` (`clamped: true` whenever `given < requested`), and the UI
surfaces exactly that outcome (`"Only 375 of the requested 500 x X fit and was given to the container."`)
rather than silently implying the full request succeeded. **Slot count is the one capacity axis this does
NOT apply to** — a single give/fill always consumes exactly one slot regardless of quantity, so "no slots
left" genuinely cannot be partially satisfied and remains a hard rejection (`"Storage is full by item slot
count"`). Volume itself is still a hard rejection in the one case clamping cannot help: truly zero room
left, where even 1 unit does not fit.

**Give Multiple's batch-clamping design is deliberately left-to-right, not best-effort.** Once one item in
the batch does not fully fit (clamped, or reduced all the way to zero), the batch **stops there** —
`giveMultipleItemsToStorage` does not skip ahead to try whether a later, smaller item in the same batch
might have had room. This is a design choice for predictability, not a limitation: an operator reading a
per-item breakdown top-to-bottom should be able to reason about "gave everything up to X, then stopped,"
rather than "gave some subset of the batch in an order that does not match what was typed." Like the
single-item functions, **the batch never throws just because it hit a capacity limit** — it returns
`ok: true` with `results: [...]`, one entry per requested item, each carrying `requested`/`given`/`clamped`/
`attempted`/`reason`. An item never reached because an earlier one already stopped the batch is still
present in `results`, with `attempted: false`, so the response always accounts for every requested item,
not just the ones that got a row inserted. This is a real backend contract change from an earlier version,
which threw on hitting a cap and relied on the transaction rolling back to prove no partial inserts
happened — the current version has no rollback to reason about, because a capacity limit is no longer an
error condition, and the response's `results` array is the accounting instead.

**Fill offers two distinct actions, not one quantity field with a hidden meaning.** "Fill Amount" sends the
operator's typed quantity (clamped as above if it does not fully fit). "Fill to Capacity" sends the
`quantity: 0` sentinel `fillItemToStorage` has always supported — insert as much as fits in whatever volume
remains, in one call — but that sentinel was unreachable from any UI before this fix, since both this tab's
own quantity field and the standalone Storage tab's clamp to a minimum of 1. `requested` is `null` in a
Fill-to-Capacity response (there was never a specific number to compare against); the UI reports the real
`given` count directly (`"4,200 x SteelBar was filled into the container (as much as fit)."`).

**Both Give and Fill enforce the same slot **and** volume caps.** An earlier version of `giveItemToStorage`
checked only slot count — an operator could give an item whose declared volume exceeded a container's
remaining volume, and because that give never recorded a `volume_override`, every later `fillItemToStorage`
volume check against the same container silently undercounted real usage. Fixed to match `fillItemToStorage`'s
existing volume accounting exactly (`volume_override` on an inserted row is the item's declared per-unit
volume × the stack's quantity, never the per-unit value alone — see "Fill visibility" below for why this
matters for pre-existing containers too).

**Give and Fill use a compact type-to-search item picker (`ItemCatalogCombobox`), not a raw "item name or
ID" text field.** Found during manual UI review of #347: the original plain text input required already
knowing the exact template id or exact in-game name, offered no way to discover what is actually in the
catalog, and did not filter anything as the operator typed — typing was just raw text sent straight to the
server on submit. Search and the results list are name-only: the catalog id (e.g. `"Oil"` for the in-game
"Fuel Cell") is a backend concept the operator never needs to see or type, and Give/Fill both submit the
selected item's real `itemId` under the hood regardless. The Fill combobox additionally filters its results
to `FILLABLE_GROUPS` client-side, matching the server's own `resolveFillableCatalogItem()` check, so the
picker never even offers an item the server would reject.

## Why Give/Fill do not require a stopped map

Deletion needs a stopped map because a running map's own copy of an inventory row can move, merge, or
disappear before a deferred write applies — see "Why deletion requires a stopped map" below. That reasoning
is specific to *modifying or removing an existing row*: **Give and Fill only ever insert a brand-new
`dune.items` row**, and inserting a new row cannot conflict with, overwrite, or be raced by whatever the
live game engine is doing with the *existing* rows in that same inventory. There is nothing running-map
state can invalidate about a row that did not exist a moment ago.

The tradeoff this creates: a given/filled item is **not visible in-game until the Survival server
restarts** — the game engine only claims newly-inserted `dune.items` rows at process startup (see
`docs/incidents/INC-2026-07-31-FILL-ITEMS-VISIBLE-ONLY-AFTER-RESTART.md` for the full investigation). The
console UI states this directly above the Give/Fill panel every time it is shown, matching the standalone
Storage tab's own "Apply Fills (Restart Survival)" note — this page deliberately does not offer an inline
restart button of its own; Server Control and Bases already own that action, and duplicating a
player-disconnecting restart trigger in a third place was judged riskier than one extra tab switch.

Because this asymmetry is easy to mistake for a bug — an operator who has just read "stop the map before
deleting" and then finds Give/Fill fully interactive a few lines below has a reasonable basis to suspect
something is broken — the map-safety-unavailable message itself states explicitly that Give and Fill are
unaffected, rather than leaving that only in this doc and a source comment.

## Removing items in bulk: Delete Selected and Delete All

Both are Storage-group-only and require `deleteSafety.safe`, identically to the single-item delete above —
neither is a separate code path with its own, looser safety check.

| Action | Route | Backend function | Confirmation phrase |
|---|---|---|---|
| Delete several checked items | `DELETE …/containers/{placeableId}/items` (body: `{ itemIds }`) | `duneDb.deleteMultipleBaseContainerItems()` | `DELETE ITEMS` |
| Delete every item in the container | `DELETE …/containers/{placeableId}/all-items` | `duneDb.deleteAllBaseContainerItems()` | `DELETE ALL ITEMS` |

**Ownership is re-resolved once per batch, not once per item** — both share a `resolveOwnedStorageContainer()`
helper that runs the same claim-CTE/allowlist/`is_hologram`/`max_item_count >= 0` resolution the single-item
delete uses, explicitly *not* the unscoped, actor_id-only lookup Give/Fill use internally (that shape has no
group filter and could otherwise reach a Refining/Crafting inventory). Ownership is checked once, the
resulting inventory row locked (`for update of inv`) for the duration of the whole batch.

**This query was completely broken against a real database from the moment it was introduced** (issue
#353): it combined `SELECT DISTINCT` with `FOR UPDATE OF inv`, which Postgres flatly rejects
(`FOR UPDATE is not allowed with DISTINCT clause`) — every real call to Delete Selected, Delete All, Give,
Give Multiple, and Fill (Give/Fill reach the same query indirectly, through `baseContainerOwnedStorageId()`'s
own `baseContainerSlots()` call in `server.js`) would have 500'd in production. This was invisible to every
mocked unit test in `db.test.js`, since the fake `db.query()` those tests use never actually parses SQL —
it only pattern-matches the query *text*, so a syntactically invalid query and a valid one with the same
substrings are indistinguishable to that kind of test. It was found only once a real-HTTP integration test
(issue #353's own fix, `baseContainerMutationRoutes.integration.test.js`) exercised these routes against
a real, isolated PostgreSQL database rather than a mock — the exact gap that issue existed to close. Fixed
by resolving the `DISTINCT` candidate set in its own CTE first, then joining back to the real
`dune.inventories` row purely to take the lock — `FOR UPDATE` only ever applies to that final, non-`DISTINCT`
join, which Postgres allows. This is also the reason every base-container mutation route (not just the two
this section covers) now has real HTTP-level integration coverage rather than the source-text-pattern
assertions `baseContainerMutationRoutes.test.js` was previously limited to.

**The batch itself is resolved and verified with a fixed, small number of set-based round-trips, not one
pair of round-trips per item.** Found during PR #349's own Layer 3 audit (DBA and Security hats
independently, issue #352, HIGH severity): the original version of both functions looped per item — a
`select … for update`, the `dune.delete_item(bigint)` call, an `exists` check, and a conditional fallback
`delete` — worst case ~800 sequential statements for a 200-item batch, all while the container's inventory
row lock was held for the entire duration, blocking any concurrent Give/Fill/Delete against the *same*
container for that whole window. `dune.delete_item(bigint)` is a shipped stored procedure taking exactly
one id, so the N calls to it are irreducible — but everything around those N calls is now batched: one
set-based `select … where id = any($1::bigint[]) and inventory_id = $2 for update` resolves the whole
requested set at once (Delete Selected) or the whole container at once (Delete All), and one set-based
`select`/fallback `delete` pair (shared by both functions as `finishDeletingLockedItems()`) verifies and
cleans up every row `dune.delete_item` left behind, instead of one pair per row. Round-trips drop from
~4N to ~N+2 for a batch of N items — a 200-item Delete Selected now costs ~202 statements instead of ~800,
and the container is only locked for that shorter window.

**If a storage-group container is ever found to back more than one qualifying inventory, both functions
refuse to guess and throw, rather than silently picking one and leaving items behind in the other.** This
page's own "Slots hang off an inventory, not the container" section above documents that a placeable can
back more than one surviving inventory as a general schema fact — the read path (`baseContainerSlots`)
already sums across every qualifying inventory a placeable has for exactly this reason. Give/Fill/single-item-delete
resolve their target inventory with `order by id limit 1`, deterministically picking the lowest id if more
than one ever exists. The two bulk functions instead throw
`"This container backs N separate inventories, which this action does not support yet. Please report this
so it can be fixed."` — found during this feature's own Layer 3 review that an earlier version had no
`ORDER BY`/`LIMIT` at all and took whichever row Postgres's planner returned first, which could have
silently cleared the wrong inventory. No storage-group
building type is currently known to carry more than one qualifying inventory (unlike Refining/Crafting's
documented `inventory_type = 12` pair — see "Why not classify on `inventory_type`" above, where Storage's
`inventory_type = 4` rows were confirmed single per placeable in the same reference dump), so this throw is
not expected to fire in practice; it exists so a future patch that changes that would be caught loudly
instead of corrupting data silently.

**Delete Selected skips items that no longer exist rather than erroring the whole batch** — an item deleted
by a player between when the operator's overlay last refreshed and when they clicked Delete Selected is
silently excluded from `removed[]`, and the response message states how many of the requested items were
actually found (`"N of M requested item(s) were deleted from the database"`). Delete All reads its item
list fresh inside the same transaction that deletes them, so "all" always means everything actually present
at the moment the container's row is locked, never a possibly-stale list the overlay fetched moments
earlier.

**Each entry in `removed[]` carries the same audit-detail fields the single-item delete's own
`destroyedState` does** — `positionIndex`, `qualityLevel`, `currentDurability`, `maxDurability` — not just
`itemId`/`templateId`/`count`. Found missing during PR #349's own Layer 3 audit (issue #350): without
these, a bulk-destroyed pristine legendary logs in the admin audit trail identically to a bulk-destroyed
broken common of the same template, which matters most for exactly this feature (bulk, irreversible,
multi-item destruction). Both bulk functions select these columns with the same column-probed fragment
`deleteBaseContainerItem` already uses (`auditDetailSelectFragment()`), so a schema missing
`position_index`/`quality_level`/`stats` degrades every field to `null`/`0` rather than failing the delete —
it never re-queries for them separately, and it never fails a batch just because a field is unavailable on
a given schema.

**`Developer_StorageContainer_Placeable` is not special-cased by any of this.** It is already in the
Storage group's building-type allowlist (see the table near the top of this doc) and is already reachable
by Give/Fill/Delete the same way any other Storage container is — it happens to only be obtainable by an
operator granting `Developer_Storage_Container_Patent` to a player via Players → Building Sets → "Show
Experimental," but nothing about that origin changes how this page treats the resulting placeable. A
dedicated test locks this in so a future change cannot silently carve it out.
