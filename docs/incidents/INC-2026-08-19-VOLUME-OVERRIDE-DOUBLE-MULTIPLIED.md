# Incident Case Study: `volume_override` Convention Mismatch Caused In-Game Item Volumes to Display Inflated by a Factor of `stack_size`

**Incident ID:** INC-2026-08-19-001

**Date:** 2026-08-19

**Status:** Resolved (root cause proven; code fixed; data-repair script written; corrected
catalog data shipped).

**Scope:** A live data-integrity bug affecting every item ever inserted via the console's
Base Inventory "Give", "Give Multiple Items", and "Fill" actions (issue #347, PR #349) since
those features shipped. The mechanism is engine-behavior-dependent (the closed-source game
engine's own convention for `dune.items.volume_override`), so it plausibly applies to every
operator using these console actions on any fork that shares this Postgres schema — but it
was confirmed only on this host, via `dune-dev`'s live game client and independently
cross-checked against `dune.gaming.tools`.

## Summary

Every item inserted into `dune.items` by `giveItemToStorage`, `fillItemToStorage`, or
`giveMultipleItemsToStorage` stored `volume_override` as the stack's **total** volume
(`perUnitVolume * stackSize`). The live game engine, however, treats a non-null
`volume_override` as a **per-unit** value and multiplies it by `stack_size` itself when
computing the volume it displays. Storing the pre-multiplied total caused the engine to
multiply by `stack_size` a second time, inflating the displayed volume by a factor of
`stack_size`.

A real, live example: a 9540-unit Mouse Corpse stack correctly had `stack_size = 9540` and a
per-unit catalog volume of `5.0` (real total volume: `47700`). The console stored
`volume_override = 47700` (the total). The in-game tooltip displayed **455,057,984** —
matching `47700 * 9540` almost exactly (the small deviation is because the stack had ticked
down to 9539 by the time the database was checked, a few seconds after the in-game
observation). The operator independently confirmed the same inflated figure on
`dune.gaming.tools`, a third-party tool that reads the same live database.

**Root cause confirmed directly, not inferred:** `dune.item_audit_log` (an audit trigger
installed for the 2026-07-31 fill-visibility investigation, still active, scoped to
`inventory_id in (105, 106)`) shows that every genuinely in-game-created item row — items the
console never touched — always has `volume_override = NULL`. The engine only ever leaves
this column NULL for its own writes; a non-null value is exclusively a console-side
convention, and the engine's own multiply-by-`stack_size` display behavior for that column
was never independently verified against real in-game output before this convention was
first introduced (2026-07-31, `553dd4dc`) or later "corrected" to store the total
(2026-07-31, `a1ae11d4`) — that second commit's own stated rationale ("current_volume ...
silently undercounts every stack with quantity > 1") was true for the console's *own*
internal Postgres-side volume accounting, but the fix chosen (store the total) broke the
engine's own separate, real interpretation of the same column. Both problems existed; the
wrong one was fixed on the wrong side.

## Impact

- **Confirmed, live:** every item given/filled via the console's Storage tab (Give, Give
  Multiple, Fill) since issue #347 shipped displays an inflated volume in-game, scaling with
  `stack_size` — a single-unit give (`stack_size = 1`) shows correctly; a large stack shows
  wildly wrong (a 9540-unit stack showed ~455 million instead of ~47700).
- **Confirmed, cross-tool:** the same inflated figure was independently observed on
  `dune.gaming.tools`, a third-party tool reading the same live Postgres database — this is
  not a console-UI-only artifact, it is a real value stored in the shared database that any
  consumer of `dune.items.volume_override` will see.
- **Confirmed, silent:** the console reported every give/fill as successful with no error;
  nothing in the console's own UI surfaced the mismatch, since the console's own internal
  volume-used/remaining math (`baseInventory`, `baseContainerSlots`) summed `volume_override`
  directly and was internally self-consistent — the bug only became visible by comparing
  against the live game engine's own, differently-conventioned display.
- **Confirmed, catalog data:** the operator separately confirmed `runtime/data/admin-items.json`'s
  `MelangeSpice` (Spice Melange) per-unit volume entry (`1.0`) does not match the real in-game
  value (`0.2`) — a second, independent data-correctness issue found during the same
  investigation, unrelated to the multiplication bug but affecting the same feature's
  accuracy.
- **Not affected:** `giveItemToPlayer` (the Players tab's own give-item action) does not set
  `volume_override` at all — player inventories have no volume cap in this schema, so this
  function never touched the column. Not in scope for this incident.
- **Reviewed:** no permanent data loss or corruption — the stored total is a real, readable
  number, just wrong. No items were deleted, duplicated, or lost. The fix is a straightforward
  data correction (see Response below), not a recovery.

## Confirmed observations

- `dune.item_audit_log` query against every genuinely in-game-created item row in the
  audited inventories (`ScrapMetal` id `16825695`, `MelangeSpice` id `16994252`) shows
  `volume_override` is `NULL` at every INSERT and every subsequent UPDATE — the engine never
  writes a value there for its own rows.
- The same query against every console-inserted row in the same inventories shows a non-null
  `volume_override` equal to `perUnitVolume * stackSize` at insert time (e.g. `MelangeSpice`
  id `16906747`: `stack_size = 1000`, `volume_override = 1000`, i.e. `1.0 * 1000`; `Mouse_Corpse`
  id `16906750`: `stack_size = 9540`, `volume_override = 47700`, i.e. `5.0 * 9540`).
- `455,057,984 / 47700 = 9539.9997` — i.e. the in-game-displayed figure is `volume_override *
  stack_size` (the console's own already-multiplied total, multiplied again by the engine).
  The 0.0003 deviation from an exact `9540` is explained by the stack having ticked down to
  `9539` by the time the database was queried, seconds after the in-game screenshot.
- Verified the same multiplication pattern holds for every other console-inserted row present
  at investigation time (`MelangeSpice`/`T6RefinedResourceA` stacks of size 100 and 1000):
  each would display `volume_override * stack_size` in-game under the confirmed engine
  behavior, e.g. a `stack_size = 1000`, `volume_override = 1000` row would display
  `1,000,000` in-game against a real total volume of `1000`.
- Read-side sums in `baseInventory` (both the placeable and vehicle queries),
  `baseContainerListStorage`, and `baseContainerSlots` all summed `volume_override` directly
  (no multiplication), matching the write side's own "store the total" convention — internally
  self-consistent, and correct for the console's own displayed volume-used percentage, but
  disagreeing with the engine's real, separate convention the whole time.
- `giveItemToPlayer` does not insert `volume_override` at all (player inventories carry no
  `max_item_volume` cap in this schema) — confirmed out of scope by direct code read.

## Inferences and limits

- The engine's own convention (non-null `volume_override` is per-unit, multiplied by
  `stack_size` for display) is inferred from the arithmetic match (`47700 * 9540 ≈
  455,057,984`) and from every real engine-written row always leaving the column NULL. It was
  not independently verified by reading the engine's own (closed-source) source, since that
  is not available — but the arithmetic match across the confirmed data point, cross-checked
  against a second independent tool (`dune.gaming.tools`) reading the same database, is strong
  direct evidence, not mere inference.
- This incident does not establish what the engine does with `volume_override` for anything
  beyond display (e.g. whether it ever re-derives a stack's real volume-limit enforcement from
  it) — only the displayed-volume-tooltip behavior was directly observed.
- The catalog `MelangeSpice` volume correction (`1.0` -> `0.2`) is based on the operator's
  direct, confirmed in-game observation and is unrelated to the multiplication bug itself; it
  was not independently re-derived from any other source during this investigation.

## Response

**Code fix** (branch `feat/347-storage-container-actions`): `volume_override` is now stored as
the item's **per-unit** volume in all three write paths (`giveItemToStorage`,
`fillItemToStorage`, `giveMultipleItemsToStorage`). Every read-side sum
(`baseInventory` x2, `baseContainerListStorage`, `baseContainerSlots`) now multiplies
`volume_override * stack_size` to compute a row's real total contribution, matching the
engine's own convention. See `console/api/src/duneDb.js`'s "CORRECTED 2026-08-19" comments at
each of the affected call sites for the full per-function detail.

**Catalog data fix:** `runtime/data/admin-items.json`'s `MelangeSpice` entry corrected from
`volume: 1.0` to `volume: 0.2`, per the operator's direct in-game confirmation.

**Existing data repair:** a one-time repair script,
`console/api/scripts/repair-volume-override.mjs`, recomputes every existing non-null
`volume_override` row from the current catalog's per-unit value (rather than trying to reverse
whichever of several historical, inconsistent conventions produced the bad value — this repo's
own `duneDb.js` git history shows at least three different `volume_override` conventions across
`553dd4dc`, `a1ae11d4`, and this fix, so recomputing from the catalog directly is simpler and
more reliable than reverse-engineering each). Defaults to a dry run (prints every planned
change without writing); `--apply` writes the corrections in a single transaction. A row whose
`template_id` is no longer in the catalog is left untouched and reported separately, since
there is nothing safe to recompute it to.

