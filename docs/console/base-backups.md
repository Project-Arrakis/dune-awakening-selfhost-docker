# Base backups (the game's "pick up base" tool)

**Status:** Current | **Last Updated:** August 2026

The game has its own base-backup tool: a player can "pick up" a placed base,
which unclaims it so it can later be redeployed elsewhere. This is entirely
separate from the console's [Base deletion](base-deletion.md) feature and from
the Backups page's database backups — it is a game mechanic the console only
needs to *recognize*, not one it drives.

## What picking up a base actually does in the database

Investigated directly against a live restored database by placing a test base,
recording its rows, picking it up, and diffing. Picking up a base does **not**
move, delete, or serialize any of its structural rows. It does exactly two
things:

- deletes the base's `dune.permission_actor` / `dune.permission_actor_rank`
  rows — the base becomes unclaimed;
- inserts a row into `dune.base_backups` (`id`, `player_id`, the base's old
  `actor_name` as `base_backup_name`) and one `dune.base_backup_linked_actors`
  row per actor that belonged to the base (the claim actor plus every
  placeable) linking it to that `base_backups.id`.

Every `dune.buildings` / `dune.building_instances` / `dune.placeables` row for
the base is left completely intact, at its original location, with the same
health and transform it had before. There is no "packed" or serialized
representation anywhere — not in a new `dune.items` row, not in the game's own
`BaseBackupTool` item (that item is just the tool itself; its `stats` carry
only durability/customization, never base data). Redeploying presumably
re-establishes a `permission_actor` claim over the same still-existing actor
ids rather than re-materializing anything from a stored blob, though that
direction (backup → redeploy) has not been directly observed the way pick-up
has.

One live observation from redeploying during this investigation: the base's
`permission_actor` row came back and its `base_backup_linked_actors` rows were
gone, i.e. the game does clean that table up on redeploy in at least this
case. The console's checks below still verify both signals rather than relying
on that alone (see the next section for why).

## Why the console excludes these from the Bases panel

Left unfiltered, a picked-up base still has every `buildings` /
`building_instances` / `placeables` row present, so it would show up in the
Bases panel exactly like a normal, ordinary base — just with a blank owner
column, since `GET /api/bases`'s owner resolution is already a `LEFT JOIN`.
There is nothing else distinguishing it at a glance.

`listBases` (`duneDb.js`) excludes a base only when **both** signals agree:

- it is unclaimed (no `dune.permission_actor` row for its claim actor), **and**
- its claim actor id appears in `dune.base_backup_linked_actors`.

Neither signal alone is used as the exclusion, deliberately:

- "unclaimed" alone would also hide a base that has no owner for some other,
  unrelated reason;
- "ever backup-linked" alone would risk hiding a base again after a legitimate
  redeploy, if some future case leaves its old linked-actor rows behind
  instead of cleaning them up the way the one case observed here did.

A base satisfying both is unambiguous. This exclusion is gated on
`dune.base_backup_linked_actors` existing at all (`tableExists`); on a schema
without it, `listBases` behaves exactly as it did before this feature.

## Mutation routes reject a backed-up base too

Hiding a base from the list only stops it from being reached through the
Bases panel's own UI. A direct route call — or a stale bookmarked base id from
before it was picked up — could still act on it. `duneDb.baseIsBackedUp(db,
baseId)` runs the identical unclaimed-AND-linked check for one base id, and
every base mutation route checks it before writing, the same way each already
checks the [pending-delete lock](base-deletion.md#irreversibility):

- `DELETE /api/bases/{baseId}` (delete)
- `POST /api/bases/{baseId}/refill-generators`
- `POST /api/bases/{baseId}/refill-water`
- `PUT /api/bases/{baseId}/permissions`
- `POST /api/bases/{baseId}/system-custodian`
- `POST /api/bases/{baseId}/auto-refill` and `.../auto-refill-water` (only
  when enabling — disabling is harmless and does not race anything)

Each responds **409** with `"This base was picked up into a backup and is no
longer claimed. It cannot be modified until the player redeploys it."` Reads
(inventory, water, export-as-blueprint) are not blocked — a picked-up base's
rows are still real data, and there is no destructive or race-prone reason to
hide it from a read the way there is for a write.
