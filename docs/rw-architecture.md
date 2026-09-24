# RW Command Architecture — Discord Bot Write Operations

**Original design date:** 2026-08-08

**Status:** Core-side implementation complete (write/preview + write/execute, the per-action tier/route tables, and the internal dispatch mechanism described below). Bot-side status (item autocomplete, per-group cooldowns, parameter validation) is unchanged from this document's original assessment and is tracked separately in the bot's own repository, not this one.

**Note on this revision:** this document originally cited several issue numbers (`#215`-`#223`) as its own audit trail. Those numbers were local to the fork this feature was first prototyped on and were never resolvable here — this revision removes them and states the underlying reasoning inline instead, and replaces the original "Related Issues" table (Section 8) with a plain, numberless list of what each item actually means.

---

## 1. Architecture Overview

```
Discord User → Slash Command → Bot RBAC → Confirmation (if destructive)
  → Rate Limit → Adapter Client → POST /api/integrations/discord/write/preview
  → Core validates actor + capability → returns nonce
  → Bot displays confirmation embed → User clicks Confirm
  → POST /api/integrations/discord/write/execute with nonce
  → Core validates nonce → calls the real, already-existing console API endpoint
  → Result → Audit → Discord embed
```

### Key Design Decisions

1. **Write adapter bridge** — every RW Discord command targets Core via `/api/integrations/discord/write/preview` and `/api/integrations/discord/write/execute`, never a console API endpoint directly. This is what makes actor-signature verification and capability enforcement apply uniformly to every write operation, rather than depending on each endpoint remembering to check it independently.

2. **Two-phase confirmation** — `write/preview` validates authority and returns an impact preview plus a single-use nonce; `write/execute` consumes that nonce and performs the action. The nonce is bound to the specific actor, action, and parameters it was minted for, so it cannot be replayed against a different action or presented by a different user (with one deliberate exception: an action that requires two independent administrators to confirm — see `server.stop`'s note in Section 2 — where a second, different actor presenting the same nonce is the intended behavior, not a bypass).

3. **Tier ladder** — capability tiers, mapped from Discord roles:

   | Discord Role | Capability Tier | Can do |
   |-------------|----------------|--------|
   | (no role / observer) | *(none)* | Read-only — no write commands at all |
   | moderator | `moderator` | `player.warn` only |
   | admin | `admin` | Most RW actions: player kick/ban, base refill, server start/restart-service, map control, carepackage grant, guild membership |
   | owner | `owner` | The most destructive actions: server restart/stop, player inventory clear, give-item, care-package grant-all/history-clear, backup create, applying updates |

   Enforced by an explicit, independent per-action table (`WRITE_ACTION_MIN_TIER`, Section 2) — deliberately not derived from the console's own coarser IAM actions or from the Discord adapter's own capability-tier mapping, since neither is granular enough to express "owner but not admin" for one specific action while treating both tiers identically everywhere else.

4. **Master kill switch** — `DUNE_DISCORD_WRITES_ENABLED=1`. All RW routes return 403 `writes_disabled` when unset, checked first, before any other validation runs.

---

## 2. Command Groups (as actually implemented)

Every entry below dispatches through `write/preview` → `write/execute` to the named Core endpoint, reusing that endpoint's existing, unmodified handler — the write bridge never reimplements a mutation, it only adds a signed, confirmed path to trigger one that already exists.

### Group A: `player`

| Action | Core Endpoint | Min Tier | Confirmation |
|--------|---------------|----------|---------------|
| `player.kick` | `POST /api/players/:id/kick` | admin | none |
| `player.ban` | `POST /api/players/:id/ban` | admin | phrase: `BAN PLAYER` |
| `player.unban` | `DELETE /api/players/:id/ban` | admin | none |
| `player.warn` | `POST /api/admin/map-chat` | moderator | none |
| `player.give-item` | `POST /api/players/:id/give-item` | **owner** | none |
| `player.clear-backpack` | `POST /api/players/:id/clean-inventory` | **owner** | phrase: `CLEAN INVENTORY` |
| `player.fill-water` | `POST /api/players/:id/refill-water` | admin | none |

### Group B: `base`

| Action | Core Endpoint | Min Tier | Confirmation |
|--------|---------------|----------|---------------|
| `base.refill-generators` | `POST /api/bases/:id/refill-generators` | admin | none |
| `base.refill-water` | `POST /api/bases/:id/refill-water` | admin | none |

`base.destroy` remains deferred — no such Core endpoint exists yet.

### Group C: `server`

| Action | Core Endpoint | Min Tier | Confirmation |
|--------|---------------|----------|---------------|
| `server.restart` | `POST /api/server/restart` | **owner** | none at this layer (the restart-queue mechanism itself, unrelated to the write bridge, may prompt live players first) |
| `server.stop` | `POST /api/server/stop` | **owner** | phrase: `STOP SERVER` |
| `server.start` | `POST /api/server/start` | admin | none |
| `server.restart-service` | `POST /api/server/restart-service` | admin | none |

**`server.stop`'s confirmation model, revised from the original design:** the original plan called for a mandatory second-administrator confirmation (dual confirmation) before `stop` could execute. That mechanism was built and is still real, tested, and available (`writeExecuteRoute`'s `requiresDualConfirmation` branch, exercised end-to-end by a test-only override) — but it is not currently enabled on any action, `server.stop` included. The reason: this project's own Discord RBAC model gives exactly one account the owner tier per guild, so "a second, genuinely different owner-tier administrator" cannot exist in most real deployments, making the gate impossible to satisfy rather than merely strict. `server.stop` instead relies on its confirmation phrase plus the single-owner-tier requirement. Re-enabling dual confirmation for any action remains a one-line table change if a future deployment model supports multiple independent owners.

