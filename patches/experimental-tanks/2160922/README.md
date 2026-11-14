# Regis Tanks: 2160922 Experimental Build

Rebases the accepted 2156652 patch onto the exact official 2160922 image.
The tested r6.4 instruction generator is unchanged: only Tank module IDs use
the compatibility path. Ordinary vehicles keep native IDs, including the path
used for Ornithopter backup and restoration.

Independent old/new disassembly confirms that all three module-ID sites, both
initialization branches, the overlay-loader callback, FName decoder/pool layout,
and 231 bytes of executable padding retain their reviewed addresses and behavior.
The initialization field remains at 0xed0. Nearby string references changed,
so the executable is verified using its new exact hash, rather than assuming
that the unchanged patch addresses make the whole binary interchangeable.
The new image digest and config ID are pinned separately; older contracts are
unchanged and unknown builds remain unsupported. See `source/binary-site-review.json`.

All four stock overlay packages were independently extracted from 2156652 and
2160922 with checksum-verified retoc 0.1.5. All eight uasset/uexp files are
byte-identical. The overlay is reused unchanged; filenames retain their original
2141883 build number and every asset hash is verified. No shared item registry,
vehicle backup tool, or client file is modified. See `source/stock-asset-comparison.json`.

`source/scoped_module_ids.py <workspace>` consumes `server-2160922-clean` and
writes the candidate executable and generated manifest into that workspace.
Local in-game acceptance confirmed that Tanks work on 2160922. This does not
verify every preset, weapon, persistence scenario, or Ornithopter backup and
restoration on this build. The manifest retains candidate status and does not
claim full gameplay verification.

Known pink Dart firing effects and missing firing audio remain unresolved.
No client patch is included.