**Tests:** every backend test asserting the old "store the total" convention
(`console/api/test/db.test.js`, `console/api/test/baseInventory.test.js`) was rewritten to
assert the corrected per-unit convention, including new assertions that the running-total SQL
multiplies by `stack_size`. Full backend suite (1479 tests) and frontend suite (451 tests) both
green after the fix; `tsc --noEmit` clean.

## Project follow-up

| Item | Current state |
|---|---|
| Fix the write-side convention in all three give/fill functions | **Resolved.** See code fix above. |
| Fix the read-side sums to match | **Resolved.** See code fix above. |
| Correct `MelangeSpice`'s catalog volume | **Resolved.** `runtime/data/admin-items.json` updated. |
| Repair existing bad `volume_override` rows on this host (`dune-dev`) | **Tracked, not yet run as of this writeup** — run `repair-volume-override.mjs --apply` inside the console container after this fix is deployed. |
| Audit the catalog for other per-unit volume values the operator has not yet independently confirmed | **Open.** Only `MelangeSpice` was specifically flagged as wrong; the rest of the catalog's `volume` field has not been independently re-verified against real in-game data. |
| Confirm whether `volume_override`'s per-unit convention holds for every item category (weapons, augmented gear, unique items), not just raw/refined resources | **Open.** All directly observed evidence in this incident involves raw/refined resources (`MelangeSpice`, `T6RefinedResourceA`, `Mouse_Corpse`, `ScrapMetal`) and a handful of older rows for other categories (`AluminiumBar`, weapons, clothing) whose historical `volume_override` values were not cross-checked in-game during this investigation. |