`server.maintenance` (on/off) from the original design was not built — no such Core endpoint exists.

### Group D: `map`

| Action | Core Endpoint | Min Tier | Confirmation |
|--------|---------------|----------|---------------|
| `map.spawn` | `POST /api/maps/spawn` | admin | phrase: `SPAWN MAP` |
| `map.despawn` | `POST /api/maps/despawn` | admin | phrase: `DESPAWN MAP` |
| `map.respawn` | `POST /api/maps/respawn` | admin | phrase: `RESTART MAP` |
| `map.teleport` | `POST /api/map/teleport-player` | admin | none |

### Group E: `carepackage`

| Action | Core Endpoint | Min Tier | Confirmation |
|--------|---------------|----------|---------------|
| `carepackage.grant` | `POST /api/care-package/grant/:id` | admin | phrase: `GRANT CARE PACKAGE` |
| `carepackage.grant-all` | `POST /api/care-package/grant-eligible` | **owner** | phrase: `GRANT CARE PACKAGE TO ELIGIBLE PLAYERS` |
| `carepackage.enable` | `POST /api/care-package/enable` | admin | phrase: `ENABLE CARE PACKAGE` |
| `carepackage.disable` | `POST /api/care-package/disable` | admin | phrase: `DISABLE CARE PACKAGE` |
| `carepackage.scan` | `POST /api/care-package/run` | admin | phrase: `RUN CARE PACKAGE SCAN` |
| `carepackage.history-clear` | `POST /api/care-package/history/clear` | **owner** | phrase: `CLEAR GRANT HISTORY` |

### Group F: `broadcast`

Not part of the write bridge, in the original design or this implementation — `broadcast`/`broadcast-shutdown` call `/api/integrations/discord/broadcast` directly, gated by the Discord adapter's own existing capability check, since they were never a two-phase confirm/execute action to begin with.

### Group G: `guild`

| Action | Core Endpoint | Min Tier | Confirmation |
|--------|---------------|----------|---------------|
| `guild.add` | `POST /api/guilds/:id/members` | admin | none |
| `guild.remove` | `DELETE /api/guilds/:id/members/:playerId` | admin | none |

`guild.create` and `guild.rename` remain deferred — no such Core endpoints exist yet.

### Additional actions built beyond the original scope

