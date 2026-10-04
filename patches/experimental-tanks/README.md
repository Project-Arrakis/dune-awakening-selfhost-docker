# Experimental Tanks

Opt-in, build-locked r5.8 patch for **Survival_1 (all Hagga Sietches)** only.
The official image remains unchanged. Other maps use their existing image policy.

Settings → Experimental Features → Regis Tanks applies the image and
restarts only running Hagga maps. It creates a database safety backup and copies
their Saved folders after stopping them. Failed applications restore the previous
image policy. The apply tool does not rewrite or delete player or vehicle rows;
the unpatched game can delete unsupported Tank records when loading them.

The six native Tank templates are offered only when enabled. Spawning requires
an online player in a ready Hagga partition running the exact prepared image.
Every template uses Tier 6 parts: Booster or Inventory with Dart, Rocket or Flame.

Disable before a game-server update. Disabling restores the official image and
removes Tank from the spawn catalog. Existing Tanks can be deleted by the game
without the patch; do not expect them to return after re-enabling. Never reuse these binary offsets on a new
build. A new patch needs revalidated assets, clean/patched hashes and gameplay tests.

The supplied cooked assets and six executable guards are from the user-provided
`tank-r5.8-docker-handoff.zip`. The manifest pins the base digest and all asset hashes.
No old Tank proxy, generic permissions patch, shields or non-Hagga patch is applied.
