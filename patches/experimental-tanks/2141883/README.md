# Regis Tanks: 2141883 Experimental Build

The r6.4 candidate limits module-ID compatibility to Tank-prefixed module names.
Ordinary vehicle modules execute the original native ID instructions. Tank
initialization branches and all four cooked packages remain as in v1.4.47.
The same Scout failed storage on that release's blanket zero-ID patch but passed
with native IDs restored. Restoring native IDs for Tanks caused a driving crash;
removing initialization compatibility produced incomplete Tanks. Neither failed
candidate is used here. Local gameplay testing confirmed Scout backup and
restoration both work with this patch enabled, and driving the tested Tank did
not crash the client. This verifies the reported local regression, not every
preset or full gameplay compatibility on other servers or future builds.
The runtime verifies the official base image, complete original executable,
seven replacement byte ranges, complete patched executable and all cooked assets.
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
matching does not prove gameplay compatibility. The reproducible binary builder
uses `source/scoped_module_ids.py` and GNU binutils to assemble three guarded
detours and a shared predicate in reviewed executable padding after a return.
The native FName pool decoder layout is also byte-guarded against this build.
No game function is called by the predicate; scratch registers and input flags
are preserved before executing the Tank or native instruction sequence.
`tests/test_tank_scoped_module_ids.py` executes all three generated paths against
a synthetic name pool, verifies ID values, registers, flags and the displaced
serialization store, and checks the manifest matches the compiled instructions.

Required local acceptance: login, both backup tools including relog, six Tank
presets, driving and weapon effects/audio, module management and saved persistence.
Known issues: the Dart firing effect can appear pink and its firing sound is
missing. The supplied client sound bank references an unresolved audio object;
the pink effect's cause remains unconfirmed. Client HUD warnings also reference
missing Tank generator and locomotion item rows. Reported Tank-enabled login
crashes are not confirmed resolved. No client patch is included or required.
The existing backup, rollback and Hagga-only switch are unchanged.
