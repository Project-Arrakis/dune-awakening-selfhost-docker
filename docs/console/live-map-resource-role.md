# Live Map: enabling the POI and resource-field layers

**Status:** Current, verified live against a real deployment | **Last Updated:** August 2026

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
GRANT USAGE ON SCHEMA dune TO dune_map_readonly;
GRANT SELECT ON dune.markers, dune.resourcefield_state, dune.map_names, dune.world_partition TO dune_map_readonly;
```

`GRANT USAGE ON SCHEMA dune` is required — PostgreSQL refuses even a plain
existence check against a schema-qualified table without it, not just
writes. `dune.map_names` and `dune.world_partition` are needed too: POIs are
resolved by joining `dune.markers` to `dune.map_names`, and resource fields
resolve their partition by joining `dune.resourcefield_state` to
`dune.world_partition` — both real reads this role needs, confirmed by
actually running this against a live deployment (an earlier draft of this
doc listed only the two primary tables and failed with "permission denied"
on both counts until corrected here).

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

## Known limitation: resource-field partition scoping

Resource fields (Spice/Flour Sand) are matched to a specific server
partition/instance via a join that, on a real deployment, only resolves for
some rows — confirmed live against `dune-dev`, roughly half of DeepDesert's
resource fields matched a real partition and half fell back to this app's
"no real partition" sentinel (meaning they display regardless of which
partition is selected, rather than being scoped to one). This fails in the
safe direction — a field stays visible rather than disappearing — but the
underlying cause (what distinguishes the unmatched rows) is not yet
understood; see the comment above `liveMapResourceFields` in `duneDb.js` for
the technical detail. POIs are unaffected — they're deliberately global to
the map by design, not by fallback.

## Verified against

Live-tested against a real deployment (`dune-dev`, 2026-08-24): role
provisioning, the corrected grants above, and both marker sources returning
real data — 662 POIs and 22 resource fields on Hagga Basin, 34 POIs and 118
resource fields on Deep Desert, alongside real online players.
