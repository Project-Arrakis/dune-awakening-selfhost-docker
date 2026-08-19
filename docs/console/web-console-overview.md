# Web Console Overview

**Status:** Current | **Last Updated:** August 2026

Complete guide to the Dune: Awakening Docker Console web interface — your admin dashboard for managing everything from players to maps to backups.

## Accessing the Console

The console is available at:
```
http://YOUR_SERVER_IP:8088
```

Or, if you're on the same machine:
```
http://localhost:8088
```

### Login

1. Enter your admin username and password
2. Note: The console requires HTTPS in production (via reverse proxy)

See [Authentication & IAM](../console-iam.md) for permission details.

## Dashboard Overview

The **Dashboard** is your server's command center:

- **Server Status** — Running/Stopped, uptime, current player count
- **Performance Metrics** — CPU, memory, disk usage
- **Quick Actions** — Start/stop server, trigger backups, restart services
- **Alerts** — Any active warnings or issues
- **Recent Activity Log** — Latest game events and admin actions

## Main Sections

### 1. Players

**Path:** Players → Player List

Manage your player community:

- **Active Players** — Online now, with character names and playtime
- **All Players** — Complete roster with join dates and last seen
- **Player Details** — Inventory, permissions, character progression
- **Admin Actions** — Kick, ban, warn, reset character (with confirmation)
- **Roles & Permissions** — Assign admin, moderator, or custom roles

For detailed player management, see [Player Management](player-management.md).

### 2. Maps

**Path:** Maps → Map Management

Control your game world:

- **Active Maps** — Currently running and loaded
- **Map Settings** — Per-map difficulty, PvP/PvE mode
- **Deep Desert Layout** — Configure zone distributions
- **Sietches** — Manage player bases and structures
- **Map Readiness** — Verify all zones are initialized

For advanced map operations, see [Map Management](map-management.md).

### 3. Bases & Resources

**Path:** Bases → Base List

Manage player-built structures:

- **Base Overview** — Owner, location, resource status
- **Base Inventory** — Stored items and containers
- **Permissions** — Who can build/modify each base
- **Backup/Restore** — Pick up bases, restore deleted bases
- **Deletion** — Permanently delete or queue for cleanup

For detailed operations, see:
- [Base Management](base-management.md)
- [Base Inventory](base-inventory.md)
- [Base Permissions](base-permissions.md)

### 4. Systems & Game State

**Path:** Systems → Various

Configure game systems:

- **Blueprints** — Manage known recipes and grants
- **Exchange** — View market board listings
- **Specializations** — Character skill systems
- **Progression** — Leveling curves and milestones
- **Economy** — Resource balance and prices

For details, see individual guides like [Blueprints](blueprints.md) and [Exchange](exchange.md).

### 5. Database & Backups

**Path:** Settings → Backups

Protect your world:

- **Automatic Backups** — Enable/disable daily backups
- **Backup Schedule** — Choose backup time
- **Backup List** — All existing backups with sizes
- **Manual Backup** — Trigger an immediate backup
- **Restore** — Restore from a previous backup
- **Retention Policy** — Auto-delete old backups

For detailed backup procedures, see [Database Backups](database-backups.md).

### 6. Settings & Configuration

**Path:** Settings → [Section]

Server configuration:

- **General Settings** — Server name, description, player count
- **Game Settings** — Difficulty, PvP mode, map rotations
- **Network Settings** — Public IP, ports, region
- **Security** — Login attempts, rate limiting, token rotation
- **Addon Management** — Installed addons and permissions
- **Logs & Diagnostics** — View and export system logs

## Common Workflows

### Restart Your Server

```
1. Dashboard → Quick Actions → Restart Server
2. Wait for countdown message in-game
3. Server restarts gracefully
4. Players rejoin after restart
```

See [Restart Queue](restart-queue.md) for details.

### Create a Manual Backup

```
1. Settings → Backups → Create Backup
2. Name your backup (auto-timestamped)
3. Wait for completion
4. Verify in Backup List
```

### Manage Player Inventory

```
1. Players → [Player Name]
2. Click "View Inventory"
3. See all owned items and storage contents
4. Optionally grant items or clear inventory
```

### Monitor Server Health

```
1. Dashboard → Metrics
2. Check CPU, memory, disk usage
3. Monitor network throughput
4. View database query performance
```

## Advanced Features

### Role-Based Access Control (RBAC)

Not all admins need all permissions. Set granular access:

- **Server Admin** — Full access
- **Moderator** — Player management, kick/ban
- **Content Manager** — Map and system configuration
- **Support** — View-only access for troubleshooting

See [Console IAM](../console-iam.md) for the full permission model.

### Addon Integration

Installed addons add tabs to the console:

- **Item Grants** — Admin-granted items system
- **Scheduled Jobs** — Market bot and seasonal events
- **Hardware Status** — System health monitoring

See [Addon System](../addons/addon-overview.md) for more.

### Logs & Diagnostics

**Path:** Settings → Logs

Access comprehensive logs:

- **Application Logs** — Console API and web errors
- **Game Logs** — Server activity, player actions, events
- **System Logs** — Container health, resource usage
- **Security Logs** — Admin actions, login attempts, token usage

Export logs for external analysis or archival.

## Performance Tips

1. **Use Search** — Large player lists? Use the search bar to find players quickly
2. **Batch Operations** — Select multiple players for bulk actions (kick, ban)
3. **Scheduled Backups** — Backups run at night when server load is lower
4. **Archive Logs** — Export old logs to reduce database size

## Troubleshooting

### Console Won't Load

1. Check the console container: `docker ps | grep console`
2. View logs: `docker logs dune-console-api`
3. Restart console: `docker restart dune-console-api`

### Slow Dashboard Load

1. Reduce active player filters
2. Clear browser cache (Ctrl+Shift+Delete)
3. Check server resource usage: `docker stats`

### Admin Actions Fail

1. Verify your permission level
2. Check the audit log for errors
3. Ensure the game server is running

### Can't Find a Player

Use the search box in Players. Search by:
- Username
- Character name
- Unique player ID

## Next Steps

- **[Player Management](player-management.md)** — Detailed player administration
- **[Map Management](map-management.md)** — World configuration
- **[Console API Reference](API-REFERENCE.md)** — REST API endpoints
- **[Security & Permissions](../console-iam.md)** — Access control details

---

**Need help?** Check the [Troubleshooting Guide](../integrations/discord-integration/troubleshooting.md) or [FAQ](../integrations/discord-integration/faq.md).
