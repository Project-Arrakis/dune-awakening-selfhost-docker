# Regis Tanks: 2141883 Experimental Build

Local gameplay tests confirmed both backup tools and Tank spawning and interaction.
Full gameplay compatibility is not verified; do not present this as a complete fix.
The runtime verifies the official base image, complete original executable,
six replacement byte ranges, complete patched executable and all cooked assets.
Unknown game builds remain unsupported; the official image is never modified.

The overlay contains only DT_Tank_Modules, DT_VehicleTemplates,
DT_Buggy_Modules and BP_Tank_CHOAM. It deliberately does not replace
CDT_BaseItems, DT_BaseItems_Vehicles or DT_ItemTableBuildables. Native item
identities are retained; absent Tank generator and locomotion item references
use their existing Treadwheel donor identities. Confirm module management in game.

## Reproduction and Audit

`source/rebase_candidate.cjs <workspace>` consumes the matching exported stock
JSON under `server-2141883-legacy`, `CDT_BaseItems-2141883-rows.json`, and
`inputs/work/r5_4_templates.json` from the supplied source archive. It writes
four guarded JSON packages to `candidate-2141883-json`. Serialize with the supplied
TankAssetEditor (.NET 8), cook with retoc 0.1.5, then wrap the empty-index PAK
with the supplied dune_wrap_v11 tool. Retoc verification and a stock-plus-overlay
roundtrip matched all four final JSON packages before integration.

`source/candidate-asset-report.json` records the package and module changes.
`source/binary-site-candidates.json` records unique old/new instruction contexts.
The manifest holds every exact executable byte guard and final hash. Structural
matching does not prove that the six binary changes are safe in gameplay.

Required local acceptance: login, both backup tools including relog, six Tank
presets, driving and weapon effects/audio, module management and saved persistence.
Known issues: the Dart firing effect can appear pink and its firing sound is
missing. The supplied client sound bank references an unresolved audio object;
the pink effect's cause remains unconfirmed. Client HUD warnings also reference
missing Tank generator and locomotion item rows. Reported Tank-enabled login
crashes are not confirmed resolved. No client patch is included or required.
The existing backup, rollback and Hagga-only switch are unchanged.
