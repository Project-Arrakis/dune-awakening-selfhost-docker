# Regis Tanks: 2162777 Experimental Build

Rebases the accepted 2160922 patch onto the exact official 2162777 image.
The tested r6.4 instruction generator is unchanged: only Tank module IDs use
the compatibility path. Ordinary vehicles retain native IDs, including the
path used for Ornithopter backup and restoration.

All three module-ID sites, both initialization branches, the overlay-loader
registration/callback, and the native FName decoder were independently reviewed
at their new addresses. The decoder still uses the same FName layout, with a
new pool and ready-flag address. The vehicle initialization field remains at
0xed0. The 231-byte executable padding moved separately from those functions;
the assembled detours and helper use the reviewed new addresses, not a uniform
offset applied to an old payload. Exact stock/patched hashes and the official
image/config digests are pinned. Older contracts remain unchanged and unknown
builds remain unsupported. See `source/binary-site-review.json`.

All four stock overlay packages were independently extracted from 2160922 and
2162777 using checksum-verified retoc 0.1.5. All eight uasset/uexp files are
byte-identical, so the overlay is reused unchanged. Its original 2141883
filenames are intentional and every asset hash is verified. No shared item
registry, vehicle backup tool, or client file is modified. See
`source/stock-asset-comparison.json`.

`source/scoped_module_ids.py <workspace>` consumes `server-2162777-clean` and
writes the candidate executable and generated manifest into that workspace.
Local in-game acceptance confirmed that Tanks work on 2162777. This does not
verify every preset, weapon, persistence scenario, or Ornithopter backup and
restoration on this build. The manifest retains candidate status and does not
claim full gameplay verification.

Known pink Dart firing effects and missing firing audio remain unresolved.
No client patch is included.
