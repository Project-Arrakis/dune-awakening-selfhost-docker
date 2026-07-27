# Generator fuel burn rates

`FUEL_BURN_SECONDS` in `console/api/src/duneDb.js` is a set of constants
measured directly from the live game server, not derived from static game
data. A game balance patch that changes a fuel's burn duration will make
these constants silently wrong until someone re-measures and updates them.

## Measured values (live DB, re-verified 2026-07-26)

| Building type | Burning fuel | Duration (s) | Generators observed |
|---|---|---|---|
| `Generator_Placeable` | `Oil` | 3600 | 65 |
| `Generator_Placeable` | `None` | 3600 | 4 |
| `Generator_Placeable` | `None` | n/a | 1 |
| `SpiceGenerator_Placeable` | `SpicedFuelCell` | 5400 | 1 |
| `WindTurbineDirectional_Placeable` | `WindTurbineLubricant2` | 5400 | 2 |
| `WindTurbineOmnidirectional_Placeable` | `WindTurbineLubricant1` | 3600 | 3 |
| `WindTurbineOmnidirectional_Placeable` | `None` | 3600 | 3 |

This re-run confirms all four `FUEL_BURN_SECONDS` values against the live
server, including spice: a `SpiceGenerator_Placeable` burning `SpicedFuelCell`
was observed at 5400s, matching the constant that was previously an
unverified inheritance rather than a direct measurement. Its building type
(`spicegenerator_placeable` lowercased) is present in the explicit allowlist
in `portalGeneratorFuel()`, so it is classified correctly. No constant needs
updating from this pass.

The one `Generator_Placeable`/`None` row with no duration is an idle
generator whose fuel-burning component has never been populated (nothing
has burned in it yet) — it contributes no stock either way and doesn't
affect `FUEL_BURN_SECONDS`.

The Console uses these durations to convert accepted fuel units currently
queued in each generator's inventory into a queued reserve. It deliberately
does not call that value an exact depletion countdown: the active burn marker
and its timestamps can remain stale after a restart or base load, so they do
not reliably prove whether a partially consumed unit is still active.

## Re-verification query

Run this against the live Postgres database after any game update that
might touch fuel burn rates:

```sql
select p.building_type,
       coalesce(nullif(state.fuel_state->'m_FuelBurningId'->>'Name', ''), 'None') as burning_fuel,
       (state.fuel_state->>'m_FuelBurningDuration')::numeric as duration_seconds,
       count(*) as generators
from dune.placeables p
left join lateral (
  select fe.components->'FFuelPoweredPlaceableComponent'->1 as fuel_state
  from dune.actor_fgl_entities afe
  join dune.fgl_entities fe on fe.entity_id = afe.entity_id
  where afe.actor_id = p.id
    and fe.components->'FFuelPoweredPlaceableComponent'->1 is not null
  limit 1
) state on true
where lower(p.building_type) like '%generator%' or lower(p.building_type) like '%turbine%'
group by 1, 2, 3
order by 1, 2;
```

If any `duration_seconds` value differs from what's in `FUEL_BURN_SECONDS`
for the corresponding fuel template, update the constant and re-run
`console/api`'s test suite.
