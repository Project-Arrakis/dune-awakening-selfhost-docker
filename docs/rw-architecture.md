# RW Command Architecture — Discord Bot Write Operations

**Date:** 2026-08-08 (revised 2026-09-09, corrected same day after round-2 audit)

**Status:** Layer 1 Design (Requirement 20) — **NOT yet ready for Layer 2**

**Audit:** Eight-Hat Layer 1 round 1 (2026-08-08) filed #215-223. A first
2026-09-09 revision gave #215/#222 a real technical design and attempted to
resolve #216/#217, but a round-2 Eight-Hat Layer 1 audit against that revision
found it had **fundamental, independently-cross-corroborated flaws** — not
incremental gaps, but design errors that would have shipped a broken and
insecure feature: an internal credential with no verified binding to loopback
traffic and no scoping to the bridge's own routes (found by 4 of 8 hats), a
tier ladder that cannot actually be enforced by anything in the design (found
by 2 of 8 hats), and two real functional bugs already baked into the route
table (`ban`/`unban` inverted; `give-item` targeting the wrong Core endpoint —
found independently by 2 of 8 hats each). Filed as #728-737 and #740 (batched
low-severity findings); full findings and STRIDE report posted on #215. This
section of the doc, and every section below it, reflects the **corrected**
design after remediating all CRITICAL/HIGH findings from that round. A round-3
Eight-Hat Layer 1 audit against this corrected version is still required
before Layer 2 begins, per Requirement 20 — this correction pass was done by
the same session that ran round 2, not independently re-verified yet.

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

**Enforcement commitment (added after round-2 audit, GRC finding):** review
alone is not a sufficient backstop (Requirement 20's own rationale for
shifting audits left applies here too). Layer 2 implementation must extend
`console/api/test/discordPolicy.test.js` with a table-driven negative test —
for every entry in `WRITE_ACTION_ROUTES` (Section 3.5), assert
`requireDiscordCapability()` rejects `public` and `observer` tier actors, so
a future capability addition can't silently violate this invariant without a
test failing.

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

