# Live Map: enabling the POI and resource-field layers

**Status:** Current, pending live-deployment confirmation | **Last Updated:** August 2026

The Live Map's POI and resource-field marker layers (points of interest like
Caves and Ecolabs, plus spice/flour-sand fields) are **opt-in** and require a
one-time, manual database step. Every other Live Map layer (players, vehicles,
bases, storage) works with no setup.

## Why this is manual

These two layers deliberately read through a separate, more-restricted
PostgreSQL role — one that can only `SELECT` from `dune.markers` and
`dune.resourcefield_state`, never write anything — rather than the console's
own full-privilege admin connection. Provisioning a new database role
requires elevated Postgres access the console itself doesn't have and
shouldn't be given just to bootstrap this. See issue #468 for the full design
reasoning.

**Nothing else about your console requires this.** If you skip this step,
the POI/resource layers simply stay absent from the Live Map — every other
feature, including the rest of the Live Map, is completely unaffected.

## One-time setup

Run this once, as a Postgres superuser (the same access you'd use for any
other one-time database administration on this deployment):

```sql
CREATE ROLE dune_map_readonly LOGIN PASSWORD '<choose-a-strong-password>';
GRANT SELECT ON dune.markers, dune.resourcefield_state TO dune_map_readonly;
```

Then store the password where the console expects it, matching this repo's
existing `runtime/secrets/` convention:

```bash
echo '<the-password-you-chose>' > runtime/secrets/map-readonly-db-password.txt
chmod 600 runtime/secrets/map-readonly-db-password.txt
```

Restart the console (`dune restart` or your usual restart command) to pick up
the new credential. The POI and resource-field layers appear on the Live Map
on the next load — no other configuration is needed. If the role name or
database host/port differ from your default setup, override them with the
`DUNE_MAP_DB_USER` / `DUNE_DB_HOST` / `DUNE_DB_PORT` environment variables
(the same host/port the console's main database connection already uses).

## Rotating the credential

There is no automated rotation. To rotate manually:

```sql
ALTER ROLE dune_map_readonly PASSWORD '<new-password>';
```

Then update `runtime/secrets/map-readonly-db-password.txt` with the new value
and restart the console.

## Upgrading from an earlier version

If you're updating an existing deployment, this feature is entirely additive
and safe to skip. Nothing changes for your current setup until you
deliberately run the one-time step above.
