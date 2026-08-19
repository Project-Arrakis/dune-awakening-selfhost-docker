# Base Management

**Status:** Current | **Last Updated:** August 2026

Complete guide to managing player bases through the web console.

This section covers the end-to-end lifecycle of bases: creation, modification, backup, restoration, and deletion.

## Related Documentation

- [Base Backups](base-backups.md) — Console implementation of base backup/restore
- [Base Inventory](base-inventory.md) — Managing stored items in bases
- [Base Permissions](base-permissions.md) — Base ownership and sharing
- [Base Deletion](base-deletion.md) — Permanent base removal and cleanup

## Bases Overview

A base is any player-built structure complex on your map. Bases include:

- **Sietch (Main Base)** — The player's primary settlement
- **Outposts** — Secondary structures and camps
- **Refineries** — Processing facilities
- **Defensive Structures** — Walls, defense systems

## Viewing Your Bases

Access base management via:

**Path:** Bases → Base List

The list shows:

- **Base Name** — Player-assigned name
- **Owner** — Primary builder/owner
- **Location** — Map and coordinates
- **Status** — Active, inactive, or pending deletion
- **Size** — Number of structures
- **Last Modified** — When last changed

Filter by:
- Owner name
- Map
- Status
- Location zone

## Base Details & Operations

Click any base to view:

### Overview Tab

- **Owner** — Primary owner and co-owners
- **Location** — Exact coordinates
- **Created** — Timestamp of first structure
- **Last Activity** — Recent modifications
- **Active** — Whether base is loaded/active
- **Permissions** — Who can build/modify

### Structures Tab

View all structures in the base:

- Building type and placement
- Build date
- Durability/condition
- Connected structures

### Inventory Tab

See [Base Inventory](base-inventory.md) for details on stored items.

### Permissions Tab

See [Base Permissions](base-permissions.md) for details on ownership and access.

### Backup/Restore Tab

See [Base Backups](base-backups.md) for backup operations.

## Admin Actions

### Edit Base Settings

Change:
- Base name
- Public/private status
- Permissions (who can modify)

```
Bases → [Base] → Settings → Edit
```

### Backup a Base

Create a snapshot:

```
Bases → [Base] → Backup/Restore → Create Backup
```

See [Base Backups](base-backups.md).

### Restore a Base

Restore from a previous state:

```
Bases → [Base] → Backup/Restore → Restore from Backup
```

### Pick Up a Base

Temporarily store a base (removes it from the map):

```
Bases → [Base] → Actions → Pick Up Base
```

The base is preserved and can be dropped elsewhere or restored later.

### Delete a Base

Permanently remove a base:

```
Bases → [Base] → Actions → Delete Base
```

See [Base Deletion](base-deletion.md) for the full deletion workflow and safety features.

## Common Scenarios

### Base Griefing / Cleanup

If a base is causing problems:

1. Review the ownership and permissions
2. Consider picking up the base first (reversible)
3. If permanent removal is needed, delete per [Base Deletion](base-deletion.md)

### Stuck Players

If a player can't build or modify their base:

1. Check base permissions
2. Verify no critical structures are damaged
3. Check server/map is running normally
4. See [Troubleshooting](../integrations/discord-integration/troubleshooting.md)

### Base Corruption

If a base shows unusual behavior:

1. Create a backup before any changes
2. Try restoring from a known-good backup
3. Contact support with the backup details

## Performance Considerations

- **Active bases** are loaded in memory; too many can slow the server
- **Inactive bases** (no recent activity) are unloaded to save memory
- Use admin tools to clean up abandoned bases periodically

See [Memory Guidance](../../README.md#memory--cpu-guidance) for server sizing.

## Related Guides

- [Base Backups](base-backups.md)
- [Base Inventory](base-inventory.md)
- [Base Permissions](base-permissions.md)
- [Base Deletion](base-deletion.md)
- [Player Management](player-management.md)

---

**Need help?** See the [FAQ](../integrations/discord-integration/faq.md) or [Troubleshooting](../integrations/discord-integration/troubleshooting.md).
