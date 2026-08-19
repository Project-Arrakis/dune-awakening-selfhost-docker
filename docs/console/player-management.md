# Player Management

**Status:** Current | **Last Updated:** August 2026

Comprehensive guide to managing your player community through the web console.

## Accessing Player Management

**Path:** Players → Player List

The Player Management interface gives you full control over:
- Active player monitoring
- Player accounts and characters
- Admin roles and permissions
- Bans, kicks, and warnings
- Inventory management
- Character reset and recovery

## Player List Overview

The player list shows all accounts on your server:

- **Username** — Account name
- **Character Name** — In-game character
- **Status** — Online/Offline
- **Join Date** — Account creation date
- **Last Seen** — Last login time
- **Playtime** — Total hours played
- **Level/Tier** — Character progression

### Filters & Search

Find specific players:

- **Search** — By username or character name
- **Status** — Online, offline, inactive (7+ days)
- **Role** — Admin, moderator, player
- **Tier** — Character progression level
- **Join Date** — By registration date

## Player Details

Click any player to open their profile:

### Account Tab

- **Username** — Unique account identifier
- **Email** — Associated email address
- **Created** — Account creation date
- **Last Login** — Most recent session
- **Total Playtime** — Hours on server
- **Linked Discord** — Discord account link (if set up)

### Character Tab

- **Character Name** — In-game name
- **Level** — Current character level
- **Experience** — Progress to next level
- **Skills** — Learned specializations
- **Inventory** — Equipped and backpack items
- **Location** — Current map and coordinates

### Inventory Tab

View character inventory:

- **Equipped Items** — Armor, weapons, tools
- **Backpack** — Stored items
- **Capacity** — Used vs total slots
- **Item Details** — Stats, durability, mods

Admin can:
- Grant items
- Remove items
- Clear entire inventory
- Reset to starting gear

See [Base Inventory](base-inventory.md) for base-stored items.

### Bases Tab

All bases owned by the player:

- Base location and status
- Co-owners and permissions
- Structure count
- Last activity

Click to jump to base management.

### Permissions Tab

Set player's admin role:

- **Player** — No special permissions
- **Moderator** — Can kick and warn other players
- **Content Manager** — Can modify maps and systems
- **Server Admin** — Full console access

See [Console IAM](../console-iam.md) for complete permission model.

### Activity Log

All actions by this player:

- Character actions (login, level up, item crafted)
- Admin actions taken on this player (kicked, banned, reset)
- Base modifications
- Trading activity

## Common Admin Actions

### Kick a Player

Disconnect an online player:

```
Players → [Player] → Actions → Kick
→ (Optional) reason message
→ Confirm
```

The player can immediately rejoin.

### Ban a Player

Prevent a player from joining:

```
Players → [Player] → Actions → Ban
→ Duration (temporary or permanent)
→ Reason
→ Confirm
```

Banned players cannot create new accounts.

### Warn a Player

Send an in-game warning (doesn't prevent play):

```
Players → [Player] → Actions → Warn
→ Message (appears in-game)
→ Confirm
```

### Reset Character

Clear a character's progression:

```
Players → [Player] → Character → Reset
→ Confirm deletion of skills/inventory
```

Player keeps their account and can restart progression.

### Grant Items

Give a player specific items:

```
Players → [Player] → Inventory → Grant Items
→ Select item and quantity
→ Confirm
```

See [Item Grants](../addons/addon-item-grants.md) for permission details.

### Clear Inventory

Remove all items from a character:

```
Players → [Player] → Inventory → Clear Inventory
→ Confirm deletion
```

### Unlock Character

If a character is stuck or locked:

```
Players → [Player] → Actions → Unlock Character
→ Confirm
```

## Multi-Player Operations

Select multiple players for bulk actions:

```
Players → (Check boxes) → Bulk Actions
→ Choose action (kick all, ban all, etc.)
→ Confirm
```

Useful for:
- Removing idle players before major updates
- Disconnecting everyone for maintenance

## Moderator Tools

**Available to:** Moderators, Admins

Moderators can:
- View all players and characters
- Kick disruptive players
- Issue warnings
- Report issues to admins
- Access activity logs

Cannot:
- Ban players (requires admin)
- Modify game systems
- Access console settings
- Create/delete admins

## Role Management

Configure which admins have which permissions:

**Path:** Settings → Admin Roles

Default roles:

| Role | Players | Kick | Ban | Reset | Grant Items | Modify Maps | Modify Settings |
|------|---------|------|-----|-------|-------------|-------------|-----------------|
| Server Admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Moderator | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Content Manager | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Support | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

Custom roles can be created per your needs.

## Account Recovery

### Lost Access

If an admin loses access:

1. Use another admin account
2. Go to Players → [Admin]
3. Click "Reset Admin Password"
4. Send new password securely (email, separate channel)

### Compromised Account

If an admin account is compromised:

1. **Immediately revoke access:**
   ```
   Players → [Admin] → Actions → Disable Account
   ```

2. **Change their password:**
   ```
   Players → [Admin] → Account → Reset Password
   ```

3. **Review their activity log:**
   ```
   Players → [Admin] → Activity Log
   ```

4. **Re-enable when secure:**
   ```
   Players → [Admin] → Account → Unlock/Re-enable
   ```

5. **Update server logs** if damage occurred

## Best Practices

### Admin Security

- Use strong passwords (20+ characters)
- Change passwords monthly
- Give each admin their own account (no shared logins)
- Revoke access for inactive admins
- Log all sensitive actions

### Community Management

- **Be transparent** — Explain kick/ban reasons
- **Be consistent** — Apply same rules to everyone
- **Document issues** — Keep notes on problem players
- **Give second chances** — Warn before banning
- **Communicate** — Use Discord or in-game announcements

### Monitoring

- Check daily for new players
- Review activity logs weekly
- Monitor playtime for engagement
- Track support requests
- Survey community regularly

## Related Guides

- [Console IAM](../console-iam.md) — Permission model details
- [Web Console Overview](web-console-overview.md) — General console use
- [Troubleshooting](../integrations/discord-integration/troubleshooting.md) — Common issues

---

**Need help?** See the [FAQ](../integrations/discord-integration/faq.md) or [Troubleshooting](../integrations/discord-integration/troubleshooting.md).
