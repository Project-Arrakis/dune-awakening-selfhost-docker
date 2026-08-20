# Data Classification & Access Review

## Data Classification Tiers

| Tier | Label | Examples | Authorized Tiers | Audit Required |
|------|-------|----------|------------------|----------------|
| **O** | Operator-Secret | `ADMIN_PASSWORD`, `DISCORD_OAUTH_CLIENT_SECRET`, `DISCORD_BOT_HANDOFF_SECRET`, adapter bearer token | Owner (write only via config/env) | All access |
| **I** | Identity-Binding | `console.discord_account_links` (Discord user ID ↔ character), `dune.accounts.platform_id` (SteamID64) | Admin, Owner (read); self-scoped for Player tier | All reads + writes |
| **G** | Game-State | Player inventories, positions, guild rosters, base locations, landsraad data, storage contents | Read: all tiers (scoped for Player). Write: Admin, Owner (moderator: limited) | All writes |

## Access Review Cadence

Guild role → tier mappings (`guild_roles` table) are the single source of truth for console access. They must be reviewed:

- **Quarterly**: Audit all tier assignments. Verify each role mapped to `admin` or `owner` still belongs to a trusted operator.
- **On personnel change**: Immediately remove or downgrade tier assignments for departed staff.
- **Audit endpoint**: `GET /api/settings/iam/role-audit` (planned) will return all guild_roles mappings with timestamps.

## RTO/RPO for Linking System

The `console.discord_account_links` and `console.discord_player_links` tables reside in the Postgres `console` schema. They are covered by the existing `pg_dump` backup pipeline. RTO/RPO follow the game database's recovery window.

## Audit Requirements

- All link/unlink/verify operations: audited (H2 #171, deployed 2026-08-07)
- All game-state-modifying endpoints: audit planned (#177)
- IAM policy changes: audit planned
