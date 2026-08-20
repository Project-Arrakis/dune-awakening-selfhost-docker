# Incident Case Study: Give/Fill Can Race a Live In-Game Move for the Same `position_index`

**Incident ID:** INC-2026-08-19-002

**Date:** 2026-08-19

**Status:** Resolved for Give (mitigated); accepted, documented limitation for Fill (no mitigation
possible -- see Response below).

**Scope:** A real, confirmed collision risk in the Base Inventory tab's Give/Give Multiple/Fill
actions (issue #347) whenever an operator uses them against a container while its owning map stays
running. The mechanism is engine-behavior-dependent (the live game engine's own claim timing), so it
plausibly applies to every operator using these console actions on any fork that shares this Postgres
schema, but it was confirmed only on this host.

## Summary

The console's Give/Fill actions insert a new `dune.items` row at a chosen `position_index` inside an
existing container. The live game engine only reads/claims a container's rows from Postgres at server
startup (`INC-2026-07-31-001`), never mid-session -- but a player interacting with the same container
**in-game while the map is running** can move or add an item into that container at any time, and the
engine assigns that in-game action's `position_index` independently of whatever the console has
already inserted. If both land on the same slot, one of the two rows loses on the next restart.

**Confirmed directly, not inferred**, via `dune.item_audit_log` (the audit trigger installed for the
2026-07-31 investigation, still active, scoped to `inventory_id in (105, 106)`):

- The console filled container #78 (`inventory_id 105`, a Developer Storage Container) with 6 rows at
  `position_index` 0-5, all uncommitted/unclaimed by the engine at that point.
- The operator moved a pre-existing ScrapMetal stack (id `16825695`, already existing elsewhere, e.g.
  a backpack) into the same container in-game while the map stayed running. The audit log recorded
  this as an `UPDATE` (a move reassigns `inventory_id`/`position_index` on an existing row, it does
  not `INSERT` a new one) landing at `position_index = 0` -- directly colliding with the console's
  `MelangeSpice` row (`16906744`) already sitting there.
- On the next map restart (`dune-server-survival-1`, ~01:53-01:54 UTC), a single-timestamp claim burst
  (`2026-08-19 01:54:41.45909+00`) claimed 5 of the console's 6 rows but **never claimed** `16906744`
  (the MelangeSpice at slot 0) -- it remained permanently unclaimed/orphaned, still sharing
  `position_index = 0` with the now-claimed ScrapMetal, confirmed via direct `psql` query after the
  restart.

**Conclusion, directly answering the question that prompted this investigation** ("what happens if a
container is filled via console and someone adds an item to it in-game?"): the in-game add succeeds
immediately (the engine is oblivious to console-inserted rows), and on the next restart the console row
that lost the slot race is **permanently orphaned** -- never claimed, never usable in-game, though not
deleted or corrupted. The database itself stays consistent; the loss is purely "this specific row will
never become a real, usable in-game item."

## Impact

- **Confirmed, live:** a real collision was reproduced and traced end-to-end via the audit log (see
  Summary above). This is not theoretical.
- **Scope of the risk:** only reachable while a container's owning map is running and an operator
  Gives/Fills into the same container a player is actively interacting with at the same time. A
  container nobody is touching in-game, or a Give/Fill performed while the map is stopped, cannot
  collide this way at all (there is no live engine assignment to race against).
- **Not a data-integrity bug:** the orphaned row is not deleted, corrupted, or silently applied to the
  wrong item -- it is simply never claimed. This is a narrower, less severe failure mode than
  `INC-2026-08-19-001` (the `volume_override` bug), which corrupted every affected row's displayed
  value; this incident instead makes a specific row permanently inert.
- **Reviewed:** no player-facing impact beyond the specific give/fill that loses the race -- the
  player's own in-game action always succeeds untouched.

## Response

**Give and Give Multiple (mitigated):** per explicit operator direction, `giveItemToStorage` and
`giveMultipleItemsToStorage` now pick the **highest unused slot below `max_item_count`**
(`nextHighPositionIndex` in `console/api/src/duneDb.js`) instead of the lowest-next-free slot. In-game
additions/moves typically fill a container low-to-high (starting from `position_index` 0), so inserting
from the high end reduces -- does not eliminate -- the chance of landing on a slot the engine is about
to claim. A genuinely full or nearly-full container can still collide; this is a mitigation, not a
guarantee. Falls back to the pre-existing lowest-next-free convention when `max_item_count` is 0
(unknown/uncapped on this schema), since there is no known high end to start from in that case.
Verified directly against real Postgres (not just a mock): a real HTTP integration test proves a real
give-item call lands at the highest unused slot (44 of 45) rather than the lowest-next-free slot (2),
given two pre-existing rows at slots 0 and 1.

**Fill (not mitigated -- warning and documentation only):** per explicit operator direction, no code
mitigation was applied to `fillItemToStorage`. Fill is meant to top up a container toward its real
capacity -- the same low-to-high direction the engine already fills in -- so there is no meaningful
"far end" left to insert into once Fill has done its job; the high-end mitigation that helps Give does
not apply. The Base Inventory tab now shows an explicit warning above the Fill Container panel stating
this risk directly (`console/web/src/features/bases/BaseInventoryTab.tsx`), and this document is the
canonical writeup an operator or future session can be pointed to.

## Project follow-up

| Item | Current state |
|---|---|
| Mitigate the collision risk for Give/Give Multiple | **Resolved.** High-end `position_index` assignment, verified against real Postgres. |
| Mitigate the collision risk for Fill | **Not applicable, by design.** Per explicit operator direction: no mitigation exists that does not contradict Fill's own purpose (topping up toward capacity in the same direction the engine fills). Warning + documentation only. |
| Warn operators in the UI | **Resolved.** Fill-specific warning banner added above the Fill Container panel. |
| Determine whether the same risk applies to the standalone Storage tab's own Fill/Give actions | **Open.** Those routes (`storageGiveItemRoute`/`storageFillItemRoute`) share the same underlying `duneDb.js` functions this fix already covers for Give, but were not separately re-verified end-to-end for this specific incident. |

## Closure criteria

- ~~The collision mechanism is proven with direct, reproducible evidence, not inference~~ -- **Done.**
  `dune.item_audit_log` burst/collision evidence above.
- ~~Give/Give Multiple mitigate the risk~~ -- **Done.** High-end position assignment, tested against
  real Postgres.
- ~~Fill's risk is documented where an operator will find it~~ -- **Done.** In-UI warning banner + this
  document.
- ~~All tests green before the change is considered shipped~~ -- **Done.** Backend and frontend suites
  both green (see the PR/issue comment trail for exact counts at time of merge).

Investigation complete, Give/Give Multiple mitigated, Fill's risk documented as an accepted,
by-design limitation. **This incident is resolved.**