Three actions were added during implementation that the original design didn't cover, using the identical write/preview → write/execute mechanism:

| Action | Core Endpoint | Min Tier | Confirmation |
|--------|---------------|----------|---------------|
| `backup.create` | `POST /api/backups/create` | **owner** | none |
| `updates.apply-game` | `POST /api/updates/apply-game` | **owner** | none |
| `updates.fix-steamcmd` | `POST /api/updates/fix-steamcmd` | **owner** | none |

---

## 3. Write Adapter Bridge

### Core Side

```
POST /api/integrations/discord/write/preview
  Headers: X-Dune-Actor-Signature, X-Dune-Actor-Timestamp
  Body: { actor: {...}, action: "player.kick", params: { playerId: "..." } }
  Response: { ok: true, nonce: "...", expiresAt: 1766249032000, preview: { action, confirmPhrase } }

POST /api/integrations/discord/write/execute
  Headers: X-Dune-Actor-Signature, X-Dune-Actor-Timestamp
  Body: { actor: {...}, nonce: "...", action: "player.kick", params: {...} }
  Response: whatever the real target Core endpoint returns, passed through unchanged
```

**Security, as actually implemented:** both routes require a valid HMAC actor signature (`verifyActorSignature`, required — not optional), the coarse `write-bridge:access` capability (moderator tier and up), and the per-action minimum tier from Section 2. The nonce is single-use, bound to one specific actor/action/params tuple, and expires after 60 seconds by default (`server.restart` gets a 90-second window, since its own post-confirmation countdown needs the nonce to still be valid when `write/execute` is finally called). An **idempotency key was part of the original design but was not built** — the nonce's own single-use semantics already prevent a second execution of the same confirmed action; a persisted idempotency cache scoped to detecting a resent-but-different-params request remains a real, disclosed gap rather than an implemented feature.

### Bot Side

Unchanged from the original design and out of scope for this repository — see the bot's own `writeConfirmation.js`/`writeHandler.js` and its own tracked follow-ups for item autocomplete, per-group cooldowns, and parameter validation.

---

## 4. Safety Model

### Confirmation Flow

```
1. User invokes a slash command
2. Bot validates actor + capability + its own rate limit
3. Bot calls write/preview → receives a nonce + a preview (including the confirmation phrase, if the action has one)
4. Bot displays a confirmation embed (with the phrase to type, or a button, depending on the action)
5. User confirms
6. Bot calls write/execute with the nonce
7. Bot displays the result
```

### Rate Limiting

The bridge's own nonce store caps *pending, unconsumed* previews at 20 per actor (a belt-and-braces bound against a misbehaving actor flooding `write/preview`, which is otherwise cheap and safe to call repeatedly since it never mutates anything). Separately, every actual mutation dispatched through this bridge shares the same real, existing per-actor/per-operation rate limiter every other Core mutation route already uses (20 requests per 60-second window per actor+operation, 200 per 60 seconds globally) — a write-bridge-driven action and the equivalent console-UI action against the same operation draw from the same budget, not two independent ones. The original design's more granular per-command-group cooldown scheme (distinct windows for `player`/`base`/`server`/`map`/`carepackage`/`broadcast`) is a bot-side concern and remains that repository's own responsibility, unchanged from the original assessment.

### Errors

The actual error surface is richer than a generic HTTP-status table can usefully convey; every rejection returns a distinct, documented `code` field alongside its HTTP status so a client can branch on the specific reason rather than the status alone:

