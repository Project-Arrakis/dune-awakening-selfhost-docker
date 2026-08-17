# Base Inventory

The **Inventory** tab on an expanded base row (Bases panel → expand a base → Power / Water / Inventory / Sub-Fief Permissions) lists everything stored at that base. Reads are a snapshot; a container's contents can be opened per slot and individual items deleted.

Backed by `GET /api/bases/{baseId}/inventory` → `duneDb.baseInventory()`, plus
`GET /api/bases/{baseId}/containers/{placeableId}` → `duneDb.baseContainerSlots()` for one container's
slots and `DELETE …/containers/{placeableId}/items/{itemId}` to remove one.

## What counts as base inventory

Classification is an explicit `building_type` allowlist in `BASE_INVENTORY_TYPES` (`console/api/src/duneDb.js`), in four groups:

| Group | `building_type` (lowercased) → label |
|---|---|
| Storage | `storagecontainer` → Storage Container · `mediumstoragecontainer`† → Medium Storage Container (100 slots) · `genericcontainer` → **Chest** · `spicesilo` and `smallstoragecontainer`† → **Small Storage Container** |
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
  containers: [{ placeableId, name, typeName, group, usedSlots, maxSlots, itemCount,
                 items: [{ templateId, name, quantity }] }],
  items:      [{ templateId, name, image, category, quantity, containerCount,
                 containers: [{ placeableId, name, typeName, group, quantity }] }],
  totals:     { items, distinct, containers, usedSlots, maxSlots } }
```

One response backs both views, so switching between Items and Containers never refetches. Item `name`/`category` come from `adminItemMetadata()` over `runtime/data/admin-items.json`, falling back to the raw `template_id`; `image` resolves through `itemImagePath()` and falls back to `image-unavailable.png`.

`usedSlots` counts item *rows* — one stack occupies one slot — while `quantity` sums `stack_size`. Capacity is summed once per inventory, not per item row, since every row repeats its inventory's `max_item_count`.

**A container's `items[]` is not its stacks.** Rows sharing a template are merged into one entry, so `items.length` is the number of distinct templates and is **≤ `usedSlots`**. On the reference base, Chem Storage fills 8 slots with 3 templates, and 5 of 17 containers disagree the same way. The UI therefore says "3 distinct", never "3 stacks" — the stack count is `usedSlots`, already shown as Slots Used. The type is named `BaseInventoryEntry` rather than `…Stack` for the same reason.

This merge is deliberate and stays: `items[]` is what backs the "N distinct" label and the container search
filter, both of which genuinely mean distinct templates. The per-slot truth lives in a second response.

## Per-container slots

```
GET /api/bases/{baseId}/containers/{placeableId}
{ supported, found, baseId, placeableId, typeName, group, maxSlots, usedSlots,
  inventories: [{ inventoryId, maxSlots, usedSlots,
                  slots: [{ itemId, templateId, name, positionIndex, quantity,
                            qualityLevel, currentDurability, maxDurability }] }] }
```

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
