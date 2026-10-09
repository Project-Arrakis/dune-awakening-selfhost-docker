# Regis Tanks: 2147284 Experimental Build

This rebase preserves the tested 2141883 Tank initialization and Tank-only
module-ID compatibility. Ordinary vehicle IDs remain native to preserve Scout
backup and restoration. The executable hash, three native ID instructions,
two initialization branches, overlay callback, FName decoder and executable
padding were reviewed for this exact official build. Unknown builds still fail
closed, and the official image is not modified.

All four stock overlay inputs were independently extracted from both official
builds with retoc 0.1.5. Their uasset and uexp files are byte-identical. The tested
four-package overlay is therefore reused without recooking or changing its
contents. It does not replace shared item registries or vehicle backup tools.
Asset hashes remain verified at runtime.

`source/scoped_module_ids.py <workspace>` consumes `server-2147284-clean` and
reuses the previous build's instruction generator with this build's exact
addresses and byte guards. It writes the candidate executable and manifest to
the workspace. Native instruction regression tests execute both build contracts.

Local in-game acceptance confirmed working Tanks and Ornithopter backup and
restoration on this build. This verifies the tested local behavior, not every
preset, persistence scenario or other server. The feature remains experimental;
the manifest does not claim full gameplay verification. Known issues from
the previous build remain: pink Dart firing effects and missing firing audio.
No client patch is provided, and no resolution of those issues is claimed.
