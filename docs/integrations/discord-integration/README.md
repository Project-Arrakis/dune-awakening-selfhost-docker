# Discord Adapter — Setup and Configuration

**Status:** Current | **Last Updated:** July 2026

> **Which Discord docs do I want?** This folder (`discord-integration/`) is the
> **operator-facing** set — start here if you are setting up Discord on your server.
> The sibling folder [`discord-control-bot/`](../discord-control-bot/setup-guide.md) is
> the **internal** set: the adapter contract, command surface, and bot-side reference.
> The two overlap; where they disagree, this folder is the newer one.

The Dune Docker Console includes a built-in Discord adapter that lets you
connect a companion Discord bot for server monitoring and management.

## What the Adapter Does

The adapter exposes a set of API routes that a Discord bot (or any bearer-token
authenticated client) can call to get server status and data. It is:

- **Disabled by default** — must be explicitly enabled
- **Read-only** — all routes provide data, none modify the server
- **Bearer-token protected** — every request requires a shared secret token
- **Role-gated** — you can restrict which Discord roles can access which data

## Quick Enable (3 Steps)

### 1. Add Environment Variables

Add these to the console's `docker-compose.web.yml`:

```yaml
environment:
  DUNE_DISCORD_ADAPTER_ENABLED: "true"
  DUNE_BOT_API_TOKEN_FILE: /repo/runtime/secrets/bot-api-token.txt
  DISCORD_OBSERVER_ROLE_IDS: "role-id-1,role-id-2"
  DISCORD_ADMIN_ROLE_IDS: "role-id-1"
```

### 2. Create the Token File

```bash
mkdir -p runtime/secrets
echo -n "your-random-token-here" > runtime/secrets/bot-api-token.txt
chmod 600 runtime/secrets/bot-api-token.txt
```

### 3. Rebuild the Console

```bash
docker compose -f docker-compose.web.yml up -d --build redblink-dune-docker-console
```

## Verify It's Working

```bash
TOKEN=$(cat runtime/secrets/bot-api-token.txt)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8088/api/integrations/discord/health
```

Expected response:
```json
{
  "ok": true,
  "enabled": true,
  "readOnly": true,
  "writesEnabled": false,
  "routes": ["/api/integrations/discord/health", ...]
}
```

## Routes

| Route | Method | Description | Access |
|-------|--------|-------------|--------|
| `/api/integrations/discord/health` | GET | Adapter health and route listing | Public |
| `/api/integrations/discord/status` | POST | Server status with maps, containers, listeners | Observer |
| `/api/integrations/discord/readiness` | POST | Readiness checks (containers, ports, DB) | Observer |
| `/api/integrations/discord/services` | POST | Service container state | Observer |
| `/api/integrations/discord/population` | POST | Player count (aggregate only) | Observer |
| `/api/integrations/discord/version` | GET | Dune stack version | Observer |
| `/api/integrations/discord/servers` | POST | Game server partitions | Observer |
| `/api/integrations/discord/ports` | POST | Network port status | Observer |
| `/api/integrations/discord/db` | POST | Database health | Observer |

## RBAC Configuration

The adapter supports tiered role-based access. Configure these env vars:

| Variable | Description |
|----------|-------------|
| `DISCORD_OBSERVER_ROLE_IDS` | Can access all read-only routes |
| `DISCORD_ADMIN_ROLE_IDS` | Can access diagnostic mode on status/readiness |
| `DISCORD_MODERATOR_ROLE_IDS` | Can access population and map data |

Role IDs are comma-separated Discord role IDs (18-digit numbers). These must
match the roles configured on the Discord bot side.

## Security

- **Adapter is disabled by default** — no routes exposed until enabled
- **Bearer token required** — every request must include `Authorization: Bearer <token>`
- **Constant-time token comparison** — prevents timing attacks
- **Output sanitization** — removes internal IPs, credentials, connection strings
- **Read-only by default** — write operations (broadcasts, maintenance actions) require `DUNE_DISCORD_WRITES_ENABLED` set explicitly, in addition to the requesting user meeting the required role tier (see Authorization, below)

## Authorization

This adapter decides whether to honor every request using **its own**
`DISCORD_OBSERVER_ROLE_IDS`/`_MODERATOR_ROLE_IDS`/`_ADMIN_ROLE_IDS`/
`_OWNER_ROLE_IDS` — never the bot's own role configuration. The bot sends
the requesting Discord user's role IDs (tamper-proof, HMAC-signed when
`DUNE_DISCORD_ACTOR_SECRET` is configured); this console independently
decides what those role IDs mean. If you never configure these env vars,
every non-owner request is denied automatically (Owner is always real
Discord guild ownership, never a role) — this is the safe default, not a
bug, and requires no action if you only want the real server owner to
trigger privileged bot actions. If you want a bot-side Moderator/Admin to
actually be able to trigger privileged actions (not just see the command
in Discord), configure these same env vars here to match whatever role
IDs you gave the bot — nothing keeps the two in sync automatically. See
[`docs/operator-guide.md`](../../operator-guide.md)'s Discord integration
section and
[`docs/design/bot-console-authorization-l1-design-2026-09-07.md`](../../design/bot-console-authorization-l1-design-2026-09-07.md)
for the full reasoning.

## Companion Bot

This adapter is designed to work with the Discord bot, "Sahir Venn" —
hosted or self-hosted, see [mentat-link.darkdante.org](https://mentat-link.darkdante.org)
for setup instructions and its own User Guide/Admin Guide. Its full,
current command list (which changes over time) is always available live
at [mentat-link.darkdante.org/api/commands](https://mentat-link.darkdante.org/api/commands)
(the same endpoint the bot's own site uses to render its command
reference, so it can never drift from what the bot actually implements) —
this document intentionally does not hardcode a copy of that list.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Adapter returns 404 | `DUNE_DISCORD_ADAPTER_ENABLED` not set to `true` |
| Adapter returns 401 | Token mismatch between console and bot |
| Adapter returns 503 | Token file not found or empty |
| Status returns empty | Console can't reach Docker (check socket mount) |
| Write commands return 403 "Write operations are not enabled." | `DUNE_DISCORD_WRITES_ENABLED` not set |
| "not authorized" for a role the bot itself allows | This console's own `DISCORD_*_ROLE_IDS` don't include that role ID — see Authorization, above. Not configuring them at all means only the real Discord server owner is ever authorized, by design. |

## Sources

- [Bot site and setup guide](https://mentat-link.darkdante.org)
- [Live command reference](https://mentat-link.darkdante.org/api/commands)
- [Adapter Contract](../discord-control-bot/api-adapter-contract.md)
- [Discord Developer Portal](https://discord.com/developers/applications)
