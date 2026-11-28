# Where `item-game-data.json` comes from

Unit volume (`volume`) and stack limit (`maxStack`, the most of an item one slot holds) for 4,227 item template
ids: every item in the game's item tables. The file holds the game's identifiers and numbers only: no names, text,
images or code. It is read by `console/api/src/itemGameData.js`. A value curated in `admin-items.json` always wins
over this file.

## Source

| | |
|---|---|
| Source | The installed game's content files, read-only. Nothing in the game or in a save is changed |
| Game build | `26592269` (the Steam manifest `appmanifest_1172710.acf`) |
| Read | 2026-11-27 |
| Tables | The 20 `DT_BaseItems_*` tables listed by the composite table `CDT_BaseItems` |
| Volume | `StaticData.ItemSize` (`ItemSizeOverride` when it is 0 or more; no row had one) |
| Stack limit | `StackAndDurability.MaxStackSize` |

17 ids appear in two tables with different values (`Thumper`, `Stilltent`, `RespawnBeacon`, `D_Turret`, `D_Totem`,
the seismic probes and thumpers, three Halloween 2026 clothing variants). As in the game, the table listed later in
`CDT_BaseItems` wins: the weapon row for the first group, the cosmetic row for the clothing variants.

As a check, the 4,210 ids that <https://github.com/Project-Arrakis/tabr-tau> had extracted separately (game build
26083551 for volume, 20502675 for stack limits) have exactly the same values here.

## Known limits

- 46 ids listed in `admin-items.json` have no row in these tables, so they have no volume or stack limit: one
  building-set patent (`MTX_Neut_DesertMechanicSet02_Patent`) and 45 clothing rows whose catalog names are
  placeholders or belong to unreleased sets.
- Curated values in `admin-items.json` differ from the file in five places and still win: the volume of
  `T2MuaddibComponent`, `T4ShieldWallComponent` and `ExperimentalWindTurbineComponent` (catalog 1, game 0.1), the
  stack limit of `T2MuaddibComponent` (catalog 1, game 500), and the volume of `FuelCanister_Medium` (catalog
  3.3333333, file 3.3333). The last one is rounding only: the build script rounds every volume to 4 decimals.
- A game update can change the tables. Items added later are unknown until the file is refreshed.
- No licence or terms-of-service position on these numbers is recorded. The game and its data belong to Funcom;
  this project is unofficial. The operator of this fork accepted using the numbers (2026-11-27). The file is not
  covered by this project's licence; see [`NOTICE`](../../NOTICE).

## Refreshing

Dump the composite table `CDT_BaseItems` and every table it lists to JSON with a reader of the game's content files
(not part of this repository), one file per table, then run:

```bash
node console/api/scripts/build-item-game-data.mjs <dump dir> <game build> <read date YYYY-MM-DD>
```

Update this file and the counts pinned in `console/api/test/itemGameData.test.js` in the same pull request.

The console re-reads this file and `admin-items.json` when either changes; no restart is needed. `dune update`
replaces both with the shipped versions, so a local edit or deletion does not survive an update.
