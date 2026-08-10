# Vehicle Permission Reset Compatibility Fix

This version-locked compatibility image addresses a Funcom server bug
where vehicles can show **No Access** after an in-process world reset. The reset
creates a new permission subsystem after the server's one-shot startup event has
already fired, leaving vehicle permissions uninitialized for that world.

The patch makes the new world's permission subsystem perform its normal database
initialization during world begin-play. It does not change vehicle ownership,
permissions, player data, or the database schema.

## Safety Model

- The official Funcom image and executable are never modified in place.
- The patcher accepts only the known executable SHA-256 embedded in `patch.py`.
- The exact original instruction bytes must also match.
- The result is a local derived image; no Funcom binary is stored in this repository.
- A Funcom update fails closed until the new executable is investigated separately.
- Removing the derived image returns the installation to the official image.

## Automatic Updates

The normal DuneDocker install/update flow automatically prepares and selects
the compatibility image when the newly installed Funcom executable is an exact
supported match. If that tag's image is already built, it is reused.

If Funcom publishes a changed or unsupported executable, the update continues
with the new official image. It never blocks the battlegroup from starting and
never keeps an older patched server image active under a newer Funcom tag.
Installations with an explicit `DUNE_GAME_SERVER_IMAGE` override are left alone.

Because the normal updater already recreates world-server containers, no
additional restart is required after that update finishes.

## Manual Controls

```bash
runtime/scripts/dune vehicle-fix build
```

Building manually does not restart the battlegroup. After validating the image,
select it for future game-server starts with:

```bash
runtime/scripts/dune vehicle-fix enable
```

The selection follows the currently installed Funcom tag. After an update, an
unsupported or not-yet-built compatibility image automatically falls back to
the new official Funcom game-server image. This avoids downtime and never
silently keeps an old game-server binary active. The binary patcher itself still
fails closed and will never modify an unknown executable.

Check or remove the local image with:

```bash
runtime/scripts/dune vehicle-fix status
runtime/scripts/dune vehicle-fix disable
runtime/scripts/dune vehicle-fix remove
```

`disable` is a persistent opt-out from automatic preparation. Running `enable`
selects the current supported image and opts the installation back in.

Changing the selected game-server image takes effect only when world-server
containers are recreated. Never recycle a map while players are connected.
