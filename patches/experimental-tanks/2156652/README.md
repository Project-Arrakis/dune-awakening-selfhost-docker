# Regis Tanks: 2156652 Experimental Build

Rebases the locally accepted 2147284 Tank patch onto the exact 2156652 official
image. The tested r6.4 instruction generator is reused unchanged: only Tank
module IDs use the compatibility path; ordinary vehicles retain native IDs,
including the path needed for Ornithopter backup and restoration.

The three module-ID instructions, both initialization branches, overlay-loader
callback, FName pool and decoder, and 231 bytes of executable padding were
reviewed against the clean executable. The vehicle initialization field moved
from 0xeb8 to 0xed0 in this build; the reviewed branch still skips the same
initialization path. All manifest byte guards and image/executable hashes are
specific to this build. Unknown builds remain unsupported.

All four stock overlay packages were independently extracted from 2147284 and
2156652 using retoc 0.1.5. All eight uasset/uexp files are byte-identical, so the
tested overlay is reused without recooking or changing shared item registries
or vehicle backup tools. Asset filenames retain the original 2141883 number;
their exact hashes are verified at runtime. The comparison is recorded in
`source/stock-asset-comparison.json`.

`source/scoped_module_ids.py <workspace>` consumes `server-2156652-clean` and
writes the candidate executable and generated manifest into that workspace.
Native instruction regressions cover Tank and ordinary vehicle paths for this
build and the previous builds. Local in-game acceptance confirmed that the Tank
looks good on 2156652. This does not verify every preset, weapon, persistence
scenario or Ornithopter backup/restoration on this build; the manifest retains
candidate status and does not claim full gameplay verification.

Known pink Dart firing effects and missing firing audio remain unresolved.
No client patch is included.