**Corrected after round-2 audit (was CRITICAL #729):** this table is a
*product* requirement, not something the console's existing IAM (`policy.js`)
or the Discord bot's own `CAPABILITY_BY_TIER` can enforce as-is — neither
system has the granularity to grant `kick` to admin while withholding
`give-item`/`clear-backpack` (both collapse to the single console action
`players:mutate`), and Discord's own `CAPABILITY_BY_TIER` computes `admin`
and `owner` as literally the same set. **This table's own rows are the source
of truth**, enforced by a new, independent `WRITE_ACTION_MIN_TIER` table
(Section 3.3a) that the bridge checks itself — not an assumption that either
existing IAM system already does this.

4. **Master kill switch** — `DUNE_DISCORD_WRITES_ENABLED=1` (standardized per #217). All RW commands disabled when unset. Parsed identically by bot and Core.

---

## 2. Command Groups

### Group A: `player` — Player Management

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `kick <name> [reason]` | write/execute → `POST /api/players/.../kick` | `players:mutate` | admin | Yes (shows player name) |
| `ban <name> [reason]` | write/execute → `DELETE /api/players/.../ban` | `players:mutate` | admin | Yes (shows player name + reason) |
| `warn <name> <message>` | write/execute → `POST /api/admin/map-chat` | `admin:map-chat` | moderator | No (non-destructive) |
| `give-item <player> <item> [qty]` | write/execute → `POST /api/players/.../give-item` | `players:mutate` | **owner** | Yes (shows item name, quantity, recipient) |
| `clear-backpack <player>` | write/execute → `POST /api/players/.../clean-inventory` | `players:mutate` | **owner** | Yes (requires typing the exact server-required phrase `"CLEAN INVENTORY"` — corrected after round-2 audit; the real endpoint does not accept the character name) |
| `unban <player>` | write/execute → `DELETE /api/players/.../ban` | `players:mutate` | admin | Yes (shows player name + original ban reason/date) |
| `fill-water <player>` | write/execute → `POST /api/players/.../refill-water` | `players:mutate` | admin | No (non-destructive) |

**Corrected after round-2 audit (was CRITICAL #730):** `give-item`'s adapter
endpoint was originally mapped to a *storage-container* route
(`POST /api/storage/:id/give-item`) instead of the real player-scoped grant
route — the id namespaces for storage containers and players are not
interchangeable. Fixed above and in Section 3.5's route table.

**Safety**: `give-item` needs an item-type allowlist (no quest items, no
admin-only flags), a 1-stack-per-invocation cap, and a per-admin 10/day
volume limit — **these do not exist anywhere in this codebase today** (#218
is still open; corrected after round-2 audit found this doc had previously
implied they were already backed by an existing catalog reuse — they are
not). Building these is required before this command ships, tracked as part
of #218, not assumed done by this design. `clear-backpack` requires typing
the real server-required confirmation string, not the character name.

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

**Corrected after round-2 audit (was HIGH #732):** `maintenance on/off` is
**removed from this round** — no Core endpoint exists for it at all
(`grep` for "maintenance" in `server.js`/`actions.js` returns nothing). Moved
to Section 7 (deferred), matching the treatment of `guild:create`/
`guild:rename`/`base:destroy`.

**Safety**: `restart` and `stop` require confirmation phrases — **not yet
built on Core** (#223 remains genuinely open; a prior revision of this doc
incorrectly claimed this was already reflected — verified false: both routes
currently call plain `task()`, with no server-side phrase check at all).
Bot displays live player count in preview embed. 60s cooldown group. 30s
cancellable countdown between confirm and execute. `stop` requires a second
administrator to confirm (dual-confirmation gate). The write-bridge must
inject the real, exact server-required confirmation phrase for every
phrase-gated route into the loopback body (see Section 3.5's phrase-mapping
addition) — several targeted routes already require hardcoded phrases
today (`ban` → `"BAN PLAYER"`, `clean-inventory` → `"CLEAN INVENTORY"`,
map spawn/despawn/respawn → `"SPAWN MAP"`/`"DESPAWN MAP"`/`"RESTART MAP"`,
kick-all → `"KICK ALL ONLINE PLAYERS"`) that a prior revision of this design
never accounted for passing through at all.

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
| `broadcast <msg>` | `POST /api/integrations/discord/broadcast` (direct, in-process — see note below) | `admin:broadcast` | admin | Yes (shows message preview) |
| `broadcast-shutdown <msg> [mins]` | `POST /api/integrations/discord/broadcast` (direct, in-process — see note below) | `admin:broadcast-shutdown` | admin | Yes (shows message + countdown) |

**Corrected after round-2 audit (was MEDIUM, batch #740):** unlike every
other group in this document, broadcast does **not** go through the
write-bridge loopback (Section 3) at all — `POST
/api/integrations/discord/broadcast` already exists, is already gated by
`verifyActorSignature()` + `requireDiscordCapability()`, and already calls
`broadcastProvider()` directly in-process (`integrations/discord/routes.js`).
This is a deliberate, explicit exception: it's an already-shipped, already-
audited precedent, and forcing it through the newer bridge machinery for
uniformity's sake would be pure churn with no safety benefit. `broadcast.*`
is intentionally **not** present in Section 3.5's `WRITE_ACTION_ROUTES`
table.

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

Instead: `write/execute`, after validating the nonce, actor signature, and Discord capability, makes a **real internal HTTP request to Core's own real endpoint**. This reuses every real route handler, `task()`, `evaluate()`, and `audit()` call completely unchanged — zero duplicated mutation logic anywhere, so a future fix to (say) the real kick endpoint can never silently fail to apply to the Discord path. (Broadcast is the one deliberate exception — see Group F's note above; it already has its own safe, in-process, already-shipped path and doesn't need the loopback.)

**Corrected after round-2 audit (was CRITICAL #728, Network hat):** the loopback target must **never** be a hardcoded `127.0.0.1` literal. Verified: this project's own shipped default (`ADMIN_BIND_HOST=auto` in `.env.example`, combined with `network_mode: host` in `docker-compose.web.yml`) resolves `config.host` to a real LAN-facing IP via `detectPrivateIpv4()`, not loopback — a hardcoded `127.0.0.1` target would be unreachable (`ECONNREFUSED`) under this project's own default configuration, silently breaking every RW write command for most real installs. The loopback client must resolve its target from the same in-process `config` singleton `server.js` already constructs at boot: `config.host === "0.0.0.0" ? "127.0.0.1" : config.host` (mirroring the existing, already-correct `webConsoleDisplayHost()` helper at `server.js:2493-2497`) and `config.port` — never a separately-derived or hardcoded value. Add a startup self-check (alongside Section 3.5's route-table self-check) that performs one real loopback request and fails loud at boot if it can't reach itself, catching this failure mode immediately on any deployment rather than only when the first Discord write command is attempted.

### 3.2 A new principal type: `discord-write-bridge`

**Corrected after round-2 audit (was HIGH, Cloud Security + Architect hats):**
a prior revision of this section claimed `req.authSession` "already supports
two principal types in production — a browser session and an API key," and
described this as extending an established pattern. **That claim is false on
this fork's own `main`** — `principalOf()`/`apiKeyId` do not exist anywhere
in this codebase (verified directly, zero matches); `req.authSession` today
supports exactly one principal type, a signed `asc_session` cookie
(`auth.js`'s `requireAuth()`/`readSession()`). This design is the **first**
alternate-credential branch ever added to this gate, not a third instance of
a proven pattern — its safety argument has to stand on its own, not by
analogy to a mechanism that doesn't exist here. (This mistake happened
because the design was drafted while reading code from a different, more
advanced branch that does have an API-key principal type — a real instance
of exactly the "never assume a repo's local clone/branch reflects reality
without checking" failure this project's own governing rules warn about.)

The auth-resolution code that currently sets `req.authSession` from a cookie
gains one more branch, recognizing the bridge's internal-only credential
(Section 3.4) and setting

```js
req.authSession = {
  source: "discord-write-bridge",
  tier: mappedTier,          // one of "moderator" | "admin" | "owner" -- see 3.3
  discordUserId: actor.userId,
  discordUsername: actor.username,
  id: `discord:${actor.userId}`,   // added after round-2 audit -- see 3.8's
                                     // rate-limit fix, this must be present
                                     // for per-actor rate-limit keying to work
  csrf: null                        // added after round-2 audit -- explicit,
                                     // not an accidental undefined==undefined
                                     // match against requireAuth()'s CSRF check
};
```

**Corrected after round-2 audit (was CRITICAL #728, Architect H5):** this
branch must **not** grant a general-purpose session valid against any route.
It must only ever be recognized, and `req.authSession` only ever populated
this way, for a request whose `(method, path)` is an **exact match** against
a `WRITE_ACTION_ROUTES` entry (Section 3.5) — reject anything else outright,
even with a valid credential. Without this, a leaked/observed credential
would grant owner-tier access to every console route (`database:query`,
`settings:write`, `backups:restore`, ...), not just the ~26 mapped write
actions.

Every downstream consumer (`evaluate()`, `task()`, `audit()`, every route handler) reads `req.authSession` exactly as it does today — no new special-casing needed anywhere except this one, now-path-scoped, auth-resolution branch.

### 3.3 Tier mapping: only moderator/admin/owner ever reach this far

The Discord bot's tier space (`DISCORD_ROLE_TIERS`) and the console's IAM tier space (`policy.js`'s tiers) are separate, but they share three tier *names*: `moderator`, `admin`, `owner`. Per Section 0's invariant, the Discord bot's `CAPABILITY_BY_TIER` grants zero write capabilities to `public`/`observer` — so `requireDiscordCapability()` already rejects any actor below `moderator` before `write/preview` ever returns a nonce. `mappedTier` in 3.2 is simply `discordActorTier(actor, mapping)`'s result, which by construction is always `moderator`/`admin`/`owner` by the time execution reaches the loopback.

**This tier alone is not sufficient to enforce Section 1's per-action tier ladder** — see 3.3a below, added after round-2 audit found the existing IAM systems can't express "owner but not admin" for a specific action.

### 3.3a Per-action minimum tier (was CRITICAL #729 — new section, round-2 audit correction)

Neither console `policy.js` (whose `players:mutate` action is too coarse to distinguish `kick` from `give-item`) nor Discord's own `CAPABILITY_BY_TIER` (which computes `admin` and `owner` as the identical set) can enforce Section 1's tier ladder. The write-bridge therefore checks its own explicit table, independent of both:

```js
// console/api/src/integrations/discord/writeActionMinTier.js
const TIER_RANK = { moderator: 0, admin: 1, owner: 2 };

export const WRITE_ACTION_MIN_TIER = {
  "player.kick": "admin", "player.ban": "admin", "player.unban": "admin",
  "player.warn": "moderator", "player.fill-water": "admin",
  "player.give-item": "owner", "player.clear-backpack": "owner",
  "base.refill-generators": "admin", "base.refill-water": "admin",
  "server.restart": "owner", "server.stop": "owner", "server.start": "admin",
  "server.restart-service": "admin",
  "map.spawn": "admin", "map.despawn": "admin", "map.respawn": "admin", "map.teleport": "admin",
  "carepackage.grant": "admin", "carepackage.grant-all": "owner",
  "carepackage.enable": "admin", "carepackage.disable": "admin",
  "carepackage.scan": "admin", "carepackage.history-clear": "owner",
  "guild.add": "admin", "guild.remove": "admin"
};

export function meetsMinTier(actorTier, action) {
  const required = WRITE_ACTION_MIN_TIER[action];
  if (!required) throw new Error(`No minimum tier defined for action "${action}"`); // fail closed, not open
  return TIER_RANK[actorTier] >= TIER_RANK[required];
}
```

Checked explicitly by both `write/preview` and `write/execute`, before the loopback call — this table's rows are Section 1's tier ladder made literal and enforced, not an assumption about what `evaluate()`/`CAPABILITY_BY_TIER` already do. The `if (!required) throw` branch is deliberate: a `WRITE_ACTION_ROUTES` entry with no corresponding `WRITE_ACTION_MIN_TIER` entry must fail closed, not silently default to the lowest tier. `broadcast.*` is intentionally absent from this table too (see Group F's note) since it's gated by the existing, separate `requireDiscordCapability()` path instead.

### 3.4 Internal credential: in-memory only, never persisted, and never trusted without source verification

Because the loopback never leaves the host, there is no need for a `runtime/secrets/`-style persisted, rotatable credential (and inventing one would be new attack surface with no corresponding benefit — nothing outside this one Node process ever needs to present it). A single random token (`crypto.randomBytes(32)`) is generated once at server boot and held only in module-level memory, shared directly between the bridge's internal HTTP client and the new auth-resolution branch — nothing written to disk, nothing to rotate.

**Rotation: N/A.** Explicit, per Requirement 27's intent — in-memory, per-process-lifetime only, invalidated automatically on every restart. No rotation cadence needed because there is nothing to rotate.

**Corrected after round-2 audit (was CRITICAL #728, found independently by 3 of 8 hats — Cloud Security, Security Architect, Network Engineer):** token possession alone is **not sufficient**. A prior revision of this section reasoned only about who could *extract* the token from process memory, not about what the auth-resolution branch actually verifies about an incoming request. Because `config.host` defaults to `0.0.0.0` (or a real LAN IP via `ADMIN_BIND_HOST=auto`) under this project's own shipped default, and the general `auth.requireAuth()` gate this branch is added to fronts every publicly-reachable console route, the credential check must be a **mandatory two-part gate**, both required:

1. `req.socket.remoteAddress` is `127.0.0.1` or `::1` — verified independently of the token, every time, no exceptions.
2. The token itself, compared via `crypto.timingSafeEqual` (matching the existing pattern already used for actor-signature comparison in `integrations/discord/actorSignature.js:88-92` — this codebase already has the right precedent for *this* specific comparison, just not for the principal-type question in 3.2).

Both checks live in the same auth-resolution branch; failing either falls through to normal `requireAuth()` behavior (i.e., an unauthenticated request), never a distinct error that would help an attacker distinguish "wrong source" from "wrong token." Residual risk after this fix: another process on the same host with access to this Node process's memory could theoretically extract the token, but that threat model already has full access to everything else this process protects (session secrets, DB credentials in memory) — no incremental exposure from that angle specifically; the incremental exposure this fix closes is network-reachability, not memory-reachability.

**Single-process assumption, stated explicitly (round-2 audit, Cloud Security LOW):** this design assumes Core runs as exactly one Node process (verified true today — `Dockerfile`'s `CMD` is a bare `node server.js`, no cluster/PM2, no Compose `replicas`). If multi-worker scaling is ever introduced, this section must be re-evaluated — each worker would generate its own token, and a loopback request could be routed to a different worker than the one holding the matching credential.

### 3.5 Route/action mapping table (resolves #216)

**Corrected after round-2 audit (was CRITICAL #730, found by DBA + Architect hats):** two entries in a prior revision of this table were real, functional bugs, not just documentation gaps — `player.ban` mapped to the same `DELETE .../ban` call as `player.unban` (there was no real ban action at all: invoking `/dune player ban` would have issued a DELETE and silently unbanned the target), and `player.give-item` targeted a storage-container endpoint instead of the real player-scoped grant route. Both fixed below. `server.maintenance` removed — no such Core route exists (moved to Section 7).

Each entry also now carries an optional `confirmPhrase`, forwarded into the loopback body's `confirmation` field for routes with a hardcoded server-side requirement (round-2 audit HIGH #732 — several targeted routes require an exact phrase Core checks server-side that a prior revision never accounted for passing through at all):

```js
// console/api/src/integrations/discord/writeActionRoutes.js
export const WRITE_ACTION_ROUTES = {
  "player.kick":          { method: "POST",   path: (p) => `/api/players/${encodeURIComponent(p.playerId)}/kick` },
  "player.ban":           { method: "POST",   path: (p) => `/api/players/${encodeURIComponent(p.playerId)}/ban`, confirmPhrase: "BAN PLAYER" },
  "player.unban":         { method: "DELETE", path: (p) => `/api/players/${encodeURIComponent(p.playerId)}/ban` },
  "player.warn":          { method: "POST",   path: () => `/api/admin/map-chat` },
  "player.give-item":     { method: "POST",   path: (p) => `/api/players/${encodeURIComponent(p.playerId)}/give-item` },
  "player.clear-backpack":{ method: "POST",   path: (p) => `/api/players/${encodeURIComponent(p.playerId)}/clean-inventory`, confirmPhrase: "CLEAN INVENTORY" },
  "player.fill-water":    { method: "POST",   path: (p) => `/api/players/${encodeURIComponent(p.playerId)}/refill-water` },
  "base.refill-generators":{ method: "POST",  path: (p) => `/api/bases/${encodeURIComponent(p.baseId)}/refill-generators` },
  "base.refill-water":    { method: "POST",   path: (p) => `/api/bases/${encodeURIComponent(p.baseId)}/refill-water` },
  "server.restart":       { method: "POST",   path: () => `/api/server/restart` },   // real Core phrase gate not yet built -- see #223/#732
  "server.stop":          { method: "POST",   path: () => `/api/server/stop` },      // real Core phrase gate not yet built -- see #223/#732
  "server.start":         { method: "POST",   path: () => `/api/server/start` },
  "server.restart-service":{ method: "POST",  path: () => `/api/server/restart-service` },
  "map.spawn":            { method: "POST",   path: () => `/api/maps/spawn`, confirmPhrase: "SPAWN MAP" },
  "map.despawn":          { method: "POST",   path: () => `/api/maps/despawn`, confirmPhrase: "DESPAWN MAP" },
  "map.respawn":          { method: "POST",   path: () => `/api/maps/respawn`, confirmPhrase: "RESTART MAP" },
  "map.teleport":         { method: "POST",   path: () => `/api/map/teleport-player` },
  "carepackage.grant":    { method: "POST",   path: (p) => `/api/care-package/grant/${encodeURIComponent(p.playerId)}` },
  "carepackage.grant-all":{ method: "POST",   path: () => `/api/care-package/grant-eligible` },
  "carepackage.enable":   { method: "POST",   path: () => `/api/care-package/enable` },
  "carepackage.disable":  { method: "POST",   path: () => `/api/care-package/disable` },
  "carepackage.scan":     { method: "POST",   path: () => `/api/care-package/run` },
  "carepackage.history-clear":{ method: "POST", path: () => `/api/care-package/history/clear`, confirmPhrase: "CLEAR HISTORY" },
  "guild.add":            { method: "POST",   path: (p) => `/api/guilds/${encodeURIComponent(p.guildId)}/members` },
  "guild.remove":         { method: "DELETE", path: (p) => `/api/guilds/${encodeURIComponent(p.guildId)}/members` }
};
```

(`broadcast.*` is intentionally absent — see Group F's note; it never goes through this table or the loopback.)

**Lookup safety (round-2 audit, Security MEDIUM #740):** `action` arrives directly in an actor-signed request body, so lookups must use `Object.hasOwn(WRITE_ACTION_ROUTES, action)` before indexing — a bare `WRITE_ACTION_ROUTES[action]` risks resolving `"constructor"`/`"__proto__"`/`"toString"` to a truthy inherited value instead of `undefined`, an unhandled-exception crash vector.

**Param validation (round-2 audit, Security MEDIUM #740):** `encodeURIComponent` alone is not sufficient shape validation — it escapes `/` but not `.`, so a value of exactly `".."` can shift which real route is requested after URL normalization. Every `playerId`/`baseId`/`guildId` must be validated against a strict ID-shape pattern (matching Core's real ID format) *before* being passed into a `path()` template, not relied on to be made safe by `encodeURIComponent` alone.

At startup, a self-check resolves every `path()` template against a representative param set and confirms the resulting `(method, path)` matches a real entry in `actions.js`'s `ROUTE_ACTIONS`/`REGEX_ACTIONS_BY_METHOD`/`REGEX_ACTIONS`.

**Failure scope, stated explicitly (round-2 audit, UI/UX CRITICAL #737):** a prior revision said this "refuses to boot with a loud error" without scoping the blast radius — Core also serves the entire game console/API to every operator of this fork, not just Discord write commands, so an unscoped crash on drift would take down the whole self-hosted stack on a routine update. **The self-check must fail closed on the RW subsystem only**: log the specific drifted entry loudly, disable write-bridge routes entirely, and let Core boot and serve everything else normally. A future update that breaks a `WRITE_ACTION_ROUTES` entry must never be able to take an operator's whole console offline. Layer 2 must also add a troubleshooting entry (`admin-guide.md`/`faq.md`) naming this exact failure mode and what an operator should do about it.

**Corrected after round-2 audit (was HIGH #731, Architect meta-finding C4): this self-check has a real, structural blind spot and must not be described as a complete fix for #216-class drift.** It can only prove a `(method, path)` pair resolves to *some* known action — `actions.js`'s action namespace is deliberately coarser than `server.js`'s actual per-path handler identity, so it would have passed the original ban/unban-inversion and give-item-wrong-endpoint bugs cleanly (both resolved to real, valid actions). **Required addition, Layer 2:** a second, independent verification — an integration test per `WRITE_ACTION_ROUTES` entry that exercises it against a real (test) Core instance and asserts the actual expected effect, not just that the self-check passes.

### 3.6 `GET /api/items` catalog endpoint (resolves #222)

A new read-only Core endpoint, `GET /api/items?q=<prefix>&limit=25`, gated **only** by the Discord bot's own capability system (`requireDiscordCapability`, minimum tier `moderator`) — not by console `policy.js` (round-2 audit, Security MEDIUM #740: a prior revision reasoned in console-IAM vocabulary for an endpoint whose only real caller is the Discord bot's own autocomplete handler, conflating the two separate tier spaces Section 0 itself declares independent). Backed by the real item **catalog** (names/ids/volume/stack size — `runtime/data/admin-items.json` via `adminCatalog.js`) with a simple case-insensitive prefix match, capped at 25 results (Discord's own autocomplete choice limit) and required to respond within the bot's autocomplete 3s budget — an in-memory index built once at boot, not a per-request read.

**Corrected after round-2 audit (was HIGH #736, DBA hat):** a prior revision claimed this reuses "the same source of truth" as `give-item`'s item-type allowlist per #218 — **false**. #218 is still open; none of its required mitigations (quest-item/admin-only-flag exclusion, 1-stack cap, 10/day volume limit) exist anywhere in this codebase today, and `admin-items.json` has no data field that could back such a filter. This endpoint reuses the item **catalog only** (for autocomplete display purposes) — the safety allowlist #218 requires is separate, not-yet-built enforcement that must still be added to the give-item mutation path itself, not something this endpoint provides.

**Catalog refresh policy, stated explicitly (round-2 audit, DBA MEDIUM #740):** `admin-items.json` changes are git-committed/deploy-only (no runtime write path exists) — a catalog update requires a Core restart to take effect in this new in-memory index. This matches `adminItemMetadata()`'s existing caching discipline in `duneDb.js`, but differs from `adminCatalog.js`'s other functions (`resolveCatalogItem` etc.), which live-read the file on every call — that inconsistency already exists today and isn't introduced by this design, but is worth this one-line acknowledgment for a future reader.

### 3.7 `DUNE_DISCORD_WRITES_ENABLED` parsing (resolves #217)

**Corrected after round-2 audit (was HIGH, GRC + Architect hats):** a prior revision of this section claimed Core needed no change ("keeps its existing `'1'` convention... changing it would ripple into other already-shipped config reads") and only the bot needed updating. **This premise was stale by a month** — verified directly: Core's real `discordWritesEnabled()` (`integrations/discord/adapter.js:144-147`) already accepts both `"1"` and `"true"` case-insensitively, per an upstream merge (`9bdf2fe5b`, 2026-08-11) that predates this revision, with an existing passing test (`console/api/test/discordAdapter.test.js`) asserting exactly this. **No Core change is needed for #217 at all.** Remaining scope, if the bot side still diverges: update the bot's own `writesEnabled()` (`writes.js`) to accept both values the same way, so an operator who set either value during the read-only/experimental period keeps working across the fix (Strict Requirement 0's update-path rule) — verify the bot's current behavior before assuming this is still needed, rather than repeating the same "assumed stale, never checked" mistake this correction is fixing.

**Operator-facing doc conflict, flagged for Layer 2 (round-2 audit, GRC MEDIUM #740):** `docs/integrations/discord-integration/admin-guide.md` and `faq.md` currently show `DUNE_DISCORD_WRITES_ENABLED=true` as the canonical example — needs reconciling with whichever value ends up canonical once the bot-side check above is verified. Owner: whoever picks up Layer 2 implementation for this section.

### 3.8 Error mapping, rate limiting, freshness, and idempotency

Unchanged from the table in Section 4 below (`200`/`400`/`403`/`409`/`429`/`500`/`503`, plus a new `410` row added after round-2 audit — see Section 4) — the loopback response's real HTTP status from Core's own endpoint is what the bridge maps through directly.

**Rate-limit isolation, corrected after round-2 audit (was HIGH #733, Security hat):** Core's existing `applyMutationRateLimit()` (called by every real target route) keys on `` `${scope}:${sessionId}:${remoteIp}` `` — `sessionId` comes from `req.authSession.id`, `remoteIp` is always `127.0.0.1` for a loopback call. A prior revision's synthesized `authSession` (3.2) had no `id` field, so every Discord actor performing the same action would have collapsed into one shared rate-limit bucket, the opposite of this section's own "3 actions/30s per actor" claim. Fixed in 3.2: the synthesized session now carries `id: \`discord:${actor.userId}\``, so existing rate-limit keying isolates per Discord user exactly as it already does for browser/API-key sessions — no change needed to `applyMutationRateLimit()` itself.

**Actor-role freshness, corrected after round-2 audit (was HIGH #734, Security hat):** "actor signature + capability re-validated at both preview AND execute" only proves the same functions ran twice — it doesn't prove `actor.roleIds` presented to `write/execute` reflects the actor's *current* Discord roles rather than a value cached from the original slash-command interaction. **Required:** the bot must re-derive `actor.roleIds` from Discord's current guild-member state at the moment of the confirm button-click (a fresh Discord API call at click time, not a replay of the original interaction's payload) — Core treats each `write/execute` call's actor payload as authoritative only for that specific call, never inferring authorization state from anything stored in the nonce entry itself.

**Nonce store**: an in-memory `Map<nonce, { actorUserId, action, params, expiresAt }>`, single-use (deleted on first consumption), 60s TTL. A server restart mid-confirmation simply expires the pending nonce — nothing has mutated yet, so losing it is safe; the user just retries.

**Idempotency cache — corrected after round-2 audit (was HIGH #736, DBA hat): must be persisted, not in-memory.** A prior revision justified an in-memory-only idempotency cache by citing `restartQueue`'s "in-memory entries" as precedent — **this citation was factually wrong**: `services/restartQueue.js`'s `readState`/`writeState` persist to disk (mode `0o600`) precisely because that state must survive a restart. The real precedent in this codebase for state that must survive a restart is to persist it, not accept its loss. Losing the idempotency cache mid-flight is a real gap: if Core restarts between a `write/execute` call that already performed a non-idempotent mutation (give-item, grant-all, carepackage grant, guild add/remove all qualify) and a bot-side retry using the same idempotency key, the post-restart cache is empty and the retry silently double-executes. **Fixed:** the idempotency cache is persisted using the same `runtime/`-relative JSON-file convention `restartQueue.js` already uses (small file, `0o600`, same directory) — a retried `write/execute` with the same key and same params returns the cached result without re-invoking the loopback; same key with different params returns `409 "already executed"` per the existing error table. The nonce store stays in-memory (above); only the idempotency cache needs persistence, since only it protects against a real, already-executed mutation being silently repeated.

**Eviction policy, stated explicitly (round-2 audit, DBA/Security LOW #740):** both stores are actively pruned on a periodic timer (not just checked lazily on lookup), with a max-entry-per-actor bound as a belt-and-braces cap against unbounded growth from a misbehaving moderator+-tier actor flooding `write/preview` (which is cheap to call repeatedly since it doesn't mutate anything).

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
- **None**: start, enable, disable, scan
- **Button click**: kick, unban, warn, give-item, refill, restart-service, teleport, grant, broadcast
- **Type confirmation string**: ban, server restart, server stop, spawn, despawn, respawn, clear-backpack, history clear, grant-all

**Verification status of required phrases, stated explicitly (round-2 audit gap this correction pass caught in its own remediation, not a new finding filed separately):** the Architect hat's round-2 audit directly verified the exact real phrases for `ban` (`"BAN PLAYER"`), `clean-inventory` (`"CLEAN INVENTORY"`), `spawn`/`despawn`/`respawn` (`"SPAWN MAP"`/`"DESPAWN MAP"`/`"RESTART MAP"`), and kick-all (`"KICK ALL ONLINE PLAYERS"`) — those are real, confirmed against `server.js`. It did **not** verify `history-clear`'s or `grant-all`'s real server-side phrase requirement (if any) — Section 3.5's `confirmPhrase: "CLEAR HISTORY"` for `history-clear` carries forward what a prior revision of this doc already claimed, unverified against real code, and `grant-all` has no `confirmPhrase` entry at all despite appearing in this "type confirmation string" list. **Required Layer 2 task:** verify every remaining phrase-gated route's real requirement against `server.js` directly (the same way the Architect hat did for the four above) before implementation, not carry forward unverified claims a second time.

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
| 403 (genuine tier/permission denial) | "🔒 Not authorized for {action}" | error |
| 403 (`DUNE_DISCORD_WRITES_ENABLED` off — new row, round-2 audit UX #737) | "🔴 Write commands are currently disabled on this server" | error |
| 409 | "⚠️ Already executed" | warning |
| 410 (nonce not found/expired — new row, round-2 audit UX #737) | "⏱️ Confirmation expired — please re-run the command" | warning |
| 429 | "⏱️ Rate limited. Retry in {s}s" | warning |
| 500 | "💥 Action failed: {details}" | error |
| 503 | "🔴 Adapter unavailable" | error |

**Corrected after round-2 audit (was CRITICAL #737, UI/UX hat):** a prior
revision of this table gave the kill switch and a genuine permission denial
the identical `403`/"Not authorized" response — an admin with sufficient
tier who hit the disabled kill switch would have seen the same message as
someone who genuinely lacked permission. Split into its own row above.
Similarly, a confirmation click landing just after the 60s nonce TTL had no
defined status at all in the prior revision — added the `410` row above.

---

## 5. What's Already Built vs What's Needed

### Core (dune-awakening-selfhost-docker)

| Component | Status | Issue |
|-----------|--------|-------|
| Write adapter bridge (preview + execute) | **DESIGNED** (Section 3, corrected after round-2 audit) — not built | #215 |
| Per-action minimum tier table (`WRITE_ACTION_MIN_TIER`) | **DESIGNED** (Section 3.3a, new — round-2 audit found the tier ladder was otherwise unenforceable) — not built | #729 |
| Internal credential: loopback-source binding + path-scoping | **DESIGNED** (Section 3.4/3.2, corrected — round-2 audit found the original design had no such binding) — not built | #728 |
| `WRITE_ACTION_ROUTES` mapping table + startup self-check against `actions.js` | **DESIGNED**, self-check's real limitation now documented (needs a second, per-entry verification layer, see #731) — not built | #216, #731 |
| Route table correctness (ban/unban, give-item) | **FIXED IN DESIGN** (round-2 audit found both as real routing bugs) | #730 |
| `guild:create` / `guild:rename` / `base:destroy` / `server:maintenance` | **DEFERRED** (Section 7) — no Core endpoint, out of scope this round | #216 |
| `GET /api/items` catalog endpoint (autocomplete) | **DESIGNED** (Section 3.6, corrected — the #218 allowlist-reuse claim was false) — not built | #222, #736 |
| Server restart/stop confirmation phrases | **GENUINELY STILL OPEN** — a prior revision incorrectly claimed this was already reflected; verified both routes have zero server-side enforcement today | #223, #732 |
| `player:give-item` item-type allowlist/caps | **GENUINELY STILL OPEN** — #218's mitigations don't exist anywhere in this codebase; a prior revision incorrectly implied otherwise | #218 |
| Per-actor rate-limit isolation through the loopback | **FIXED IN DESIGN** (Section 3.8 — synthesized session now carries a stable `id`) | #733 |
| Idempotency cache persistence | **FIXED IN DESIGN** (Section 3.8 — now persisted, matching `restartQueue`'s real precedent) | #736 |
| `discordWritesEnabled` standardization | **Core needs no change** (verified: already accepts both `"1"`/`"true"` since an upstream merge that predates this doc) — bot-side status needs re-verification | #217 |
| Section 6 test-plan coverage for all new mechanisms | **REWRITTEN** (this revision) | #735 |
| Actor signing on all write adapter routes | **EXISTS** | #207 (verified) |

### Bot (Mentat)

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

**Rewritten after round-2 audit (was CRITICAL #735, QA hat): this section was
previously left byte-for-byte unchanged despite ~200 lines of new Core-side
mechanism design (Section 3) — meaning every new mechanism could ship broken
with the existing test plan never noticing, since it only ever exercised
Discord-bot-side behavior against mocks.** Every bullet below marked *(new,
Core)* is required Layer 1/2 coverage this revision adds; bullets without
that marker are unchanged from the original doc.

### Layer 1: Unit Tests (per component)
- `validateWriteParams()` — control chars, SQL fragments, length limits, enum validation
- `writeCooldown.checkGroup()` — per-group keying, expiry, cross-group isolation
- `writeConfirmation.js` — all 7 button interaction states (already tested, extend for new destructive confirmations)
- `writeExecute()` / `writePreview()` — mock adapter returns fixture nonce/result
- *(new, Core)* **Principal-type resolution (3.2):** unit test the new auth-resolution branch — correct token + correct loopback source → `discord-write-bridge` session recognized; correct token + wrong source IP → rejected; wrong token + correct source → rejected; a request whose `(method, path)` isn't an exact `WRITE_ACTION_ROUTES` match → rejected even with valid credentials (path-scoping, #728).
- *(new, Core)* **Credential comparison:** assert `crypto.timingSafeEqual` is actually used, not `===`, for the internal token check.
- *(new, Core)* **`meetsMinTier()` (3.3a):** table-driven, every `WRITE_ACTION_ROUTES` key against every tier — assert it matches Section 1's tier ladder exactly; assert an action present in `WRITE_ACTION_ROUTES` with no `WRITE_ACTION_MIN_TIER` entry throws (fail closed) rather than defaulting open.
- *(new, Core)* **`WRITE_ACTION_ROUTES` lookup safety:** `"constructor"`/`"__proto__"`/`"toString"` as `action` → rejected via `Object.hasOwn`, never resolves to an inherited value.
- *(new, Core)* **Route self-check (3.5), both branches:** a deliberately-mismatched entry → refuses to enable the RW subsystem (not a full-process crash — see 3.5's failure-scope correction) with a specific logged error; the current real table against the current real `actions.js` → passes clean. Re-run in CI so a future route rename is caught automatically.
- *(new, Core)* **Per-route-table-entry correctness (resolves the self-check's documented blind spot, #731):** one integration test per `WRITE_ACTION_ROUTES` entry, against a real (test) Core instance, asserting the *actual* expected effect (e.g. `player.ban` really bans, not unbans; `player.give-item` really targets the player's inventory, not a storage container) — not just that the self-check's `(method, path)` lookup passes.
- *(new, Core)* **Nonce store:** single-use consumption (a re-presented already-consumed nonce is rejected), 60s TTL expiry, correct `actorUserId`/`action`/`params` binding.
- *(new, Core)* **Idempotency cache (persisted, 3.8):** same key + same params → cached result, no re-invocation of the loopback; same key + different params → `409`; cache survives a process restart (this is the entire point of persisting it — test it, don't just assert it).
- *(new, Core)* **Audit attribution:** a loopback-executed action produces an audit-log entry correctly identifying the real Discord actor (`discordUserId`), never the bridge's internal credential and never blank.
- *(new, Core)* **Credential non-leakage:** the internal token never appears in any `audit()` payload, error response body, or logged output (Requirement 24) — a capture-based assertion against real logged output during a simulated loopback call.
- *(new, Core)* **Rate-limit per-actor isolation (3.8, #733):** two different Discord actors performing the same action in the same window are NOT throttled by each other's activity (regression test for the shared-bucket bug this round's audit found).

### Layer 2: Integration Tests
- Full lifecycle: slash command → preview nonce → confirmation → execute → result embed
- Nonce expiry (60s timeout) → bot shows "expired" embed (`410`, per Section 4's corrected error table)
- Idempotency replay (same key, same params) → bot shows cached result
- Idempotency collision (same key, different params) → bot shows "already executed"
- All error codes from the corrected error table (Section 4), including the new `410` and the split kill-switch-vs-permission `403` rows
- *(new, Core)* **Tier-floor negative test (Section 0's invariant):** table-driven across every `WRITE_ACTION_ROUTES` entry, assert `requireDiscordCapability()` rejects `public`/`observer`-tier actors before a nonce is ever issued.
- *(new, Core)* **Confirmation-phrase pass-through:** every entry with a `confirmPhrase` (3.5) — the loopback body carries the exact required phrase; a mismatched/missing phrase → the real endpoint's `400`, not a false success.
- *(new, Core)* **Stale-role rejection (#734):** an actor whose role is revoked between `write/preview` and `write/execute`, using a fresh (not cached) role lookup at execute time, is rejected.
- *(new, Core)* **Broadcast exception path (Group F):** confirm `broadcast.*` never reaches the loopback/`WRITE_ACTION_ROUTES` machinery at all — it stays on its existing, separate `broadcastProvider()` path.

### Layer 3: End-to-End
- Real Core HTTP mock server with nonce store (extend `scripts/mock-adapter.js`)
- Bot-side Discord interaction mocks with button state machine
- Concurrency test: two simultaneous write commands serialize correctly
- *(new, Core)* **Loopback reachability under the project's real default config:** boot Core with `ADMIN_BIND_HOST=auto` (this project's shipped default) and confirm the write-bridge's own loopback self-check (3.1) actually succeeds — a regression test for the hardcoded-`127.0.0.1` bug this round's audit found, which would have silently broken every RW command under this exact default.

---

## 7. Not in Scope (Explicitly Deferred)

- `database:export` / `database:query` — raw SQL from Discord is too dangerous
- `updates:apply` — requires console UI visibility (downtime, rollback)
- `landsraad:*` — experimental, requires console context
- `sietches:write` / `deepdesert:write` — low-use, defer
- `addons:install` / `addons:update` — requires console UI
- `guild:create` / `guild:rename` — defer until Core endpoints exist (#216)
- `base:destroy` — defer until Core endpoint exists (#216)
- `server:maintenance` — no Core endpoint exists at all today; defer until one is built (round-2 audit correction — removed from Section 2 Group C's active command table, where a prior revision incorrectly listed it as buildable)

**Corrected after round-2 audit:** `player:unban` was previously listed here as deferred while simultaneously being fully designed and shipped in Section 2/3.5 — a real self-contradiction, caught independently by 3 of 8 hats. It IS in scope this round (real, verified `DELETE /api/players/:id/ban` endpoint) — removed from this deferred list.

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

**Round 2 (2026-09-09, against the write-bridge revision), 8 hats, 11 issues filed:**

| # | Title | Hat(s) | Severity |
|---|-------|--------|----------|
| 728 | Internal credential: no loopback-source binding, not scoped to bridge routes | Cloud Security, Security, Network, Architect | CRITICAL |
| 729 | Tier ladder unenforceable by existing IAM machinery | Security, Architect | CRITICAL |
| 730 | Route table: ban/unban inverted, give-item wrong endpoint, maintenance doesn't exist | DBA, Architect | CRITICAL |
| 731 | Startup self-check cannot catch handler-identity routing bugs | Architect | HIGH |
| 732 | Restart/stop have zero server-side confirmation; hardcoded phrases unaccounted for | Security, Architect, GRC | HIGH |
| 733 | Loopback collapses per-actor rate limiting into one shared bucket | Security | HIGH |
| 734 | write/execute doesn't re-validate current Discord roles | Security | HIGH |
| 735 | Section 6 test plan has zero coverage for new mechanisms | QA | HIGH |
| 736 | Idempotency cache unpersisted; #218 allowlist-reuse claim false | DBA | HIGH |
| 737 | Startup self-check crash blast radius/recovery undefined; error-model gaps | UI/UX | CRITICAL/HIGH |
| 740 | Batched MEDIUM/LOW: bare-property lookup, path traversal, IAM conflation, doc contradictions, false precedent claims, missing CHANGELOG entry, etc. | multiple | LOW (batch) |

Full findings and STRIDE report: comment on #215.
