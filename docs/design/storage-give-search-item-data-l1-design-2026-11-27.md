# L1 design: Storage Give with item search, and volume and stack data for every item

**Status:** Revised twice on 2026-11-27 (after the Layer 1 audit, then reduced in scope) | **Issues:** #390
(scope), #439 (volume and stack data), related #419 (volume error), #145 (volumes)

## 1. Problem

The operator wants to put any item into a container. Base Inventory Give takes only resources and components. The
Storage tab's Give already takes any catalog item (`POST /api/storage/{storageId}/give-item`), for the same box
types plus vehicle storage, but:

- the item has to be typed as an exact name or id;
- the quantity starts at 100;
- the console knows the volume of 99 of 2,582 catalog ids, so other items skip the volume limit, and
  `requireCompleteInventoryVolume()` then refuses every volume-tracked give into that container (#419);
- an item with no stack limit is written as ONE row holding the whole quantity (a stack of 3 rifles).

Separately, the Base Inventory item list had collapsed to the width of an item picture: the quantity input had no
width rule, so the global `input { width: 100% }` took the row (operator report with screenshot).

## 2. Operator decisions (2026-11-27)

1. Use the Storage tab's Give. Do **not** open up Base Inventory Give, and add **no** new permission. This replaces
   the earlier plan (open up Bases Give behind `bases:grant-any-item-type`).
2. Add a search box to the Storage tab.
3. Keep the slot and volume limits, and supply every item's volume and stack size.

## 3. Design

### 3.1 Data: `runtime/data/item-game-data.json` (new, fork-owned)

```
{ "source":   { "gameBuild", "read", "compositeTable", "tables": [...] },
  "volume":   { "<templateId>": <number >= 0> },    // 4,227 ids
  "maxStack": { "<templateId>": <integer >= 1> } }  // the same 4,227 ids
```

- Read from the installed game's item tables (build 26592269), merged in the order of the game's composite table.
  Built by `console/api/scripts/build-item-game-data.mjs` from table dumps. This replaces the copy from
  `tabr-tau`, which covered 4,210 ids; those values are identical.
- A separate file, not edits to `admin-items.json`: that file is shared with upstream and a 2,500-row edit would
  conflict on every sync. Identifiers and numbers only. Provenance, known limits and the operator's acceptance of
  the unrecorded licence position are in `item-game-data.PROVENANCE.md`; tests pin the counts.
- **Precedence:** a value curated in `admin-items.json` always wins. The new file only fills gaps.
- **Loader:** one module `itemGameData.js` (validate, cache by file stamp, case-insensitive). Both existing loaders
  read the file next to the `admin-items.json` they loaded. `duneDb.js` also consults it for templates that are
  not in the catalog. A missing or invalid file logs one warning and behaves like today.

### 3.2 Item stats

`augmentItemKindForTemplate()` guesses weapon or clothing from name keywords and misclassifies cosmetic tokens,
contract items, armor packs and an emote. It returns `other` for the categories `customizations`, `contracts`,
`consumables` and `emotes`. Affects Storage Give and player Give.

### 3.3 Web

- Storage tab: `ItemCatalogCombobox` over the whole catalog replaces the free-text field; the route receives
  `itemId`. Quantity starts at 1. Give and Fill are disabled until an item is chosen. The confirmation names the
  item and id. An item with no known volume shows a note saying it blocks later gives into that container.
- Shared picker (also Bases, whose filter is unchanged): every typed word matched against name and category, exact
  and prefix matches first, a line when results are cut off, one row per id, the id shown when name and category
  are shared, a failed load reported and retried, typed text kept when it replaces a selection.
- Layout: the search box has its own row on both tabs; quantity has a fixed width.

No route, permission, audit record or schema changes.

## 4. Behaviour changes for existing operators

| Path | Change |
|---|---|
| Storage tab Give | gear now has a volume: the container's volume limit applies, one slot per unit, and a container holding an item of unknown volume rejects it |
| Player Give (database path), Care Package and add-on database grants | a quantity above 1 of a non-stackable item becomes one row per unit, limited by free slots; a short delivery is reported |
| Container Add | quantity of a non-stackable item is clamped to 1 |
| Storage and Bases volume totals | gear now counts; a container already over its limit reports no room |
| Cosmetics, contracts, consumables, emotes | no weapon, clothing or durability stats |

No migration, no new setting. Existing rows are untouched.

## 5. Requirement 0, rollback, unverified

- Update path: additive data file; if absent, volume and stack limits behave as today.
- **Rollback:** delete the data file, or revert the change. Rows given as single units stay valid.
- **Not verified in game.** Before merge, on dune-dev per `runbooks/dune-dev-test-builds.md`: a weapon, a garment,
  a tool, a vehicle part, a schematic and a quantity above 1, then a Survival restart. Gear gets the durability
  Storage Give already writes today.

## 6. Out of scope and follow-ups

Opening up Base Inventory Give; grade and augment controls on the Storage tab; the 46 catalog ids the game does
not define; up to 1,000 single-row inserts under one lock; Container Add skipping the volume cap and able to write
outside the slot grid (existing); NPC and developer items not marked in pickers; `base-inventory.md` still saying
there is no Storage fill route.

## 7. Audit register

The Layer 1 audit (eight reviewers, no CRITICAL) reviewed the earlier, larger plan. What it found about parts that
remain:

| Sev | Finding | Disposition |
|---|---|---|
| HIGH | Two loaders find and cache data differently and can disagree | 3.1 sibling-file loader |
| HIGH | Rollback could leave containers unusable | 5 |
| HIGH | Existing tests encode today's behaviour | Tests updated in this change |
| HIGH | Gear stats unverified in game | 5: merge gate |
| HIGH | Result list too narrow to read | 3.3 layout |
| HIGH | Any holder of `storage:mutate` or `bases:add-item` can create any item | Existing access, unchanged; follow-up decision |
| MED | Data provenance and licence acceptance | 3.1 |
| MED | Behaviour-change list incomplete | 4 |
| MED | Picker search, load failure and labels | 3.3 |
| MED | Many single-row inserts under one lock; Container Add volume and slot gaps | Follow-ups, 6 |
| MED | Fake-database tests hide stacking changes | Real-PostgreSQL test added |
| MED | Older stack data could over-stack | Closed: both values now come from the current build |
| LOW | Unknown-volume items still block volume checks | Documented; 46 ids |

Findings about the new permission, the container Give rules and the Bases picker states no longer apply.

### STRIDE (reduced scope)

| Threat | Result |
|---|---|
| Spoofing, Elevation of privilege | No change to authentication, routes or permissions |
| Tampering | Data file validated on load; inserts parameterized |
| Repudiation | Unchanged: Storage Give is audited as before |
| Information disclosure | None: no new route or field |
| Denial of service | One slot per unit means more rows per give, bounded by slots and the 1,000-row limit |
