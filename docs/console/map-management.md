# Map Management

**Status:** Current | **Last Updated:** August 2026

Complete guide to managing your Dune: Awakening game world maps through the web console.

## Accessing Map Management

**Path:** Maps → Map Management

Configure which maps are available, how many players can play them, and their difficulty settings.

## Map Types

Dune: Awakening features several map types:

### Main World (Arrakeen)

The primary exploration and PvP/PvE map. One per server.

- **Size:** Large open world
- **Players:** Can hold entire server population
- **Content:** All main game activities (exploration, harvesting, bases, combat)
- **Always-On:** Recommended (continuous gameplay)

### Story Maps

Single-player campaign maps. Instanced per player or shared.

- **Size:** Small to medium
- **Players:** 1-4 recommended
- **Content:** Main story progression and narrative
- **Optional:** Can be disabled if not needed

### Social Maps

Low-risk gathering and social hangout spaces.

- **Size:** Medium
- **Players:** 10-20
- **Content:** Trading, socializing, safe harvesting
- **Optional:** Can supplement main world

### Deep Desert (Dleta)

Advanced exploration and resource gathering zone.

- **Size:** Very large
- **Players:** 10-20
- **Content:** Rare resources, challenging mobs
- **Layout:** Customizable zone distributions

### Seasonal Maps

Limited-time or event-specific maps.

- **Size:** Varies
- **Players:** Varies
- **Content:** Seasonal events and challenges
- **Duration:** Time-limited (auto-disables)

## Map Settings

### Enable/Disable Maps

Toggle which maps are active:

```
Maps → Map Management → [Map] → Toggle Active
```

Disabled maps:
- Are not loaded into memory (save resources)
- Cannot be accessed by players
- Preserve all data for re-enabling

### Player Capacity

Set the maximum concurrent players per map:

```
Maps → Map Management → [Map] → Settings → Max Players
```

Higher = more servers, more memory. Start conservative:

| Map Type | Recommended |
|----------|------------|
| Main World | Server's max player count |
| Story Maps | 1-4 |
| Social Maps | 10-20 |
| Deep Desert | 10-20 |

### Difficulty Settings

Configure gameplay difficulty per map:

```
Maps → Map Management → [Map] → Difficulty → Configure
```

Options typically include:

- **Combat Difficulty** — Mob health, damage, aggression
- **Resource Scarcity** — How abundant resources are
- **Experience Rate** — How fast players level
- **Loot Quality** — Rarity and tier of drops
- **PvP Settings** — Enable/disable PvP, friendly fire

### PvP / PvE Mode

Toggle player-vs-player combat:

```
Maps → Map Management → [Map] → PvP Settings → Enable/Disable PvP
```

**PvE Mode:**
- Players cannot damage each other
- Bases have reduced durability loss
- Good for casual communities

**PvP Mode:**
- Full player combat enabled
- Bases can be raided
- Bases have normal durability rules

## Deep Desert Configuration

The Deep Desert (Dleta) has customizable zone layouts:

```
Maps → Deep Desert → Zone Layout → Configure
```

Options:

- **Zone Distribution** — Where different resource types spawn
- **Difficulty Zones** — Which zones are challenging vs casual
- **Supply Caches** — Random loot location frequency
- **Mob Patterns** — Enemy spawn locations and frequency

Tip: Reconfigure the Deep Desert layout monthly to keep the map fresh.

## Map Readiness & Health

Check if maps are fully loaded and working:

```
Maps → Map Readiness → View Report
```

Shows for each active map:

- **Status** — Loaded, loading, error
- **Zones Initialized** — Percentage of world loaded
- **Players** — Current count / capacity
- **Performance** — Server load, memory usage
- **Last Issues** — Any recent errors or warnings

### Common Issues

**Map won't load:**
- Check server resources (memory, disk)
- Restart the game server: `dune restart`
- Check logs: `dune logs -f game`

**Poor performance on a map:**
- Reduce max player count
- Disable always-on if possible (load on-demand)
- Check for corrupted data

**Players see errors on a map:**
- Note the error in bug reports
- Restart the affected map
- Check [Troubleshooting](../integrations/discord-integration/troubleshooting.md)

## Always-On vs On-Demand

Maps can be configured to load differently:

### Always-On Maps

- Continuously loaded and running
- Available 24/7
- High memory usage
- Best for: Main world, popular social areas

Enable:
```
Maps → [Map] → Settings → Always-On → Enable
```

### On-Demand Maps

- Loaded only when players join
- Unloaded when last player leaves
- Low memory usage
- Best for: Story maps, seasonal content

Enable:
```
Maps → [Map] → Settings → Load-on-Demand → Enable
```

## Map Rotation & Seasonal Content

### Rotating Maps

Set up a schedule to auto-enable/disable maps:

```
Maps → Map Rotation → Configure Schedule
```

Example:
- Weekdays: Main world + story map
- Weekends: Main world + social map + seasonal map
- Seasonal: Deep Desert always-on during "Deep Season"

### Seasonal Events

Enable limited-time maps for events:

```
Maps → Seasonal Content → Activate Season
→ Select season
→ Set end date
→ Confirm
```

Players receive event-specific rewards and cosmetics.

## Sietches & Player Bases

Manage Sietch (base) distribution per map:

```
Maps → [Map] → Sietches → Configure
```

Settings:

- **Max Sietches** — Maximum bases allowed
- **Safe Zone** — Starting area with reduced PvP/raiding
- **Territory Control** — Guild/clan regional ownership (if enabled)
- **Base Cleanup** — Auto-delete abandoned bases (optional)

## Monitoring & Analytics

### Map Traffic

See player activity per map:

```
Maps → Analytics → Map Traffic
```

Shows:
- Players per map (current and historical)
- Peak times
- Average session length
- Player distribution

Use this to balance map settings and always-on costs.

### Event Logs

View map-specific events:

```
Maps → Logs → [Map]
```

Includes:
- Player join/leave events
- Server crashes or warnings
- Map restarts or updates
- Notable in-game events

## Common Workflows

### Add a New Always-On Map

```
1. Maps → Manage Maps → Enable [Map]
2. Set Max Players to desired count
3. Configure Difficulty
4. Enable Always-On
5. Wait for Readiness Report to show "Loaded"
6. Announce to players
```

### Temporarily Disable a Map

```
1. Maps → [Map] → Disable
2. Active players are moved to another map
3. Map is unloaded (memory freed)
4. Can be re-enabled anytime
```

### Schedule a Seasonal Map

```
1. Maps → Seasonal Content → Activate Season
2. Select season and end date
3. Configure seasonal difficulty/rewards
4. Announce start date to community
5. Map auto-disables when season ends
```

## Best Practices

### Resource Management

- Start with 1-2 maps, add more as you grow
- Each map uses 4-8 GB RAM; monitor with `docker stats`
- Disable maps at off-peak times to free memory
- Use on-demand loading for supplementary maps

### Difficulty Balancing

- New servers: Set easier difficulty to retain new players
- Established servers: Adjust to match community skill
- Seasonal maps: Higher difficulty for challenge/variety
- Always offer multiple difficulty options

### Player Communication

- Announce map changes 24 hours in advance
- Explain why maps are enabled/disabled
- Gather feedback on difficulty and capacity
- Host map-specific events (seasonal challenges, treasure hunts)

## Related Guides

- [Web Console Overview](web-console-overview.md)
- [Sietches & Bases](base-management.md)
- [System Configuration](../console/API-REFERENCE.md#map-management)

---

**Need help?** See the [FAQ](../integrations/discord-integration/faq.md) or [Troubleshooting](../integrations/discord-integration/troubleshooting.md).
