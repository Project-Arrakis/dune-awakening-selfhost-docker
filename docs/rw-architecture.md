# RW Command Architecture — Discord Bot Write Operations

**Date:** 2026-08-08 (revised 2026-09-09)

**Status:** Layer 1 Design (Requirement 20)

**Audit:** Eight-Hat Layer 1 (round 1, 2026-08-08) filed 8 issues (#215-223). This
revision resolves #216/#217 in the design and gives #215/#222 a real technical
design for the first time (previously only sketched at protocol-sample depth);
#218/#221/#223 were already substantively reflected in this doc's text before
this revision but are called out explicitly below. A round-2 Eight-Hat Layer 1
audit against this revision is required before Layer 2 begins — the new
internal-credential mechanism, nonce store, and route-mapping table introduced
here are new attack surface the round-1 audit never saw.

## 0. Permanent Design Invariant: `player` Is Never An RW Tier

The console's own IAM (`policy.js`) has a `player` tier (own-record-scoped,
read-only console access — see the console-session design work this
revision's design doc process ran alongside). The Discord bot's RW tier
ladder in Section 1 below is a **separate, independent tier space**
(`public`/`observer`/`moderator`/`admin`/`owner` — see `discordActorTier()`
in `console/api/src/integrations/discord/policy.js`) that has never included
a `player` tier at all. This is not an oversight to fix — it is the design:
**the `player` console tier and any future Discord-side equivalent must never
be capable of any RW (write/mutate) action, under any circumstance.**
`CAPABILITY_BY_TIER["public"]`/`["observer"]` contain zero write capabilities
today, structurally, by construction — this invariant is enforced by the
absence of a mapping, not a runtime check, and any future change to
`policy.js` or `commandCatalog.js` that would grant a write capability to
`public`, `observer`, or a console `player`-tier-derived actor is a direct
violation of this invariant and must be rejected in review.

---

## 1. Architecture Overview

```
Discord User → Slash Command → Bot RBAC → Confirmation (if destructive)
  → Rate Limit → Adapter Client → POST /api/integrations/discord/write/preview
  → Core validates actor + capability → returns nonce
  → Bot displays confirmation embed → User clicks Confirm
  → POST /api/integrations/discord/write/execute with nonce
  → Core validates nonce (60s expiry) → calls real console API endpoint
  → Result → Audit → Discord embed
```

### Key Design Decisions

1. **Write adapter bridge** — All RW Discord commands target Core via `/api/integrations/discord/write/...`, never directly to console API endpoints. This ensures Discord actor signing + capability enforcement applies to every write operation.

2. **Two-phase confirmation** — Destructive operations use `write/preview` (validate authority + return impact preview) → user confirmation → `write/execute` (consume nonce + perform action). Nonce binds user identity, operation type, and parameters. 60s expiry prevents replay.

3. **Tier ladder** — Console capability tiers mapped to Discord roles via existing `discordActorTier()`:

| Discord Role | Capability Tier | Can do |
|-------------|----------------|--------|
| observer | `public` | RO only — no write commands |
| moderator | `moderator` | `player:warn` (map chat) |
| admin | `admin` | Most RW: player kick/ban, base refill, server start, map control, carepackage grant, guild add/remove |
| owner | `owner` | Destructive: server restart/stop, base destroy, guild delete, player inventory clear, give-item, grant-all, history clear |

4. **Master kill switch** — `DUNE_DISCORD_WRITES_ENABLED=1` (standardized per #217). All RW commands disabled when unset. Parsed identically by bot and Core.

---

## 2. Command Groups

### Group A: `player` — Player Management

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `kick <name> [reason]` | write/execute → `POST /api/players/.../kick` | `players:mutate` | admin | Yes (shows player name) |
| `ban <name> [reason]` | write/execute → `DELETE /api/players/.../ban` | `players:mutate` | admin | Yes (shows player name + reason) |
| `warn <name> <message>` | write/execute → `POST /api/admin/map-chat` | `admin:map-chat` | moderator | No (non-destructive) |
| `give-item <player> <item> [qty]` | write/execute → storage endpoint | `storage:mutate` | **owner** | Yes (shows item name, quantity, recipient) |
| `clear-backpack <player>` | write/execute → `POST /api/players/.../clean-inventory` | `players:mutate` | **owner** | Yes (requires typing character name) |
| `unban <player>` | write/execute → `DELETE /api/players/.../ban` | `players:mutate` | admin | Yes |
| `fill-water <player>` | write/execute → `POST /api/players/.../refill-water` | `players:mutate` | admin | No |

**Safety**: `give-item` requires item-type allowlist (no quest items, no admin-only flags), 1-stack-per-invocation cap, per-admin 10/day volume limit. `clear-backpack` requires typing the character name as the confirmation string, not just clicking a button.

### Group B: `base` — Base Management

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `refill generators <base>` | write/execute → `POST /api/bases/.../refill-generators` | `bases:mutate` | admin | Yes |
| `refill water <base>` | write/execute → `POST /api/bases/.../refill-water` | `bases:mutate` | admin | Yes |

**Note**: `destroy` deferred until Core `DELETE /api/bases/:id` endpoint is implemented (#216).

### Group C: `server` — Server Control

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `restart` | write/execute → `POST /api/server/restart` | `server:restart` | **owner** | Yes (shows live player count, 30s cancellable countdown, requires typing server name) |
| `stop` | write/execute → `POST /api/server/stop` | `server:stop` | **owner** | Yes (requires typing "STOP") |
| `start` | write/execute → `POST /api/server/start` | `server:start` | admin | No (non-destructive) |
| `restart-service <name>` | write/execute → `POST /api/server/restart-service` | `server:restart-service` | admin | Yes (shows affected service) |
| `maintenance on/off` | write/execute → config endpoint | `server:write-config` | admin | No |

**Safety**: `restart` and `stop` require confirmation phrases on Core (#223). Bot displays live player count in preview embed. 60s cooldown group. 30s cancellable countdown between confirm and execute. `stop` requires a second administrator to confirm (dual-confirmation gate).

### Group D: `map` — Map Control

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `spawn <preset>` | write/execute → `POST /api/maps/spawn` | `maps:spawn` | admin | Yes (shows preset, estimated resource usage) |
| `despawn <map>` | write/execute → `POST /api/maps/despawn` | `maps:despawn` | admin | Yes (shows connected players) |
| `respawn <map>` | write/execute → `POST /api/maps/respawn` | `maps:restart` | admin | Yes |
| `teleport <player> <map>` | write/execute → `POST /api/map/teleport-player` | `maps:teleport` | admin | Yes (shows player + destination) |

**Safety**: `spawn` checks available memory and port slots before confirming (#223). `despawn` warns about connected players. 15s cooldown group.

### Group E: `carepackage` — Care Packages

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `grant <player> <tier>` | write/execute → `POST /api/care-package/grant/:id` | `carepackage:grant` | admin | Yes (shows player + tier) |
| `grant-all` | write/execute → `POST /api/care-package/grant-eligible` | `carepackage:grant` | **owner** | Yes (shows eligible count) |
| `enable` | write/execute → `POST /api/care-package/enable` | `carepackage:write-config` | admin | No |
| `disable` | write/execute → `POST /api/care-package/disable` | `carepackage:write-config` | admin | No |
| `scan` | write/execute → `POST /api/care-package/run` | `carepackage:scan` | admin | No |
| `history clear` | write/execute → `POST /api/care-package/history/clear` | `carepackage:clear-history` | **owner** | Yes (requires typing "CLEAR HISTORY") |

### Group F: `broadcast` — Server Communications

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `broadcast <msg>` | `/api/integrations/discord/broadcast` | `admin:broadcast` | admin | Yes (shows message preview) |
| `broadcast-shutdown <msg> [mins]` | `/api/integrations/discord/broadcast` | `admin:broadcast-shutdown` | admin | Yes (shows message + countdown) |

**Safety**: 5s cooldown group. Message sanitized: max 500 chars, control characters stripped. Shutdown message must include a non-blank reason field. Core rate limit: 3 broadcasts per 5 minutes (#223).

### Group G: `guild` — Guild Management

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `add <player> <guild>` | write/execute → `POST /api/guilds/.../members` | `guilds:mutate` | admin | Yes |
| `remove <player>` | write/execute → `DELETE /api/guilds/.../members` | `guilds:mutate` | admin | Yes |

**Note**: `create` and `rename` deferred until Core `POST /api/guilds` and `PUT /api/guilds/:id` endpoints are implemented (#216).

---

## 3. Write Adapter Bridge (Must Be Built First)

The write adapter bridge is the critical path component. Without it, no RW command can ship.

### Core Side

```
POST /api/integrations/discord/write/preview
  Headers: X-Dune-Actor-Signature, X-Dune-Actor-Timestamp
  Body: { actor: {...}, action: "players:mutate", params: { playerName: "..." }, idempotencyKey: "uuid" }
  Response: { ok: true, nonce: "uuid", expiresAt: 1766249032, preview: { ... } }

POST /api/integrations/discord/write/execute
  Headers: X-Dune-Actor-Signature, X-Dune-Actor-Timestamp
  Body: { actor: {...}, nonce: "uuid", action: "players:mutate", params: {...}, idempotencyKey: "uuid" }
  Response: { ok: true, result: {...} }
```

**Security**: Both endpoints require `verifyActorSignature({ required: true })` + `requireDiscordCapability()`. Nonce is single-use with 60s expiry. Idempotency key prevents duplicate executions.

### 3.1 Dispatch mechanism: internal HTTP loopback, not a parallel implementation

`write/execute` must never reimplement what a real console route already does — every RW action's actual mutation logic (kick, restart, give-item, ...) already exists as a route handler in `server.js`, most delegating to `task()`/`confirmedTask()`. Those two functions are tightly coupled to real `req`/`res` (they read `req.authSession` for audit attribution, `req.socket.remoteAddress` for rate-limit keying, and some branches write directly to `res` — e.g. `maybeQueueRestart`). Reconstructing a synthetic `req`/`res` faithful enough for every one of the ~20 target routes is exactly the kind of "could this desynchronize from something I can't fully see" risk Strict Requirement 0 says to stop and flag, rather than one to walk into for a large win-nothing refactor.

Instead: `write/execute`, after validating the nonce, actor signature, and Discord capability, makes a **real internal HTTP request to Core's own real endpoint** (`http://127.0.0.1:<port><realPath>`, same process/host, never leaves the machine). This reuses every real route handler, `task()`, `evaluate()`, and `audit()` call completely unchanged — zero duplicated mutation logic anywhere, so a future fix to (say) the real kick endpoint can never silently fail to apply to the Discord path.

### 3.2 A third principal type: `discord-write-bridge`

`req.authSession` already supports two principal types in production — a browser session and an API key (`principalOf()` in `audit.js` discriminates on `req.authSession?.apiKeyId`). The bridge adds a third, following the identical pattern: the auth-resolution code that currently sets `req.authSession` from a cookie or an API key gains one more branch, recognizing the bridge's internal-only credential (below) and setting

```js
req.authSession = {
  source: "discord-write-bridge",
  tier: mappedTier,          // one of "moderator" | "admin" | "owner" -- see 3.3
  discordUserId: actor.userId,
  discordUsername: actor.username,
  apiKeyId: null
};
```

Every downstream consumer (`evaluate()`, `task()`, `audit()`, every route handler) reads `req.authSession` exactly as it does today — no new special-casing needed anywhere except this one auth-resolution branch.

### 3.3 Tier mapping: only moderator/admin/owner ever reach this far

The Discord bot's tier space (`DISCORD_ROLE_TIERS`) and the console's IAM tier space (`policy.js`'s tiers) are separate, but they share three tier *names*: `moderator`, `admin`, `owner`. Per Section 0's invariant, the Discord bot's `CAPABILITY_BY_TIER` grants zero write capabilities to `public`/`observer` — so `requireDiscordCapability()` already rejects any actor below `moderator` before `write/preview` ever returns a nonce. `mappedTier` in 3.2 is simply `discordActorTier(actor, mapping)`'s result, which by construction is always `moderator`/`admin`/`owner` by the time execution reaches the loopback — these are the exact tier names `evaluate()` already knows how to evaluate, so no translation table is needed.

### 3.4 Internal credential: in-memory only, never persisted

Because the loopback never leaves the host, there is no need for a `runtime/secrets/`-style persisted, rotatable credential (and inventing one would be new attack surface with no corresponding benefit — nothing outside this one Node process ever needs to present it). A single random token (`crypto.randomBytes(32)`) is generated once at server boot and held only in module-level memory, shared directly between the bridge's internal HTTP client and the new auth-resolution branch — nothing written to disk, nothing to rotate, invalidated automatically on every restart. Residual risk: another process on the same host with access to this Node process's memory could theoretically extract it, but that threat model already has full access to everything else this process protects (session secrets, DB credentials in memory) — no incremental exposure.

### 3.5 Route/action mapping table (resolves #216)

```js
// console/api/src/integrations/discord/writeActionRoutes.js
export const WRITE_ACTION_ROUTES = {
  "player.kick":          { method: "POST",   path: (p) => `/api/players/${encodeURIComponent(p.playerId)}/kick` },
  "player.ban":           { method: "DELETE", path: (p) => `/api/players/${encodeURIComponent(p.playerId)}/ban` },
  "player.unban":         { method: "DELETE", path: (p) => `/api/players/${encodeURIComponent(p.playerId)}/ban` },
  "player.warn":          { method: "POST",   path: () => `/api/admin/map-chat` },
  "player.give-item":     { method: "POST",   path: (p) => `/api/storage/${encodeURIComponent(p.playerId)}/give-item` },
  "player.clear-backpack":{ method: "POST",   path: (p) => `/api/players/${encodeURIComponent(p.playerId)}/clean-inventory` },
  "player.fill-water":    { method: "POST",   path: (p) => `/api/players/${encodeURIComponent(p.playerId)}/refill-water` },
  "base.refill-generators":{ method: "POST",  path: (p) => `/api/bases/${encodeURIComponent(p.baseId)}/refill-generators` },
  "base.refill-water":    { method: "POST",   path: (p) => `/api/bases/${encodeURIComponent(p.baseId)}/refill-water` },
  "server.restart":       { method: "POST",   path: () => `/api/server/restart` },
  "server.stop":          { method: "POST",   path: () => `/api/server/stop` },
  "server.start":         { method: "POST",   path: () => `/api/server/start` },
  "server.restart-service":{ method: "POST",  path: () => `/api/server/restart-service` },
  "server.maintenance":   { method: "POST",   path: () => `/api/server/maintenance` },
  "map.spawn":            { method: "POST",   path: () => `/api/maps/spawn` },
  "map.despawn":          { method: "POST",   path: () => `/api/maps/despawn` },
  "map.respawn":          { method: "POST",   path: () => `/api/maps/respawn` },
  "map.teleport":         { method: "POST",   path: () => `/api/map/teleport-player` },
  "carepackage.grant":    { method: "POST",   path: (p) => `/api/care-package/grant/${encodeURIComponent(p.playerId)}` },
  "carepackage.grant-all":{ method: "POST",   path: () => `/api/care-package/grant-eligible` },
  "carepackage.enable":   { method: "POST",   path: () => `/api/care-package/enable` },
  "carepackage.disable":  { method: "POST",   path: () => `/api/care-package/disable` },
  "carepackage.scan":     { method: "POST",   path: () => `/api/care-package/run` },
  "carepackage.history-clear":{ method: "POST", path: () => `/api/care-package/history/clear` },
  "broadcast.send":       { method: "POST",   path: () => `/api/integrations/discord/broadcast` },
  "broadcast.shutdown":   { method: "POST",   path: () => `/api/integrations/discord/broadcast` },
  "guild.add":            { method: "POST",   path: (p) => `/api/guilds/${encodeURIComponent(p.guildId)}/members` },
  "guild.remove":         { method: "DELETE", path: (p) => `/api/guilds/${encodeURIComponent(p.guildId)}/members` }
};
```

At startup, a self-check resolves every `path()` template against a representative param set and confirms the resulting `(method, path)` matches a real entry in `actions.js`'s `ROUTE_ACTIONS`/`REGEX_ACTIONS_BY_METHOD`/`REGEX_ACTIONS` — refusing to boot with a loud error if any entry has drifted (e.g. a real endpoint gets renamed and this table isn't updated in the same PR). This is the mechanical fix for exactly the class of bug #216 found by hand: the design document silently drifting from Core's real routes.

### 3.6 `GET /api/items` catalog endpoint (resolves #222)

A new read-only Core endpoint, `GET /api/items?q=<prefix>&limit=25`, added to `actions.js`'s `ROUTE_ACTIONS` as `"items:read"` (a new, low-risk read action — every tier that already has other `:read` grants gets it by default, since it exposes only item names/ids, no player data). Backed by a static item catalog (the game's own item definitions, already used elsewhere for `give-item`'s validation per #218's item-type allowlist — same source of truth, not a second copy) with a simple case-insensitive prefix match, capped at 25 results (Discord's own autocomplete choice limit) and required to respond within the bot's autocomplete 3s budget — an in-memory index built once at boot (item count is fixed and small relative to player/guild tables), not a per-request DB query.

### 3.7 `DUNE_DISCORD_WRITES_ENABLED` parsing (resolves #217)

Core keeps its existing `"1"` convention (`adapter.js`) as the canonical value — this is the convention #214 already established elsewhere in Core's config, and changing it would ripple into other already-shipped config reads. The bot's `writesEnabled()` (`writes.js`) is updated to accept **both** `"1"` and `"true"`, so an operator who set either value during the read-only/experimental period keeps working across this fix, rather than silently losing write-command availability on upgrade (Strict Requirement 0's update-path rule).

### 3.8 Error mapping and idempotency

Unchanged from the table in Section 4 below (`200`/`400`/`403`/`409`/`429`/`500`/`503`) — the loopback response's real HTTP status from Core's own endpoint is what the bridge maps through directly, since Approach A means the loopback response *is* the real endpoint's real response, not a translated summary of it.

**Nonce store**: an in-memory `Map<nonce, { actorUserId, action, params, expiresAt }>`, single-use (deleted on first consumption), 60s TTL — matches this codebase's existing precedent for short-lived confirmation state (the bot's own `writeConfirmation.js` confirmation-button Map, `restartQueue`'s in-memory entries). No new persistence layer; a server restart mid-confirmation simply expires the pending nonce, which is the correct behavior (the bot's own confirmation embed times out at 60s regardless).

**Idempotency cache**: a second in-memory `Map<idempotencyKey, { params, result, executedAt }>`, ~5 minute TTL. A retried `write/execute` with the same key and same params returns the cached result without re-invoking the loopback; same key with different params returns `409 "already executed"` per the existing error table.

### Bot Side

```
adapterClient.writePreview(actor, action, params, idempotencyKey)
adapterClient.writeExecute(actor, nonce, action, params, idempotencyKey)
```

**Existing pattern**: Uses the same `AdapterClient.request()` HTTP machinery. Nonce stored in confirmation state Map alongside the pending interaction.

---

## 4. Safety Model

### Confirmation Flow
```
1. User invokes slash command (e.g., /dune player kick Bob)
2. Bot validates actor + capability + rate limit
3. Bot calls write/preview → receives nonce + impact preview
4. Bot displays confirmation embed with Confirm/Cancel buttons (60s timeout)
5. User clicks Confirm
6. Bot calls write/execute with nonce
7. Bot displays result embed
```

Destructive tiers for each confirmation level:
- **None**: start, enable, disable, scan, maintenance
- **Button click**: kick, ban, warn, give-item, refill, restart-service, spawn, despawn, teleport, grant, broadcast
- **Type confirmation string**: server restart, server stop, clear-backpack, history clear, grant-all

### Rate Limits

| Scope | Limit | Window |
|-------|-------|--------|
| Per-actor global RW | 3 actions | 30s |
| player group | 5s | per-subcommand |
| base group | 10s | per-subcommand |
| server group | 60s | per-subcommand |
| map group | 15s | per-subcommand |
| carepackage group | 10s | per-subcommand |
| broadcast group | 5s | per-subcommand |
| Core server restart | 1 | per 5min |
| Core broadcast | 3 | per 5min |

### Idempotency

Every write command generates a `uuid` idempotency key. Core rejects duplicate keys with the same params (returns cached result). Core rejects duplicate keys with different params (409 "already executed"). This prevents accidental double-execution from network retries or impatient users.

### Errors

| Core HTTP | Bot Embed | Color |
|-----------|-----------|-------|
| 200 | "✅ Action completed" | success |
| 400 | "⚠️ Invalid parameters: {details}" | warning |
| 403 | "🔒 Not authorized for {action}" | error |
| 409 | "⚠️ Already executed" | warning |
| 429 | "⏱️ Rate limited. Retry in {s}s" | warning |
| 500 | "💥 Action failed: {details}" | error |
| 503 | "🔴 Adapter unavailable" | error |

---

## 5. What's Already Built vs What's Needed

### Core (dune-awakening-selfhost-docker)

| Component | Status | Issue |
|-----------|--------|-------|
| Write adapter bridge (preview + execute) | **DESIGNED** (Section 3, this revision) — not built | #215 |
| `WRITE_ACTION_ROUTES` mapping table + startup self-check against `actions.js` | **DESIGNED** — not built | #216 |
| Endpoint table corrections (unban/fill-water added, clear-backpack already correct) | **RESOLVED IN DESIGN** (this revision) | #216 |
| `guild:create` / `guild:rename` / `base:destroy` | **DEFERRED** (Section 7, unchanged) — no Core endpoint, out of scope this round | #216 |
| `GET /api/items` catalog endpoint (autocomplete) | **DESIGNED** (Section 3.6, this revision) — not built | #222 |
| Server restart/stop confirmation phrases | **ALREADY REFLECTED** in Group C's existing confirmation column (typed server name / "STOP" / dual-admin gate) — exact phrase wording (`"RESTART BATTLEGROUP"`/`"STOP BATTLEGROUP"` vs current) still an open call | #223 |
| `player:give-item` at owner tier + caps/allowlist | **ALREADY REFLECTED** in Group A row + Safety line | #218 |
| Cross-group global rate limit (3/30s) | **ALREADY REFLECTED** in Rate Limits table | #221 |
| `discordWritesEnabled` standardization | **RESOLVED IN DESIGN** (this revision, Section 3.7) — Core keeps `"1"`, bot accepts both `"1"` and `"true"` | #217 |
| Actor signing on all write adapter routes | **EXISTS** | #207 (verified) |

### Bot (arrakis-control-panel)

| Component | Status | Issue |
|-----------|--------|-------|
| Confirmation button flow | **EXISTS** (`writeConfirmation.js`) | — |
| Write command dispatch | **EXISTS** (`writeHandler.js`) | — |
| Item autocomplete | **NOT BUILT** | #222 |
| Per-group cooldowns | **NOT BUILT** | — |
| AdapterClient write methods | **NOT BUILT** | Depends on #215 |
| Parameter validation | **NOT BUILT** | — |
| Error format (embed-based) | **PARTIAL** (`format.js`) | — |

---

## 6. Test Strategy

### Layer 1: Unit Tests (per component)
- `validateWriteParams()` — control chars, SQL fragments, length limits, enum validation
- `writeCooldown.checkGroup()` — per-group keying, expiry, cross-group isolation
- `writeConfirmation.js` — all 7 button interaction states (already tested, extend for new destructive confirmations)
- `writeExecute()` / `writePreview()` — mock adapter returns fixture nonce/result

### Layer 2: Integration Tests
- Full lifecycle: slash command → preview nonce → confirmation → execute → result embed
- Nonce expiry (60s timeout) → bot shows "expired" embed
- Idempotency replay (same key, same params) → bot shows cached result
- Idempotency collision (same key, different params) → bot shows "already executed"
- All 6 error codes from the error table above

### Layer 3: End-to-End
- Real Core HTTP mock server with nonce store (extend `scripts/mock-adapter.js`)
- Bot-side Discord interaction mocks with button state machine
- Concurrency test: two simultaneous write commands serialize correctly

---

## 7. Not in Scope (Explicitly Deferred)

- `database:export` / `database:query` — raw SQL from Discord is too dangerous
- `updates:apply` — requires console UI visibility (downtime, rollback)
- `landsraad:*` — experimental, requires console context
- `sietches:write` / `deepdesert:write` — low-use, defer
- `addons:install` / `addons:update` — requires console UI
- `player:unban` — defer until Core `DELETE /api/players/:id/ban` is verified
- `guild:create` / `guild:rename` — defer until Core endpoints exist (#216)
- `base:destroy` — defer until Core endpoint exists (#216)

---

## 8. Related Issues

| # | Title | Hat | Severity |
|---|-------|-----|----------|
| 215 | Write adapter bridge must be built on Core | CloudSec | CRITICAL |
| 216 | 5 RW endpoints don't exist on Core | Architect | CRITICAL |
| 217 | DUNE_DISCORD_WRITES_ENABLED parse mismatch | CloudSec | HIGH |
| 218 | give-item at admin = economy destruction | Security | HIGH |
| 219 | grant-all at admin = server-wide injection | Security | HIGH |
| 220 | server restart + history-clear should be owner | Security | HIGH |
| 221 | No cross-group rate limit | Security | MEDIUM |
| 222 | No item autocomplete infrastructure | UI/Bot | HIGH |
| 223 | Server restart/stop lack confirmation phrases | Network | MEDIUM |