| HTTP | `code` | Meaning |
|------|--------|---------|
| 400 | `unknown_write_action` | The requested action isn't in the route table |
| 400 | `invalid_parameters` | The action's own parameter validation rejected the input |
| 400 | `missing_nonce` | `write/execute` called with no nonce |
| 403 | `writes_disabled` | `DUNE_DISCORD_WRITES_ENABLED` isn't set |
| 403 | `missing_actor_signature` / `invalid_actor_signature` / `stale_actor_signature` | The actor signature is absent, doesn't verify, or is outside the freshness window |
| 403 | `not_authorized` | The actor's tier doesn't meet the action's minimum |
| 403 | `nonce_actor_mismatch` | A different actor is presenting someone else's nonce (outside the dual-confirmation exception) |
| 403 | `second_confirmation_same_actor` | The same actor tried to provide both required confirmations |
| 409 | `nonce_action_mismatch` | The action named at execute time doesn't match what was previewed |
| 410 | `nonce_not_found` | The nonce expired or was already used |
| 429 | `too_many_pending_confirmations` | The actor has too many unconsumed previews outstanding |
| 500 | `write_action_misconfigured` | The action is missing its required tier-table entry (a server-side configuration gap, not a caller error) |
| 503 | `write_backend_unavailable` | The internal dispatch transport is down or disabled |

---

## 5. What's Built vs What's Needed

### Core (this repository)

| Component | Status |
|-----------|--------|
| Write adapter bridge (`write/preview` + `write/execute`) | **Built** |
| Per-action minimum-tier table | **Built** |
| Actor-signature verification (HMAC, required on both routes) | **Built** |
| `DUNE_DISCORD_WRITES_ENABLED` standardized parsing | **Built** |
| `server.restart`/`server.stop` confirmation phrases | **Built** |
| Idempotency key / persisted idempotency cache | **Not built** (see Section 3) |
| `guild.create` / `guild.rename` endpoints | **Not built** |
| `base.destroy` endpoint | **Not built** |

### Bot (separate repository)

Unchanged from the original design's assessment — confirmation button flow and write command dispatch exist; item autocomplete, per-group cooldowns, dedicated write-adapter client methods, and parameter validation remain the bot repository's own open work, not something this PR can speak to authoritatively.

---

## 6. Test Coverage (as actually built)

The original design's three-layer plan (unit / integration / end-to-end) was followed, but ended up broader than originally scoped, once real implementation surfaced real edge cases:

- **Unit-level**: the per-action tier table, the route/action mapping table's own internal consistency (every entry's declared endpoint and IAM action actually exist and match), the nonce store's TTL/eviction/single-use/dual-confirmation-marking behavior in isolation, actor-signature verification (including tampering and replay-window edge cases) in isolation.
- **HTTP integration**: every route mounted on a real `http.Server` and exercised with real requests — bearer-token checks, actor-signature checks, capability/tier checks, the full nonce lifecycle, every documented error code, and the dual-confirmation mechanism's full two-actor flow.
- **End-to-end**: a real Unix-socket internal-dispatch listener (the mechanism `write/execute` uses to invoke the real target Core route without reimplementing it), started and torn down for real, proving an actual on-disk mutation and an actual audit-log entry result from a real preview → execute round trip — not a mocked stand-in for either.

The original plan's "concurrency test: two simultaneous write commands serialize correctly" and "mock-adapter.js" extension are bot-side concerns and remain open there.

---

## 7. Not in Scope (Explicitly Deferred)

- `database:export` / `database:query` — raw SQL from Discord is too dangerous
- `updates:apply` (the general self-update path, as opposed to `updates.apply-game`/`updates.fix-steamcmd` above) — requires console UI visibility (downtime, rollback)
- `landsraad:*` — experimental, requires console context
- `sietches:write` / `deepdesert:write` — low-use, deferred
- `addons:install` / `addons:update` — requires console UI
- `guild:create` / `guild:rename` — deferred until the corresponding Core endpoints exist
- `base:destroy` — deferred until the corresponding Core endpoint exists
- A persisted idempotency cache (Section 3) — the nonce's own single-use semantics cover the common case; a resent-but-different-params replay is not yet specially detected

---

## 8. Known Follow-Ups

- **Bot-side**: item autocomplete infrastructure, per-command-group cooldowns, a dedicated write-adapter client, and parameter validation are open, tracked in the bot's own repository.
- **Core-side**: an idempotency cache for `write/execute` (Section 3), and the three deferred endpoints in Section 7 (`guild.create`, `guild.rename`, `base.destroy`), which would each need their own write-bridge route table entries once built.
