# Dune Console Discord API Adapter Contract

## Purpose

The Discord API Adapter is the protected server-side boundary between the Discord companion bot and Dune Docker Console.

The original adapter scope was read-only:

- Server status.
- Readiness.
- Services.
- Population.
- Logs.
- Map state.
- Backup list/latest metadata.

**This is no longer the full picture.** A second, separate mechanism -- the
**write bridge** (`write/preview` and `write/execute`) -- now lets the bot
trigger a fixed, explicit set of real server mutations (player kick/ban,
care package grants, map spawn/despawn, server restart/stop, etc.), gated by
its own independent authentication, capability, and per-action tier checks.
See [Write Bridge (Hop A / Hop B)](#write-bridge-hop-a--hop-b) below. Every
requirement in this section and the "Explicitly Forbidden" list below still
applies in full to the *read-only* routes; where the write bridge
intentionally does something those sections forbid, that is called out
explicitly rather than left as a silent contradiction.

The bot must not call broad WebUI routes directly. It must call adapter routes that understand Discord actor context and enforce capability policy server-side. This applies equally to the write bridge: `write/execute` never talks to a WebUI route directly, it always reuses the same real, already-existing mutation route the WebUI itself calls (see "No Parallel Implementation" below).

## Design Requirements

1. The bot authenticates with a dedicated Dune bot API token, not the WebUI admin password.
2. Every request includes Discord actor context.
3. Every route enforces server-side capability authorization.
4. Public-safe responses must not expose internal IPs, SSH hosts, DB URLs, tokens, raw `.env`, stack traces, host paths, or backup filesystem paths.
5. The read-only routes listed above expose read-only data only; the write bridge is a deliberate, separate, explicitly-scoped exception (see below), not a loosening of this rule.
6. No destructive, write, credential, Docker lifecycle, database mutation, backup mutation, player mutation, addon mutation, or map mutation routes are in scope for the *read-only* adapter routes above. The write bridge's own fixed action table is the only sanctioned way any of these happen through Discord.
7. The adapter reuses existing Dune Console backend functions rather than duplicating privileged logic inside the bot. The write bridge follows this exact same rule (see "No Parallel Implementation").

## Explicitly Forbidden in Experimental Scope

**The items below describe the original, read-only-only adapter.** A subset (backup create, player kick/mutation, broadcasts, map mutations) is now possible **only** through the write bridge's own fixed action table, own authentication, and own per-action tier gate -- never through any of the read-only routes this section otherwise still fully governs. Anything not in the write bridge's `WRITE_ACTION_MIN_TIER` table (see below) remains forbidden exactly as written here.

1. Docker socket access from the bot.
2. Direct Postgres access from the bot.
3. Direct Postgres writes from any bot flow.
4. Backup create, restore, delete, import, or delete-all.
5. Player grants, kicks, teleport, refills, resets, or inventory mutation.
6. Broadcasts and shutdown broadcasts.
7. Map, sietch, or deep desert mutations.
8. Addon install, enable, disable, or remove.
9. Secret-setting workflows.
10. Any destructive action.

## Authentication

### Header

```http
Authorization: Bearer <dune-bot-api-token>
```

The token must be loaded by the bot from `DUNE_BOT_API_TOKEN_FILE` and validated server-side by the adapter.

### Rejected Patterns

- WebUI admin password as bot token.
- Discord bot token as Dune API token.
- Browser session cookie as bot auth.
- Query-string token.

## Required Actor Context

Every bot request must include a Discord actor context object.

```json
{
  "actor": {
    "guildId": "123456789",
    "channelId": "234567890",
    "userId": "345678901",
    "username": "admin-user",
    "roleIds": ["456789012"],
    "interactionId": "567890123",
    "commandName": "/dune status"
  }
}
```

## Role Tiers

| Tier | Intended Use |
| --- | --- |
| public | Basic non-sensitive status only. |
| observer | Low-risk status/readiness visibility. |
| moderator | Population, map state, backup metadata, and limited operational visibility. |
| admin | Logs and diagnostic read-only visibility. |
| owner | Reserved for future review; no owner-only write routes in experimental scope. |

## Experimental Capability Model

| Capability | Description | Minimum Tier |
| --- | --- | --- |
| `status:read` | Basic health/status visibility | public |
| `readiness:read` | Readiness checks | observer |
| `services:read` | Service list/status | observer |
| `population:read` | Population summary and online count | moderator |
| `logs:read` | Capped, redacted service logs | admin |
| `maps:read` | Map, sietch, and deep desert read-only status | moderator |
| `backups:read` | Backup list/latest metadata | moderator |

## Response Classification

| Class | Description | Allowed Fields |
| --- | --- | --- |
| public | Safe in public Discord channels. | High-level status, no internal topology. |
| moderator | Safe for moderator/admin channels. | Population and operational metadata with sensitive values removed. |
| admin | Safe only in admin channels or ephemeral admin responses. | Capped logs and diagnostics, always redacted. |

## Initial Adapter Routes

### `GET /api/integrations/discord/health`

Purpose: bot connectivity check.

Capability: `status:read`.

Response:

```json
{
  "ok": true,
  "service": "dune-console-discord-adapter",
  "experimental": true,
  "readOnly": true
}
```

`readOnly: true` describes this health-check route and the rest of the routes in this section, not the adapter as a whole -- see [Write Bridge (Hop A / Hop B)](#write-bridge-hop-a--hop-b) for the separate mechanism that isn't.

### `POST /api/integrations/discord/status`

Purpose: sanitized stack status for Discord.

Capability: `status:read`.

### `POST /api/integrations/discord/readiness`

Purpose: readiness checks.

Capability: `readiness:read`.

### `POST /api/integrations/discord/services`

Purpose: service list and service status summary.

Capability: `services:read`.

Requirement: service names must come from an allowlist or backend-safe source.

### `POST /api/integrations/discord/population`

Purpose: population summary and online player count.

Capability: `population:read`.

Requirement: public output should be count-only unless detailed output is explicitly role-gated.

### `POST /api/integrations/discord/logs`

Purpose: capped, redacted service logs.

Capability: `logs:read`.

Requirements:

1. Service name validation.
2. Line limit.
3. Redaction.
4. Admin-channel or ephemeral response recommended.
5. No raw `.env`, tokens, DB URLs, host paths, or stack traces.

### `POST /api/integrations/discord/map-state`

Purpose: map, sietch, and deep desert read-only state.

Capability: `maps:read`.

### `POST /api/integrations/discord/backups/list`

Purpose: backup list/latest metadata.

Capability: `backups:read`.

Requirements:

1. No backup restore/delete/import/delete-all. Backup *create* is possible, but only via the write bridge's `backup.create` action (owner tier), never through this read-only route.
2. No raw filesystem paths in public responses.
3. Output capped and paginated.

## Write Bridge (Hop A / Hop B)

Implements `write/preview` and `write/execute` under `/api/integrations/discord/`, a fixed, explicit set of real server mutations the bot can trigger -- separate from, and far more restricted than, the read-only routes above.

### No Parallel Implementation

`write/execute` never reimplements a mutation. It dispatches, over an internal loopback (Hop B, below), to Core's own existing, unmodified route handler for that exact action -- the same code path the WebUI itself calls. This means a mutation triggered from Discord is audited, validated, and executed identically to one triggered from the WebUI; the write bridge only decides *whether* that call is authorized, never *how* the mutation itself works.

### Hop A -- the incoming Discord-bot request

`write/preview` and `write/execute` each require, in order:

1. **Bot-token auth** (`requireDiscordBotToken` -- the same bearer token as every other adapter route).
2. **Actor-signature verification** (HMAC-SHA256, a second, distinct shared secret from the bot token -- see `DUNE_DISCORD_ACTOR_SECRET`/`DUNE_DISCORD_ACTOR_SECRET_FILE`). Required, not optional, for both routes: a request with a missing or invalid signature is rejected before anything else runs. Replay-protected via a timestamp header and a short freshness window (`DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS`, default 30s).
3. **Coarse capability gate** (`write-bridge:access`, granted from moderator tier up -- the floor for reaching *any* write action at all).
4. **Per-action minimum tier** (`WRITE_ACTION_MIN_TIER`, below) -- checked independently of the coarse capability gate, since Discord's own tier-to-capability mapping cannot by itself distinguish, say, `player.warn` (moderator) from `player.give-item` (owner).
5. **Fresh-role check**: the actor's role snapshot (`roleSnapshotAt`, part of the signed payload) must be no older than `DUNE_DISCORD_WRITE_BRIDGE_ROLE_MAX_AGE_SECONDS` (default 30s) -- a role grant/revocation on Discord takes effect within one command retry, not just at the bot's next full resync.

### The preview -> execute flow

`write/preview` validates all of the above, then creates a single-use nonce (`writeNonceStore.js`) bound to the specific `(actor, action, params)` tuple and returns it with a short human-readable preview (the action name and, where applicable, a `confirmPhrase`). Nothing is mutated by this call.

`write/execute` requires that exact nonce. On success, the nonce is immediately, atomically consumed -- a nonce can never be used twice, and a nonce for one action/params combination can never be replayed against a different one. Nonces expire after 60 seconds by default (shorter for lower-risk actions, longer for none) and are capped at 20 pending entries per actor (exceeding the cap returns a distinguishable `429 too_many_pending_confirmations`, never a generic error).

`confirmPhrase` (e.g. `"BAN PLAYER"`, `"CLEAN INVENTORY"`) is a UX safeguard the bot can surface before a user confirms -- it is never itself a security boundary. The real security boundary is the nonce + actor-signature + capability + per-action-tier stack above, identical regardless of whether an action has a confirmation phrase.

### Hop B -- the internal loopback

`write/execute`'s real dispatch happens over a Unix domain socket (mode 0700, refused entirely if the process is running as root), internal to the container/host -- never reachable over the network. This lets `write/execute` invoke Core's own real mutation route (e.g. `POST /api/players/:id/kick`) exactly as the WebUI would, through the exact same request-handling code (`requestHandler`, shared verbatim between the main TCP listener and this socket listener -- see "No Parallel Implementation" above).

The socket only starts when `DUNE_DISCORD_WRITES_ENABLED` is set; an operator who hasn't opted in gets zero new listening socket and zero change to any existing route's behavior. Two boot-time self-checks gate whether it starts at all:

1. Every entry in `WRITE_ACTION_ROUTES` (the action -> real-route mapping table) is checked against Core's own real route table (`actions.js`) -- an action whose declared `(method, path)` doesn't resolve to a real route, or whose declared policy action doesn't match Core's actual one, disables the whole write bridge rather than booting into a silently-wrong state.
2. For every `confirmPhrase`-bearing action, the real target handler is actually invoked (with a deliberately wrong confirmation) to confirm it rejects with the exact phrase this table declares.

If either check fails, or if the socket itself fails to start (a stale socket file, a live-listener collision), the write bridge disables itself and `write/execute` fails closed with a `503`, safety a normal request would already have gotten -- the rest of the console (including the read-only adapter routes above) is entirely unaffected.

### Per-action minimum tier (`WRITE_ACTION_MIN_TIER`)

| Action | Minimum tier | Confirmation phrase |
| --- | --- | --- |
| `player.kick` | admin | -- |
| `player.ban` | admin | BAN PLAYER |
| `player.unban` | admin | -- |
| `player.warn` | moderator | -- |
| `player.give-item` | owner | -- |
| `player.clear-backpack` | owner | CLEAN INVENTORY |
| `player.fill-water` | admin | -- |
| `base.refill-generators` | admin | -- |
| `base.refill-water` | admin | -- |
| `server.restart` | owner | -- |
| `server.stop` | owner | -- |
| `server.start` | admin | -- |
| `server.restart-service` | admin | -- |
| `map.spawn` | admin | SPAWN MAP |
| `map.despawn` | admin | DESPAWN MAP |
| `map.respawn` | admin | RESTART MAP |
| `map.teleport` | admin | -- |
| `carepackage.grant` | admin | GRANT CARE PACKAGE |
| `carepackage.grant-all` | owner | GRANT CARE PACKAGE TO ELIGIBLE PLAYERS |
| `carepackage.enable` | admin | ENABLE CARE PACKAGE |
| `carepackage.disable` | admin | DISABLE CARE PACKAGE |
| `carepackage.scan` | admin | RUN CARE PACKAGE SCAN |
| `carepackage.history-clear` | owner | CLEAR GRANT HISTORY |
| `guild.add` | admin | -- |
| `guild.remove` | admin | -- |
| `backup.create` | owner | -- |
| `updates.apply-game` | owner | -- |
| `updates.fix-steamcmd` | owner | -- |

`broadcast.*` is intentionally absent from this table -- it is gated by the existing, separate `broadcast:send` capability path instead, not the write bridge.

### Audit distinguishability

A write-bridge-triggered mutation's audit record is distinguishable from a real interactive WebUI session's (`type: "discord-write-bridge"` vs. `type: "session"`) -- an auditor can always tell "the owner personally clicked this" apart from "a Discord actor triggered it via the write bridge" without inferring it from the user ID's shape.

### Environment Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `DUNE_DISCORD_WRITES_ENABLED` | Master on/off switch for the entire write bridge. | off |
| `DUNE_DISCORD_ACTOR_SECRET` / `_FILE` | HMAC secret for actor-signature verification (required for `write/preview`/`write/execute`; both fail closed with `403 actor_signing_disabled` if unset). | none |
| `DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS` | Actor-signature freshness window. | 30 |
| `DUNE_DISCORD_WRITE_BRIDGE_ROLE_MAX_AGE_SECONDS` | Max age of the actor's signed role snapshot at `write/execute`. | 30 |
| `DUNE_DISCORD_WRITE_BRIDGE_TIMEOUT_MS` | Bound on Hop B's internal request, so a hung target handler can never leave an already-consumed nonce's outcome unresolved indefinitely. | 15000 |

## Audit Event Requirements

Every adapter request should be auditable. Read-only requests may use lower-risk audit records, but logs and detailed diagnostics should always be audited.

Required fields:

```json
{
  "source": "discord",
  "discordGuildId": "...",
  "discordChannelId": "...",
  "discordUserId": "...",
  "discordUsername": "...",
  "command": "/dune logs",
  "action": "logs.read",
  "capability": "logs:read",
  "risk": "low|medium",
  "targetType": "service|server|map|backup|population",
  "targetId": "...",
  "result": "success|failed|blocked"
}
```

## Error Contract

Errors must be redacted and safe to display.

```json
{
  "ok": false,
  "error": "Not authorized for logs:read.",
  "code": "not_authorized"
}
```

Forbidden in errors:

- Raw stack traces.
- Raw SQL errors containing secrets.
- Raw environment variables.
- Discord or Dune tokens.
- Internal DB URLs.
- Funcom token values.
- Internal IPs or SSH hosts.
- Raw host paths.

## DAST Requirements

The adapter must have runtime tests for:

1. Missing token rejected.
2. Invalid token rejected.
3. Missing actor rejected.
4. Unauthorized role rejected.
5. Public status sanitizes internal topology.
6. Diagnostic/log output requires admin capability.
7. Logs are capped and redacted.
8. The read-only routes above (health, status, readiness, services, population, logs, map-state, backups/list) never mutate anything and never resolve to a write-bridge action.
9. Every write-bridge action's `(method, path)` genuinely resolves to a real Core route, and a wrong `confirmPhrase` is genuinely rejected by the real target handler where mechanically checkable (`checkConfirmPhrasesAgainstRealHandlers`).
10. A nonce is single-use: replaying `write/execute` with the same nonce fails; a nonce for one action can never execute a different one.
11. An actor below an action's `WRITE_ACTION_MIN_TIER` is rejected at `write/preview`, `write/execute`, and independently at the Hop B boundary itself (three separate checks, not one relied on by the others).
12. Exceeding the per-actor pending-preview cap returns a distinguishable `429`, never a generic `500`.
13. Secret-like values are redacted from errors and audit details.