## Closure criteria (all met 2026-08-19)

- ~~The root cause is proven with direct, reproducible evidence, not inference~~ — **Done.**
  Audit-log NULL-vs-non-null comparison + exact arithmetic match + independent third-party
  tool cross-check.
- ~~The write-side and read-side code is corrected to match the engine's real convention~~ —
  **Done.** See code fix above.
- ~~A safe, reviewable path exists to correct already-affected data~~ — **Done.**
  `repair-volume-override.mjs`, dry-run by default.
- ~~All tests green before the change is considered shipped~~ — **Done.** Backend 1479/1479,
  frontend 451/451, `tsc` clean.

Investigation complete, root cause proven, code and catalog data fixed, data-repair script
written. **This incident is resolved for the code and catalog; the existing-data repair on
`dune-dev` itself is a tracked follow-up action to run after this fix deploys.**

## Addendum (2026-08-20): a related, second `volume_override` bug survived this fix

Found during post-merge review of upstream PR #182 (`giveItemToStorage`/
`giveItemToBaseContainer`/`fillItemToStorage`/`fillItemToBaseContainer`/
`giveMultipleItemsToBaseContainer`, tracked in
`yacketrj/dune-awakening-selfhost-docker#396`): the "Fix the write-side
convention" closure criterion above was correct for the bug this incident
investigated (total-vs-per-unit), but it did not cover a second, related
convention violation in the same insert sites -- an item with **no
catalogued volume at all** (not a wrong value; genuinely never had one) had
`volume_override` written as the number `0` instead of SQL `NULL`. Per this
incident's own root-cause finding (a genuinely in-game-created row always
has `volume_override = NULL`, meaning "use the engine's own catalog
volume"), storing `0` for an uncatalogued item causes the same class of
engine-display inaccuracy this incident fixed, just in the opposite
direction (0 instead of inflated), and was independently confirmed to also
under-count the console's own internal volume-capacity math for the same
rows (`resolvedItemUnitVolume` treats an explicit `0` as a real, known
value, not "unknown" -- it only falls back to catalog data for `NULL`).

Fixed alongside this addendum: all 5 insert sites now write `NULL` (via a
shared `volumeOverrideForInsert()` helper), and
`repair-volume-override.mjs` gained a second pass correcting existing rows
with `volume_override = 0` to `NULL` (no catalog lookup needed for this
pass -- the engine never itself writes a non-null override, so any stored
`0` is presumptively from this bug). **This addendum does not reopen this
incident's own closure criteria** (they were accurate for the bug
investigated here) -- it corrects the closure table's implicit claim of
"the write-side convention is now fully correct," which was not true until
this addendum's fix. See `#396` for the full fix and the rest of that
review's findings.
