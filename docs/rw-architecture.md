# RW Command Architecture — Discord Bot Write Operations

**Date:** 2026-08-08 (revised 2026-09-09, corrected after round-2, round-3, and round-4 audits, same day)

**Status:** Layer 1 Design (Requirement 20) — **NOT yet ready for Layer 2**

**Layer-1 exit gate, added after round-4 audit (was MEDIUM, batch #755, GRC hat — a real governance gap this session found in itself, not just in the design):** four consecutive audit rounds have now each found real CRITICAL/HIGH findings — including, in rounds 3 and 4, findings in the *immediately-prior round's own remediation*. **This design must not proceed to Layer 2 until a full Eight-Hat round finds zero new CRITICAL/HIGH findings against the immediately-prior round's corrections.** If any round finds CRITICAL/HIGH, another full round is mandatory, not optional, regardless of how many rounds that takes — treat "we ran an audit" as insufficient on its own; the outcome is what matters.

**Audit:** Eight-Hat Layer 1 round 1 (2026-08-08) filed #215-223. A first
2026-09-09 revision gave #215/#222 a real technical design and attempted to
resolve #216/#217. **Round 2** found that revision had fundamental,
independently-cross-corroborated flaws: an internal credential with no
verified binding to loopback traffic and no scoping to the bridge's own
routes (4 of 8 hats), a tier ladder unenforceable by either existing IAM
system (2 of 8 hats), and two real functional bugs in the route table
(`ban`/`unban` inverted, `give-item` wrong endpoint — 2 of 8 hats each).
Filed as #728-737, #740. **Round 3**, re-auditing those corrections rather
than assuming they held, found the credential fix itself was broken in two
*opposite* directions under real deployment configurations this project
already ships (fixed by moving the write bridge's loopback channel from TCP
to a Unix domain socket entirely), a new routing bug in `guild.remove`
(independently found by 2 hats), an actor-role-freshness fix that was a
bot-side-only promise Core had no way to enforce, an idempotency-cache
persistence fix that closed the restart-loss gap but reopened a narrower
concurrency-race version of the same double-execution risk, and a whole new
mechanism (the item catalog endpoint) with zero test coverage. Filed as
#742-747. **Round 4**, auditing the Unix-socket redesign and other round-3
fixes with the same fresh-eyes rigor as a first review, found the new
mechanism had at least three more CRITICAL gaps of its own: a pre-existing
`ADMIN_ALLOWED_IPS` gate that would silently 403 100% of write-bridge
traffic for operators using that config (2 hats, one empirically proven);
this project's own default root-UID container config collapsing the
socket's filesystem-permission trust boundary to "any root process on the
host" (3 hats); and — the most severe single finding across all four
rounds — the `roleSnapshotAt` fix from round 3 silently widening a *shared*
signed-fields array consumed by every actor-signed Discord route, breaking
`link`/`verify`/`unlink`/`steam-link`/`broadcast` on any Core/bot version
skew, which this codebase already has an explicit precedent (#691) warning
against (2 hats). Plus a global (not per-key) idempotency-queue DoS vector,
a stale-socket-file crash risk (3 hats, one empirically proven), and a
future-timestamp bypass in the freshness check. Filed as #749-755. Full
findings and STRIDE reports for all three rounds: comments on #215. This
section of the doc, and every section below it, reflects the design after
remediating all CRITICAL/HIGH findings from all three rounds. A **round-5**
Eight-Hat Layer 1 audit against this further-corrected version is still
required before Layer 2 begins, per the exit gate stated above — do not
assume this pattern has stopped just because this round's fixes look
thorough; rounds 2 and 3 looked thorough too.

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
| `clear-backpack <player>` | write/execute → `POST /api/players/.../clean-inventory` | `players:mutate` | **owner** | Yes (Discord-side confirmation only — user types `"CLEAN INVENTORY"`; this is a UX safeguard against misclicks, not independently verified against the typed text server-side — see Section 3.5's clarification. Wording corrected after round-4 audit, batch #755, UI/UX hat: a prior revision's "server-required phrase" wording implied server-side verification of the typed text, which is inaccurate) |
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
`"CLEAN INVENTORY"` as a Discord-side misclick safeguard — not independently
verified against the typed text server-side (see Section 3.5's clarification).
**Corrected after round-5 audit (was HIGH #760, UI/UX hat): a prior revision
of this sentence still said "requires typing the real server-required
confirmation string" — the identical inaccurate claim round 4 had already
fixed one paragraph away (the Group A table cell above), left uncorrected
here. Both places now agree.**

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
| `history clear` | write/execute → `POST /api/care-package/history/clear` | `carepackage:clear-history` | **owner** | Yes (requires typing `"CLEAR GRANT HISTORY"` — corrected after round-4 audit, batch #755, UI/UX hat: this row still showed the pre-round-3 wrong value even after Section 3.5's route table was corrected; both places must agree, Section 3.5's `WRITE_ACTION_ROUTES` is the single source of truth) |

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
  Body: { actor: {...}, action: "player.kick", params: { playerId: "..." }, idempotencyKey: "uuid" }
  Response: { ok: true, nonce: "uuid", expiresAt: 1766249032, preview: { ... } }

POST /api/integrations/discord/write/execute
  Headers: X-Dune-Actor-Signature, X-Dune-Actor-Timestamp
  Body: { actor: {...}, nonce: "uuid", action: "player.kick", params: {...}, idempotencyKey: "uuid" }
  Response: { ok: true, result: {...} }
```

**Corrected after round-3 audit (was MEDIUM, batch #747, Architect hat):** the `action` field's vocabulary is the dot-namespaced `WRITE_ACTION_ROUTES`/`WRITE_ACTION_MIN_TIER` key space (Sections 3.3a/3.5), e.g. `"player.kick"` — never a colon-namespaced console-IAM action string like `"players:mutate"`. A prior revision's example used the wrong vocabulary; both `write/preview` and `write/execute` reject an unrecognized `action` value via the fail-closed lookups in 3.3a/3.5, so this was never exploitable, but it was a real spec ambiguity a Layer 2 implementer could have followed literally.

**Security**: Both endpoints require `verifyActorSignature({ required: true })` + `requireDiscordCapability()`. Nonce is single-use with 60s expiry. Idempotency key prevents duplicate executions.

### 3.1 Dispatch mechanism: internal HTTP loopback, not a parallel implementation

`write/execute` must never reimplement what a real console route already does — every RW action's actual mutation logic (kick, restart, give-item, ...) already exists as a route handler in `server.js`, most delegating to `task()`/`confirmedTask()`. Those two functions are tightly coupled to real `req`/`res` (they read `req.authSession` for audit attribution, `req.socket.remoteAddress` for rate-limit keying, and some branches write directly to `res` — e.g. `maybeQueueRestart`). Reconstructing a synthetic `req`/`res` faithful enough for every one of the ~20 target routes is exactly the kind of "could this desynchronize from something I can't fully see" risk Strict Requirement 0 says to stop and flag, rather than one to walk into for a large win-nothing refactor.

Instead: `write/execute`, after validating the nonce, actor signature, and Discord capability, makes a **real internal HTTP request to Core's own real endpoint**. This reuses every real route handler, `task()`, `evaluate()`, and `audit()` call completely unchanged — zero duplicated mutation logic anywhere, so a future fix to (say) the real kick endpoint can never silently fail to apply to the Discord path. (Broadcast is the one deliberate exception — see Group F's note above; it already has its own safe, in-process, already-shipped path and doesn't need the loopback.)

**Corrected after round-2 audit (was CRITICAL #728, Network hat): a hardcoded `127.0.0.1` TCP target is wrong.** Verified: this project's own shipped default (`ADMIN_BIND_HOST=auto` in `.env.example`, combined with `network_mode: host` in `docker-compose.web.yml`) resolves `config.host` to a real LAN-facing IP via `detectPrivateIpv4()`, not loopback — a hardcoded `127.0.0.1` target would be unreachable (`ECONNREFUSED`) under this project's own default configuration. The round-2 fix (resolve the target from `config.host`/`config.port`, mirroring `webConsoleDisplayHost()`) genuinely closed *that* bug — but round-3 audit found the corresponding server-side fix (a `req.socket.remoteAddress === "127.0.0.1"` check, Section 3.4) is then **broken in two different directions simultaneously** by the exact same `config.host`-varies-by-deployment reality: it false-*rejects* every legitimate request when `config.host` is a real LAN IP (a same-host connection to a LAN-IP-bound socket reports that LAN IP as the remote address, not `127.0.0.1` — confirmed by a real bind/connect test on this host), and it false-*accepts* forwarded requests from anywhere when an operator has `CONSOLE_TRUSTED_PROXY_IPS` configured (a documented, tested, real deployment pattern this project already ships — a same-host reverse proxy makes every request it forwards appear to originate from `127.0.0.1`, regardless of true origin). Filed as #742.

**Corrected after round-2/round-3 audit: the loopback channel is a Unix domain socket, not TCP, eliminating both failure directions at once.** Rather than continuing to patch a TCP-address-based check (which is fundamentally deployment-topology-dependent — its correctness depends on `config.host`'s value and whether a trusted proxy is configured, both of which vary per operator), the write bridge uses a **second, separate `http.Server`** listening on a Unix domain socket path (`runtime/generated/discord-write-bridge.sock`, mode `0700`, owned by the same user Core runs as), sharing the exact same request-handler function the real TCP listener uses (`http.createServer(requestHandler)` called twice, `.listen()`'d on two different targets — a standard Node pattern, no duplicated routing logic). A Unix domain socket has no "remote address" a same-host proxy can alias, and its reachability depends only on filesystem permissions, never on `config.host`'s value — so neither direction of #742 can recur. The internal HTTP client (`write/execute`'s loopback caller) connects to this socket path directly (Node's `http.request({ socketPath, path, method, ... })`), never to `config.host`/`config.port` at all. A startup self-check (alongside Section 3.5's route-table self-check) performs one real request over this socket and fails loud (RW subsystem only, per Section 3.5's failure-scope correction) if it can't reach itself.

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

**Listener disambiguation, pinned explicitly after round-3 audit, corrected further after round-4 and round-5 audits — see below for both corrections:** since 3.1's Unix-socket server and the main TCP server share one `requestHandler` function (to avoid duplicating routing logic), the handler alone cannot tell which listener accepted a given connection from `req.socket` inspection — Unix-socket connections in Node don't populate `remoteAddress` the way TCP connections do, but relying on that absence as the sole signal repeats exactly the kind of implicit, easy-to-get-wrong inference #742 was about. Instead, each listener's own `http.createServer()` call wraps `requestHandler` in a small closure that passes an explicit flag: `http.createServer((req, res) => requestHandler(req, res, { viaWriteBridgeSocket: true }))` for the Unix-socket server.

**Corrected after round-5 audit (was CRITICAL #756, found and empirically reproduced by the Network hat): the TCP listener must NEVER omit the third argument.** A prior revision of this section explicitly sanctioned "`{ viaWriteBridgeSocket: false }` (or the flag simply omitted)" for the TCP listener — this is a real, empirically-reproduced whole-console outage: `requestHandler(req, res, opts)` with no default, called as `requestHandler(req, res)` (flag "simply omitted"), means `opts.viaWriteBridgeSocket` throws `TypeError` on `undefined` the instant an operator sets `ADMIN_ALLOWED_IPS`. Because `requestHandler` is `async`, this throw becomes a rejected promise the process's own generic `unhandledRejection` logger catches — the process does not crash, but `res.end()` is never called, so **every request to the entire console silently hangs** until the client times out (empirically reproduced: real reproduction script, confirmed `unhandledRejection` fire, confirmed client-side timeout with no response ever sent). This is strictly worse than the bug the listener-disambiguation flag itself was built to fix — it breaks the whole console, not just the write bridge, for the same operator population.

**Fixed, two independent layers of defense so this can never recur:** (1) the TCP listener's own `http.createServer()` call must always pass an explicit `{ viaWriteBridgeSocket: false }` — never omitted; (2) `requestHandler` itself declares `opts = {}` as a parameter default, so even a future refactor that accidentally drops the explicit argument fails safe (an empty object, `opts.viaWriteBridgeSocket` reads as `undefined`/falsy, not a thrown exception) rather than hanging the whole console. Layer 2 must add a unit test asserting a normal (non-write-bridge) request with `ADMIN_ALLOWED_IPS` set gets a real `200`/`403` response, never a hang.

The `discord-write-bridge` auth branch checks this flag first, before even looking at the token — a request that didn't arrive via the Unix-socket listener is never eligible for this principal type, full stop, regardless of what headers it carries.

**Corrected after round-4 audit (was CRITICAL #750, found independently by Architect + Network hats, Network hat's finding empirically reproduced), then narrowed further after round-5 audit (was HIGH #757, found independently by Security + Architect hats): `requestHandler`'s real, pre-existing `ADMIN_ALLOWED_IPS` gate must exempt genuinely-authenticated write-bridge requests, not just Unix-socket-listener traffic in general.** `server.js`'s real dispatcher checks `config.allowedIps` *before* any routing/auth logic runs, on every request — `req.socket.remoteAddress` is `undefined` for a Unix-socket connection (empirically confirmed), which normalizes to `""`, which can never match a configured allowlist entry, so every write-bridge request would be unconditionally 403'd for any operator with `ADMIN_ALLOWED_IPS` set (the officially-documented, code-enforced compensating control for `ADMIN_AUTH_DISABLED=1` on a non-loopback bind — exactly the operators running the most security-conscious supported configuration) unless exempted.

**Round-4's first fix exempted this check purely on the listener flag (`opts.viaWriteBridgeSocket === true`) — round 5 found this is too broad and, separately, impossible to implement as described.** Per Section 3.2, a request arriving over the Unix socket that fails the token check or doesn't match a `WRITE_ACTION_ROUTES` entry "falls through to normal `requireAuth()` behavior," not an outright rejection. Exempting `ADMIN_ALLOWED_IPS` purely on the listener flag means **every** request over the socket skips the IP check, including ones that fall through to plain `requireAuth()` — under `ADMIN_AUTH_DISABLED=1` (where `requireAuth()` returns a synthetic owner-tier session for any request with zero credential check), any same-permission local process could open a plain, credential-less request over the socket and land in `requireAuth()` with full unauthenticated owner-tier API access, defeating the exact compensating control the operator turned on `ADMIN_ALLOWED_IPS` to provide. Separately, the flag itself has no described path to the code that needs it: `handleApi(req, res)` and `auth.requireAuth(req, res)` are both real, existing 2-argument functions with no `opts`/path parameter — the flag cannot reach the auth-resolution branch as literally described.

**Fixed:** (1) `handleApi(req, res, opts)` and `auth.requireAuth(req, res, path, opts)` both gain the additional parameters explicitly required to thread `opts.viaWriteBridgeSocket` and the already-canonicalized `path` through to the credential-check branch — named here explicitly so a Layer 2 implementer isn't left to invent the wiring; (2) the `ADMIN_ALLOWED_IPS` exemption applies only once a request has been confirmed as a genuinely-authenticated `discord-write-bridge` principal (valid token, path-scoped match) — not to every request the socket listener merely accepted. A request that fails write-bridge auth and falls through to `requireAuth()` remains fully subject to `ADMIN_ALLOWED_IPS`, exactly as it would over the TCP listener.

**Corrected after round-4 audit (was HIGH #753, found independently by Network — empirically reproduced — + UI/UX + QA hats): the Unix-socket listener needs explicit restart-safety handling neither 3.1 nor 3.4 previously specified.** A Unix-socket file (unlike a TCP port) persists on disk across an unclean shutdown (OOM-kill, `docker restart`, host power loss) — `runtime/generated/` is a host bind-mount, not tmpfs, so a stale socket file survives a container restart. Empirically confirmed: (a) a stale file at the target path makes the next `.listen(socketPath)` fail with a real `EADDRINUSE`; (b) an unhandled `'error'` event on that listener throws by default, crashing the *entire* Node process — directly reproducing the whole-console-outage risk Section 3.5's failure-scope fix was written to prevent, just via a different startup path than the one that fix patched. **Fix:** (1) before `.listen(socketPath)`, remove any pre-existing file at that path (`fs.rmSync(socketPath, { force: true })` or equivalent stat-and-unlink); (2) attach an explicit `.on("error", ...)` handler to this specific `http.Server` instance that logs loudly and disables the RW subsystem only (matching Section 3.5's existing pattern), never left to the default throw-and-crash behavior.

**Corrected after round-5 audit (was MEDIUM, batch #762, Network hat — empirically reproduced and a mitigation empirically validated): unconditional unlink-before-listen removes the one signal that would otherwise catch two Core instances overlapping.** A prior revision's "remove any pre-existing file" step doesn't distinguish a genuinely stale file (no live listener behind it) from a file backing a *currently live* listener (e.g. a brief overlap between an old and new container during a restart). Empirically confirmed: an unconditional `fs.rmSync` silently deletes a still-live listener's directory entry, and the second process's `.listen()` then succeeds cleanly — zero `EADDRINUSE`, zero error-handler firing, on either process. The first process keeps running but becomes unreachable via the path (an orphaned instance holding resources); the second silently takes over all new traffic. This is a real regression relative to the un-patched behavior for exactly the overlap condition Section 3.4's single-process assumption already flags as the one thing that would invalidate this whole design's premises — turning a loud failure into a silent one. **Fix:** before unlinking, probe with a real `net.connect({ path: socketPath })` (short timeout). If the connect succeeds, a live listener is already there — do **not** unlink; treat it exactly like a genuine `EADDRINUSE` (log loud, disable the RW subsystem only, matching Section 3.5's pattern) and let the rest of Core boot normally. Only unlink when the probe fails (`ECONNREFUSED`/`ENOENT`, i.e. genuinely stale) — empirically validated this exact mitigation correctly distinguishes both cases.

**Corrected after round-4 audit (was MEDIUM, batch #755, Architect/Cloud Security/Security hats): the socket's `mode 0700` claim needs an explicit mechanism.** Node's `http.Server`/`net.Server` for AF_UNIX sets permissions from the process umask at bind time, not a fixed `0700` — nothing produces that mode automatically. **Fix:** call `fs.chmodSync(socketPath, 0o700)` immediately in the `'listening'` callback (after the stale-file cleanup and error-handler attachment above), and add a startup self-check assertion that the resulting file mode is exactly `0700` before considering the RW subsystem healthy.

**Corrected after round-5 audit (was MEDIUM, batch #762, Security hat): chmod-after-listen leaves a real, if brief, TOCTOU window at ambient-umask permissions.** Node's `bind()` for a Unix-domain-socket path happens synchronously inside `.listen()`, creating the socket file on disk — but the `'listening'` event (where `chmodSync(0700)` runs, per the fix above) fires on a later tick. Under a common container umask (e.g. `022`), the file sits at mode `755` (world-connectable) for that window. Bounded by the credential's second check (the in-memory token, still required even with filesystem reachability) so this isn't a full bypass on its own — but "chmod after listen" is a well-known anti-pattern for exactly this reason, in a mechanism built specifically to close a permission boundary. **Fix:** set a restrictive `process.umask(0o077)` immediately before `.listen(socketPath)`, restoring the process's prior umask right after `.listen()` returns (or in the `'listening'` callback) — so the socket file is created with safe permissions atomically at bind time, eliminating the window rather than closing it after the fact. Keep the existing `chmodSync` + startup self-check assertion as defense-in-depth on top of this, not as the sole mechanism.

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

**Corrected after round-3 audit (was MEDIUM, batch #747, Security hat Finding B): the branch's implementation location and its interaction with the existing CSRF check must be pinned explicitly, not left implicit.**

- **Path-scoping must reuse the already-canonicalized `path` value, never re-parse `req.url`.** The exact-match check against `WRITE_ACTION_ROUTES` (above) must consume the same `path` variable `server.js`'s own dispatcher already computes once via `new URL(req.url, "http://localhost").pathname` (`server.js:666-667`) — passed into this branch as a parameter, not independently re-derived inside `auth.js`. Two separate parses of the same input risk a normalization mismatch (querystring handling, `.`/`..` collapsing, trailing slashes) between what the credential check approves and what actually gets dispatched — exactly the class of confusion #728's path-scoping fix exists to prevent.
- **This branch bypasses `requireAuth()`'s existing CSRF check entirely — a stated design decision, not an inferred one.** `auth.js`'s CSRF check (`csrf !== session.csrf`, applied to every non-GET/HEAD/OPTIONS request) is a browser/cookie-forgery defense; it doesn't apply to a bearer-style internal credential authenticated over a Unix socket, and the write-bridge's internal HTTP client is not described anywhere as sending an `X-Csrf-Token` header. If the synthesized session were routed through the *existing, unmodified* CSRF check, every real write/execute call would be rejected (`undefined !== null`). The `discord-write-bridge` branch must short-circuit around that check entirely, immediately after path-scoped credential verification succeeds — `csrf: null` in the synthesized session object (above) exists to make this the correct, deliberate outcome if the bypass is implemented as a distinct code path, not to accidentally satisfy the general check via a coincidental match.

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
  if (!Object.hasOwn(WRITE_ACTION_MIN_TIER, action)) {
    throw new Error(`No minimum tier defined for action "${action}"`); // fail closed, not open
  }
  return TIER_RANK[actorTier] >= TIER_RANK[WRITE_ACTION_MIN_TIER[action]];
}
```

Checked explicitly by both `write/preview` and `write/execute`, before the loopback call — this table's rows are Section 1's tier ladder made literal and enforced, not an assumption about what `evaluate()`/`CAPABILITY_BY_TIER` already do. The fail-closed throw is deliberate: a `WRITE_ACTION_ROUTES` entry with no corresponding `WRITE_ACTION_MIN_TIER` entry must fail closed, not silently default to the lowest tier. `broadcast.*` is intentionally absent from this table too (see Group F's note) since it's gated by the existing, separate `requireDiscordCapability()` path instead.

**Corrected after round-3 audit (was MEDIUM, batch #747, Architect hat):** a prior revision used a bare `WRITE_ACTION_MIN_TIER[action]` lookup — the same poisoned-key risk (`"constructor"`/`"__proto__"`/`"toString"`) Section 3.5's `WRITE_ACTION_ROUTES` lookup already guards against with `Object.hasOwn`. Traced through: the bare lookup didn't actually escalate privilege (a poisoned key resolves to a non-tier value, so the comparison still evaluates false), but it silently denied access instead of firing the loud, diagnostic throw the code's own comment claims — an inconsistency with the identical defensive pattern mandated for the sibling table. Fixed above with the same `Object.hasOwn` guard.

### 3.4 Internal credential: in-memory only, never persisted, and never trusted without source verification

Because the loopback never leaves the host, there is no need for a `runtime/secrets/`-style persisted, rotatable credential (and inventing one would be new attack surface with no corresponding benefit — nothing outside this one Node process ever needs to present it). A single random token (`crypto.randomBytes(32)`) is generated once at server boot and held only in module-level memory, shared directly between the bridge's internal HTTP client and the new auth-resolution branch — nothing written to disk, nothing to rotate.

**Rotation: N/A.** Explicit, per Requirement 27's intent — in-memory, per-process-lifetime only, invalidated automatically on every restart. No rotation cadence needed because there is nothing to rotate. (See the single-process assumption below for the one condition that would invalidate this premise — added as an explicit cross-reference after round-3 audit, Cloud Security finding, batch #747.)

**Corrected after round-3 audit (was CRITICAL #742, found independently by Network + Security hats): a TCP-source-IP check cannot be the trust boundary here, no matter how it's tuned.** A round-2 revision of this section required `req.socket.remoteAddress === "127.0.0.1"/"::1"` as a mandatory gate alongside the token. Round-3 audit found this check is unreliable in *both* directions under real deployment configurations this project already ships (see 3.1's corrected note) — the fundamental problem is that "is this TCP connection's source address a loopback literal" is not actually equivalent to "did this connection originate from a genuinely local, trusted process," once `config.host` can be a real LAN IP or a trusted reverse proxy can sit between the two. No amount of retuning the address comparison closes both directions at once, because the two failure modes pull in opposite directions (accepting a wider set of "looks local" addresses fixes the false-reject but widens the false-accept surface, and vice versa).

**Fixed instead by moving off TCP entirely (3.1): the write bridge listens on a Unix domain socket** (`runtime/generated/discord-write-bridge.sock`, mode `0700`, same user as the Core process). The credential check becomes a **mandatory two-part gate**, both required, but now each part addresses a genuinely different, orthogonal risk:

1. **Reachability is filesystem-permission-gated, not network-address-gated.** Only a process with `0700` read/write access to the socket file — i.e., a process running as the same user as Core, on the same host — can ever open a connection at all. This has no dependency on `config.host`'s value and no TCP "remote address" for a same-host reverse proxy to alias, because a Unix domain socket connection has neither.
2. **The token itself, compared via `crypto.timingSafeEqual`** (matching the existing pattern already used for actor-signature comparison in `integrations/discord/actorSignature.js:88-93`'s `constantTimeHexEqual` — including that function's length-equality guard *before* calling `timingSafeEqual`, added explicitly after round-4 audit, batch #755: `crypto.timingSafeEqual` throws `RangeError` on mismatched-length buffers, so the comparison must check `receivedToken.length === realToken.length` first, exactly as the cited precedent does, not a bare call that could throw on a malformed-length token), as defense-in-depth against a bug elsewhere in this same process that might expose the socket path to unintended callers within the process's own privilege boundary.

Both checks live in the same auth-resolution branch; failing either falls through to normal `requireAuth()` behavior, never a distinct error that would help an attacker distinguish which check failed. Residual risk after this fix: another process running as the *same host user* as Core (not "any process on the host," as filesystem permissions restrict this) could theoretically connect to the socket and, if it also somehow obtained the in-memory token, forge a request — but that threat model already has direct access to everything else this Core process protects (it could simply read the process's memory, its `runtime/secrets/` files, or its database credentials directly) — no incremental exposure from that angle. The incremental exposure this fix closes relative to round 2's attempt is deployment-topology-dependent reachability, which a Unix socket structurally cannot have.

**Corrected after round-4 audit (was CRITICAL #751, found independently by Architect + Security + Cloud Security hats): "the same host user" is not automatically a small, scoped identity — under this project's own shipped default, it's root.** `docker-compose.web.yml` sets `user: "${DUNE_HOST_UID:-0}:${DUNE_HOST_GID:-0}"` — absent an explicitly-set env var, the console container runs as **UID/GID 0**. Root bypasses Unix DAC permission checks entirely, so `0700` on the socket file provides zero protection against any other root-running process on the host (including any other container an operator runs without hardening — the main compose service already bind-mounts the entire repo root, a pattern trivially replicable by a second container). This isn't hypothetical for this codebase: `config.js`'s `repairRootOwnedHostState()` (called at every config load) exists specifically because "Core running as root while `/repo` is host-owned by a real user" is a real, previously-hit operational state, and its repair list explicitly includes `runtime/generated` — the exact directory the write-bridge socket lives in. Under the root-UID default, "the same user" balloons from a small, contained set to "any root process on the host," directly undermining this section's own residual-risk framing.

**Fix:** the write-bridge startup self-check refuses to enable RW routes if `process.getuid() === 0`, logging loud and pointing operators at `DUNE_HOST_UID`/`DUNE_HOST_GID` (documented as a hard prerequisite for enabling Discord RW commands in `docs/integrations/discord-integration/admin-guide.md` — corrected after round-5 audit, batch #762, Cloud Security hat: a bare `admin-guide.md` reference is ambiguous, since this repo has two files with that name; use the full path as elsewhere in this doc). Until that guard exists, this section's residual-risk claim should be read as "best-effort defense-in-depth, not a hard boundary, for any deployment running Core as root" rather than the stronger claim a prior revision implied.

**Precedent citation corrected after round-5 audit (was LOW, batch #762, Cloud Security hat): a prior revision cited `config.js`'s `process.getuid()` usage as "this codebase's own established pattern" for refusing to start — this is inaccurate.** The real `repairRootOwnedHostState()` (`config.js`) does the *opposite*: it only takes action (repairing host-file ownership) when running as root, then lets startup continue normally; the other two real `process.getuid()` call sites in this codebase (`tasks.js`, `server.js`) use it purely as a fallback default for `DUNE_HOST_UID`, not as a gate. This codebase has zero existing precedent for "refuse to start under a specific UID condition" — this write-bridge guard is a genuinely new check, standing on its own security reasoning, not a reuse of an established convention. The check itself is still correct and necessary; only the "established pattern" framing was wrong.

**Operator-facing completeness, added after round-5 audit (was HIGH #760, UI/UX hat): this failure mode needs the same treatment as this design's other two startup-failure cases, not less — root is this project's own shipped default, so this is the *expected* first encounter for any operator enabling RW writes without already knowing about `DUNE_HOST_UID`/`DUNE_HOST_GID`, not a rare misconfiguration.** This refusal reuses the exact same "RW subsystem disabled" `503` error-table row and disable-RW-routes-only pattern already established in Section 3.5/3.2 (above) — not a distinct, undocumented case. Layer 2 must add the same troubleshooting-doc-entry commitment Section 3.5 already carries for route-table drift, specifically naming "Core is running as root, set `DUNE_HOST_UID`/`DUNE_HOST_GID` and restart" as the concrete, self-serviceable fix — since unlike the other two failure modes, this one has a genuinely actionable one-line resolution an operator can apply immediately once told.

**Single-process assumption, stated explicitly (round-2 audit, Cloud Security LOW):** this design assumes Core runs as exactly one Node process (verified true today — `Dockerfile`'s `CMD` is a bare `node server.js`, no cluster/PM2, no Compose `replicas`). If multi-worker scaling is ever introduced, this section must be re-evaluated — each worker would generate its own token, and a loopback request could be routed to a different worker than the one holding the matching credential.

### 3.5 Route/action mapping table (resolves #216)

**Corrected after round-2 audit (was CRITICAL #730, found by DBA + Architect hats):** two entries in a prior revision of this table were real, functional bugs, not just documentation gaps — `player.ban` mapped to the same `DELETE .../ban` call as `player.unban` (there was no real ban action at all: invoking `/dune player ban` would have issued a DELETE and silently unbanned the target), and `player.give-item` targeted a storage-container endpoint instead of the real player-scoped grant route. Both fixed below. `server.maintenance` removed — no such Core route exists (moved to Section 7).

Each entry also now carries an optional `confirmPhrase`, forwarded into the loopback body's `confirmation` field for routes with a hardcoded server-side requirement (round-2 audit HIGH #732 — several targeted routes require an exact phrase Core checks server-side that a prior revision never accounted for passing through at all).

**`confirmPhrase` is a UX safeguard, not an independent security boundary — stated explicitly after round-3 audit (was MEDIUM, batch #747, Security hat Finding D).** These values are static constants the bridge auto-injects unconditionally into the loopback body for any request that already has a valid nonce, actor signature, and passed capability/tier checks — they are never compared against anything the Discord user actually typed. Once past the Discord bot's own UI, a "Type confirmation string" route and a "Button click" route (Section 4) are equivalent at the Core API boundary: both are satisfied automatically by a valid signed envelope + consumed nonce. The real security boundary for every write action is the nonce + actor-signature + capability + tier + rate-limit stack, identical regardless of confirmation style — `confirmPhrase` exists only to prevent an accidental Discord misclick, reusing the real endpoint's own pre-existing phrase gate rather than reimplementing it. If stronger protection is wanted (verifying the Discord user's actually-typed string), that would be a genuinely new, separate design decision — not something the current design already provides.

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
  "carepackage.history-clear":{ method: "POST", path: () => `/api/care-package/history/clear`, confirmPhrase: "CLEAR GRANT HISTORY" },
  "guild.add":            { method: "POST",   path: (p) => `/api/guilds/${encodeURIComponent(p.guildId)}/members` },
  "guild.remove":         { method: "DELETE", path: (p) => `/api/guilds/${encodeURIComponent(p.guildId)}/members/${encodeURIComponent(p.playerId)}` }
};
```

**Corrected after round-3 audit (was HIGH #743, found independently by 2 hats — Architect, Cloud Security):** `guild.remove`'s path template was missing the target member's id entirely (`.../members` with no third segment) — the real handler, `guildRemoveMemberRoute` (`server.js:3650-3654`), requires both `guildId` and `playerId` path segments, matched only by `/^\/api\/guilds\/[^/]+\/members\/[^/]+$/`. As previously specified, invoking `/dune guild remove` would 404 permanently. Fixed above; confirm the bot's `guild.remove` command actually collects and forwards a `playerId`/member-identifier param, not just `guildId`, when this is implemented at Layer 2.

**Corrected after round-3 audit (was MEDIUM, batch #747, Architect hat, independently verified against real code):** `history-clear`'s `confirmPhrase` was `"CLEAR HISTORY"` — verified wrong; the real endpoint (`server.js:3570-3573`) requires exactly `"CLEAR GRANT HISTORY"`. Fixed above.

(`broadcast.*` is intentionally absent — see Group F's note; it never goes through this table or the loopback.)

**Lookup safety (round-2 audit, Security MEDIUM #740):** `action` arrives directly in an actor-signed request body, so lookups must use `Object.hasOwn(WRITE_ACTION_ROUTES, action)` before indexing — a bare `WRITE_ACTION_ROUTES[action]` risks resolving `"constructor"`/`"__proto__"`/`"toString"` to a truthy inherited value instead of `undefined`, an unhandled-exception crash vector.

**Param validation (round-2 audit, Security MEDIUM #740):** `encodeURIComponent` alone is not sufficient shape validation — it escapes `/` but not `.`, so a value of exactly `".."` can shift which real route is requested after URL normalization. Every `playerId`/`baseId`/`guildId` must be validated against a strict ID-shape pattern (matching Core's real ID format) *before* being passed into a `path()` template, not relied on to be made safe by `encodeURIComponent` alone.

At startup, a self-check resolves every `path()` template against a representative param set and confirms the resulting `(method, path)` matches a real entry in `actions.js`'s `ROUTE_ACTIONS`/`REGEX_ACTIONS_BY_METHOD`/`REGEX_ACTIONS`.

**Failure scope, stated explicitly (round-2 audit, UI/UX CRITICAL #737):** a prior revision said this "refuses to boot with a loud error" without scoping the blast radius — Core also serves the entire game console/API to every operator of this fork, not just Discord write commands, so an unscoped crash on drift would take down the whole self-hosted stack on a routine update. **The self-check must fail closed on the RW subsystem only**: log the specific drifted entry loudly, disable write-bridge routes entirely, and let Core boot and serve everything else normally. A future update that breaks a `WRITE_ACTION_ROUTES` entry must never be able to take an operator's whole console offline. Layer 2 must also add a troubleshooting entry (`admin-guide.md`/`faq.md`) naming this exact failure mode and what an operator should do about it.

**Corrected after round-2 audit (was HIGH #731, Architect meta-finding C4): this self-check has a real, structural blind spot and must not be described as a complete fix for #216-class drift.** It can only prove a `(method, path)` pair resolves to *some* known action — `actions.js`'s action namespace is deliberately coarser than `server.js`'s actual per-path handler identity, so it would have passed the original ban/unban-inversion and give-item-wrong-endpoint bugs cleanly (both resolved to real, valid actions). **Required addition, Layer 2:** a second, independent verification — an integration test per `WRITE_ACTION_ROUTES` entry that exercises it against a real (test) Core instance and asserts the actual expected effect, not just that the self-check passes.

### 3.6 `GET /api/items` catalog endpoint (resolves #222)

A new read-only Core endpoint, `GET /api/items?q=<prefix>&limit=25`, gated **only** by the Discord bot's own capability system (`requireDiscordCapability`, minimum tier `moderator`) — not by console `policy.js` (round-2 audit, Security MEDIUM #740: a prior revision reasoned in console-IAM vocabulary for an endpoint whose only real caller is the Discord bot's own autocomplete handler, conflating the two separate tier spaces Section 0 itself declares independent). Backed by the real item **catalog** (names/ids/volume/stack size — `runtime/data/admin-items.json` via `adminCatalog.js`) with a simple case-insensitive prefix match, capped at 25 results (Discord's own autocomplete choice limit) and required to respond within the bot's autocomplete 3s budget — an in-memory index built once at boot, not a per-request read.

**Corrected after round-2 audit (was HIGH #736, DBA hat):** a prior revision claimed this reuses "the same source of truth" as `give-item`'s item-type allowlist per #218 — **false**. #218 is still open; none of its required mitigations (quest-item/admin-only-flag exclusion, 1-stack cap, 10/day volume limit) exist anywhere in this codebase today, and `admin-items.json` has no data field that could back such a filter. This endpoint reuses the item **catalog only** (for autocomplete display purposes) — the safety allowlist #218 requires is separate, not-yet-built enforcement that must still be added to `giveSingleItemRoute` (`server.js:1271`, the real handler behind `POST /api/players/:id/give-item` — see Section 3.5's route table; not the similarly-named but unrelated storage/base-container give-item routes), not something this endpoint provides. (Cross-reference named explicitly after round-3 audit, DBA finding, batch #747 — a prior revision left this pointer vague enough that a future implementer could misplace the fix among several similarly-named routes.)

**Catalog refresh policy, stated explicitly (round-2 audit, DBA MEDIUM #740):** `admin-items.json` changes are git-committed/deploy-only (no runtime write path exists) — a catalog update requires a Core restart to take effect in this new in-memory index. This matches `adminItemMetadata()`'s existing caching discipline in `duneDb.js`, but differs from `adminCatalog.js`'s other functions (`resolveCatalogItem` etc.), which live-read the file on every call — that inconsistency already exists today and isn't introduced by this design, but is worth this one-line acknowledgment for a future reader.

### 3.7 `DUNE_DISCORD_WRITES_ENABLED` parsing (resolves #217)

**Corrected after round-2 audit (was HIGH, GRC + Architect hats):** a prior revision of this section claimed Core needed no change ("keeps its existing `'1'` convention... changing it would ripple into other already-shipped config reads") and only the bot needed updating. **This premise was stale by a month** — verified directly: Core's real `discordWritesEnabled()` (`integrations/discord/adapter.js:144-147`) already accepts both `"1"` and `"true"` case-insensitively, per an upstream merge (`9bdf2fe5b`, 2026-08-11) that predates this revision, with an existing passing test (`console/api/test/discordAdapter.test.js`) asserting exactly this. **No Core change is needed for #217 at all.** Remaining scope, if the bot side still diverges: update the bot's own `writesEnabled()` (`writes.js`) to accept both values the same way, so an operator who set either value during the read-only/experimental period keeps working across the fix (Strict Requirement 0's update-path rule) — verify the bot's current behavior before assuming this is still needed, rather than repeating the same "assumed stale, never checked" mistake this correction is fixing.

**Operator-facing doc conflict (round-2 audit, GRC MEDIUM #740; deferral tightened after round-3 audit found the original deferral had no real owner, GRC MEDIUM #747):** `docs/integrations/discord-integration/admin-guide.md` and `faq.md` currently show `DUNE_DISCORD_WRITES_ENABLED=true` as the canonical example — needs reconciling with whichever value ends up canonical once the bot-side check is verified. Owner: the same PR that implements 3.7's bot-side `writesEnabled()` check must also update these two doc files in the same PR (Requirement 14) — not a separately-scheduled follow-up with no name attached. **Fallback owner, added after round-4 audit (was LOW, batch #755, GRC hat):** if bot-side verification finds no change is actually needed (plausible, since Core's own side already required none), the PR this owner clause is anchored to may never exist — in that case, file a `docs:accuracy` issue on `meta` to reconcile `admin-guide.md`/`faq.md` against whichever value is verified canonical, in the same session the verification is done, rather than leaving the conflict unowned.

**Kill-switch re-check point, stated explicitly (round-3 audit, UI/UX HIGH #747):** unlike min-tier (3.3a) and actor-role freshness (above), a round-2 revision never stated *where* `discordWritesEnabled()` is actually checked. It must be checked at **both** `write/preview` and `write/execute`, independently, before any nonce is issued and again before any loopback call is made — matching the same dual-checkpoint pattern this section already uses for min-tier and role freshness. Without the execute-time check, an operator flipping the switch off between a user's preview and their confirm-click would not actually prevent the mutation, and the dedicated kill-switch error message (Section 4) would never be shown for the exact race it was added to cover.

**Socket listener vs. kill switch, stated explicitly (round-4 audit, was MEDIUM, batch #755, UI/UX hat):** the Unix-socket listener (3.1) always starts at Core boot regardless of `discordWritesEnabled()`'s value — the kill switch is checked only at the application layer, inside `write/preview`/`write/execute`, per the dual-checkpoint rule above. This is a deliberate choice, not an oversight: env vars are read once at boot, so gating listener startup on a value that can't change without a restart anyway would add complexity for no operational benefit, and it keeps the self-check's failure semantics (Section 3.5) about one thing (route-table/socket health) rather than conflating it with the kill switch's own state. **Operators must not treat "does `discord-write-bridge.sock` exist" as a reliable signal for "are writes currently enabled"** — the socket's presence only indicates the RW subsystem started successfully, not that the kill switch is on.

### 3.8 Error mapping, rate limiting, freshness, and idempotency

Unchanged from the table in Section 4 below (`200`/`400`/`403`/`409`/`429`/`500`/`503`, plus a new `410` row added after round-2 audit — see Section 4) — the loopback response's real HTTP status from Core's own endpoint is what the bridge maps through directly.

**Rate-limit isolation, corrected after round-2 audit (was HIGH #733, Security hat):** Core's existing `applyMutationRateLimit()` (called by every real target route) keys on `` `${scope}:${sessionId}:${remoteIp}` `` — `sessionId` comes from `req.authSession.id`, `remoteIp` is constant for every loopback call (previously always `127.0.0.1` under the round-2 TCP design; now, under round-3's Unix-domain-socket design in 3.1/3.4, `req.socket.remoteAddress` is empty/`undefined` for a Unix socket connection — the design must ensure `resolveClientIp()`/whatever populates `remoteIp` for rate-limit keying treats this consistently, e.g. a fixed sentinel string, rather than producing an inconsistent or empty key across calls). Either way, `remoteIp` alone was never going to distinguish Discord actors — that's `id`'s job. A prior revision's synthesized `authSession` (3.2) had no `id` field, so every Discord actor performing the same action would have collapsed into one shared rate-limit bucket, the opposite of this section's own "3 actions/30s per actor" claim. Fixed in 3.2: the synthesized session now carries `id: \`discord:${actor.userId}\``, so existing rate-limit keying isolates per Discord user exactly as it already does for browser/API-key sessions — no change needed to `applyMutationRateLimit()`'s keying formula itself, only confirm `remoteIp`'s Unix-socket value doesn't itself throw or produce `undefined` string-concatenation artifacts in the key.

**Actor-role freshness, corrected after round-2 audit (was HIGH #734, Security hat), then given a real enforcement mechanism after round-3 audit found the round-2 fix was a bot-side-only promise (was HIGH #744, Security hat):** "actor signature + capability re-validated at both preview AND execute" only proves the same functions ran twice — it doesn't prove `actor.roleIds` presented to `write/execute` reflects the actor's *current* Discord roles rather than a value cached from the original slash-command interaction. The round-2 fix required the bot to re-derive `actor.roleIds` at confirm-click time — correct, but Core had no way to verify it actually happened, since `verifyActorSignature()`'s freshness window (`DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS`, default 30s) only bounds *when the envelope was signed*, not *when the `roleIds` inside it were fetched from Discord*.

**Required, Core-enforceable fix, corrected after round-4 audit (was CRITICAL #749, found independently by Cloud Security + Security hats): do not add `roleSnapshotAt` to the shared `SIGNED_ACTOR_FIELDS` array.** A prior revision of this fix did exactly that — `SIGNED_ACTOR_FIELDS` is a single, module-level array consumed by `canonicalActorSignaturePayload()` for **every** actor-signed route in the Discord adapter (`link`, `verify`, `unlink`, `steam-link`, not just the write bridge), and this codebase already has an explicit, on-point precedent (issue #691, referenced in `policy.js`'s own comments) warning that expanding this array requires "a separate, coordinated, versioned rollout across both repos" — because Core and the bot ship on independent release trains. Silently widening the shared field set would break every one of those already-shipped routes the moment Core deploys ahead of the bot (or vice versa), which is the *normal* rollout condition, not an edge case — exactly the "could this desynchronize from something outside this codebase I can't see" scenario Strict Requirement 0 exists to catch.

**Fixed instead: `write/preview` and `write/execute` are brand-new routes with no existing wire format to preserve, so they define their own, independent signed-field set from inception — never touching the shared array.** A new constant, `WRITE_BRIDGE_SIGNED_ACTOR_FIELDS` (in `writeActionRoutes.js`, alongside `WRITE_ACTION_ROUTES`/`WRITE_ACTION_MIN_TIER` — not in `actorSignature.js` at all), includes `roleSnapshotAt` from day one: `["userId", "username", "roleIds", "guildId", "channelId", "roleSnapshotAt"]`. **Corrected after round-5 audit (was LOW, batch #762, GRC hat): this is a new, independent field set, not a strict "mirror plus one field" as a prior revision described** — the real shared array is `["userId", "guildId", "channelId", "roleIds", "interactionId"]`, so the write-bridge's set actually adds `username` (a real actor field, just not currently in the shared signed subset) and deliberately omits `interactionId` — the write bridge doesn't need it since the 60s nonce/expiry (below) already binds each request to one specific confirm-click, making a separate per-interaction replay guard redundant here.

**Threading, made explicit after round-5 audit (was MEDIUM, batch #762, found independently by Cloud Security + Architect hats): three functions need the new parameter, not one.** A prior revision said only "`verifyActorSignature()` gains an optional `signedFields` parameter" — but the real `verifyActorSignature()` computes its expected signature via `signActorPayload()`, which itself calls `canonicalActorSignaturePayload()` — the function that actually hardcodes the shared `SIGNED_ACTOR_FIELDS` array. All three (`canonicalActorSignaturePayload()`, `signActorPayload()`, `verifyActorSignature()`) must gain the same optional `fields`/`signedFields` parameter, each defaulting to `SIGNED_ACTOR_FIELDS` so every existing caller is unaffected, threaded through in that order. Left unspecified, a Layer 2 implementer facing "thread a parameter through three functions across the call chain" might reasonably reach for the smaller-looking shortcut of folding `roleSnapshotAt` back into the shared array — reintroducing the exact CRITICAL #749 this whole redesign exists to prevent. The **bot-side** signing call must also pass this same override explicitly when producing the envelope for `write/preview`/`write/execute` — it can never produce a signature Core will accept otherwise.

This has zero compatibility risk for `link`/`verify`/`unlink`/`steam-link`/`broadcast` — none of them are touched — and zero rollout-ordering risk for the write bridge itself, since it and its signing contract ship together as one new feature. Domain separation between the two field sets is already sound without any further change: `canonicalActorSignaturePayload()`'s signed message already includes the server-resolved, never-attacker-controlled `route` string, so a signature computed for `write/preview`'s route can never be reinterpreted as valid for `link`'s or any other route's — no additional domain-separator prefix is needed.

`write/execute` first validates `Number.isSafeInteger(roleSnapshotAt) && roleSnapshotAt > 0` — rejecting immediately on failure — **added after round-5 audit (was MEDIUM, batch #762, DBA hat): a prior revision of this enforcement stated only the comparison, omitting this upstream validation step despite claiming to "match `verifyActorSignature()`'s own existing `timestamp` skew check exactly," which does validate first (`Number.isSafeInteger(timestamp) && timestamp > 0`, `actorSignature.js`). Without it, a malformed value (`NaN`, a string, `undefined`) produces `Math.abs(now - NaN) === NaN`, and `NaN > maxRoleAgeSeconds` is always `false` in JavaScript — silently PASSING the freshness check instead of rejecting, neutralizing the entire #734/#744/#749/#754 fix chain with no attacker involvement, just a bot-side bug.** Only once that validation passes does `write/execute` enforce `Math.abs(now - roleSnapshotAt) > maxRoleAgeSeconds → reject` (bounded in *both* directions, matching `verifyActorSignature()`'s own existing `timestamp` skew check exactly — a prior revision of this enforcement formula only bounded staleness, not a future-dated value, found separately as #754) before consulting `actor.roleIds` for anything. This doesn't prove the bot genuinely re-queried Discord, but it closes the specific, concrete bug this fix targets — an accidental replay of the original interaction's cached payload — and gives Core an actual enforceable invariant instead of a doc-only promise, consistent with how every other trust boundary in this design is treated.

**Nonce store**: an in-memory `Map<nonce, { actorUserId, action, params, expiresAt }>`, single-use (deleted on first consumption), 60s TTL. A server restart mid-confirmation simply expires the pending nonce — nothing has mutated yet, so losing it is safe; the user just retries.

**Idempotency cache — corrected after round-2 audit (was HIGH #736, DBA hat): must be persisted, not in-memory.** A prior revision justified an in-memory-only idempotency cache by citing `restartQueue`'s "in-memory entries" as precedent — **this citation was factually wrong**: `services/restartQueue.js`'s `readState`/`writeState` persist to disk (mode `0o600`) precisely because that state must survive a restart. The real precedent in this codebase for state that must survive a restart is to persist it, not accept its loss. Losing the idempotency cache mid-flight is a real gap: if Core restarts between a `write/execute` call that already performed a non-idempotent mutation (give-item, grant-all, carepackage grant, guild add/remove all qualify) and a bot-side retry using the same idempotency key, the post-restart cache is empty and the retry silently double-executes.

**Corrected further after round-3 audit (was MEDIUM #746, DBA hat): `restartQueue.js`'s own convention is the weaker of two available precedents, and lacks concurrency control entirely.** `restartQueue.js`'s local `writeJson` is a plain `writeFileSync` (no temp-file + rename, not atomic), and its readers silently swallow any parse failure and return an empty state with no logging — acceptable for losing an in-flight restart countdown, not acceptable for silently reopening the exact double-execution gap this fix exists to close. Worse, `restartQueue.js`'s read-modify-write pattern (`readState` → mutate in memory → `writeState`) has no lock or compare-and-swap — tolerable for restart-queue entries (rare, effectively human-serialized) but not safe for the idempotency cache, whose entire purpose is protecting against near-simultaneous duplicate requests bearing the same key (Section 4's own stated threat model: "network retries or impatient users"). Two requests with the identical key arriving close together could both read a cache-miss before either writes back, both executing the non-idempotent mutation — the exact outcome this fix was meant to prevent, just via a race instead of a restart.

**Fixed:** the idempotency cache is persisted to `runtime/generated/discord-write-idempotency.json` using `jsonStore.js`'s `writeJsonAtomicAsync` (temp-file + fsync + atomic rename, explicitly documented in this codebase for "security-sensitive stores," and already the pattern `auth/secondFactorStore.js` uses for a structurally identical problem — small, security-relevant, per-key JSON state that must survive a crash without silent loss — corrected after round-4 audit, batch #755: a prior revision cited `services/playerBans.js` as this precedent, but `playerBans.js` actually uses the *synchronous* `writeJsonAtomic`, not the async variant; `secondFactorStore.js` is the real match).

**Corrected after round-4 audit (was HIGH #752, Security hat): the serialization must be scoped per idempotency key, never a single global queue.** A prior revision of this fix serialized *all* reads/writes through one in-process queue — meaning any single slow real endpoint call (a hung `server.restart`, a stalled map spawn) would stall the entire RW pipeline for every actor and every action, a new, unbounded DoS vector materially worse than the narrow race it was meant to fix. **Fixed:** a `Map<idempotencyKey, Promise>` — only requests sharing the *same* key wait on each other; unrelated keys never block one another. A same-key request arriving while an earlier one with the same key is still in flight awaits that first request's result rather than racing it. Each queued operation has a bounded timeout (matching the existing 60s nonce/confirmation window is a reasonable default); a request that doesn't resolve within it returns `503` rather than hanging indefinitely, so a single degraded-disk or hung-mutation event can't turn into an unbounded pile of stuck requests even for that one key.

**Corrected after round-5 audit (was HIGH #758, found independently by 4 hats — DBA, Security, Architect, QA): the `Map<idempotencyKey, Promise>` must delete each entry once its Promise settles.** A prior revision of this fix never stated this — since idempotency keys are fresh UUIDs generated per write attempt (Section 4), the Map would otherwise accumulate one entry per every RW action ever performed for the life of the process, a guaranteed unbounded-growth DoS under ordinary legitimate usage, not just an attack scenario. **Fixed:** the Map entry is removed in a `finally` block immediately after its Promise settles (success, failure, or timeout) — the settled *result* doesn't need to stay in this in-memory Map once the persisted idempotency-cache file has recorded it; only the in-flight coordination needs to exist. Map size at any moment is bounded by the number of currently in-flight requests, never cumulative history.

**Corrected after round-4 audit (was MEDIUM, batch #755, DBA hat), citation corrected after round-5 audit (was HIGH #759, DBA hat — the third citation-accuracy failure this document has had, worth a future implementer's extra caution when reusing any precedent this doc cites): an unreadable/corrupt cache file must fail closed, not fail open to empty.** A prior revision claimed `secondFactorStore.js`'s own corruption handling ("log a warning, then proceed as if the store were empty") was the *contrasting* precedent this fix deliberately diverges from — this was backwards. The real `secondFactorStore.js` **fails closed** on corruption: its own class doc comment states "callers on the auth path MUST treat this as 'cannot verify the second factor' → deny, NEVER as 'no second factor configured' → allow," and `loadRaw()` throws `SecondFactorCorruptError` on any unreadable/invalid/malformed state, never silently proceeding as empty. The "log and proceed as empty" behavior a prior revision described belongs to a different, explicitly-advisory function in that same file (`loadWatermarkEpoch()`, a non-authoritative side channel), not the main store — conflated in error. This is consistent with, not different from, the fix below: "empty" for the idempotency cache specifically means "no evidence this action already executed," which is precisely the condition that lets a retried `write/execute` silently re-run a non-idempotent mutation, so failing closed here follows the same real precedent `secondFactorStore.js` already establishes for security-sensitive state, not a deliberate departure from it. **Fixed:** if the idempotency-cache file exists but fails to parse, `write/execute` rejects the in-flight request with a `503`-class error ("idempotency store unavailable, cannot safely verify this hasn't already run") rather than silently treating the key space as empty, and logs at a severity that would actually surface to an operator monitoring the process, not just a debug-level warning. This also resolves round-5's DBA finding (batch #762) that the idempotency-corruption case deserves its own distinct error-table row rather than the generic `503` — see Section 4.

A retried `write/execute` with the same key and same params returns the cached result without re-invoking the loopback; same key with different params returns `409 "already executed"` per the existing error table. **Residual risk, stated explicitly:** a crash in the narrow window between the loopback mutation succeeding and the cache write reaching disk is still possible (this is inherent to any record-after-effect pattern without transactional coordination between two separate I/O operations) — accepted as a deliberate tradeoff, since it narrows the original bug's always-empty-after-restart window to a sub-second crash-timing window, not eliminated entirely. The nonce store stays in-memory (above); only the idempotency cache needs persistence, since only it protects against a real, already-executed mutation being silently repeated.

**Retention and redaction, stated explicitly (round-3 audit, Security hat Finding E):** persisting executed-action parameters and results (player names, ban reasons, item grants) to disk indefinitely, rather than erasing them on restart as the prior in-memory design did, is a small incremental information-disclosure surface (mirroring the already-accepted precedent that equivalent-sensitivity data already persists via the existing audit log). Consumed idempotency entries are pruned on the same periodic timer as expired ones (below), and cached `result` payloads pass through the same secret-redaction discipline (Requirement 24) as audit-log writes before being persisted — not stored raw.

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
| 403 (`roleSnapshotAt` stale — new row, round-4 audit UX #755) | "🔄 Your role info expired — please re-run the command" | warning |
| 409 | "⚠️ Already executed" | warning |
| 410 (nonce not found/expired — new row, round-2 audit UX #737) | "⏱️ Confirmation expired — please re-run the command" | warning |
| 429 | "⏱️ Rate limited. Retry in {s}s" | warning |
| 500 | "💥 Action failed: {details}" | error |
| 503 | "🔴 Adapter unavailable" | error |
| 503 (RW subsystem disabled by startup self-check drift — new row, round-4 audit UX #755) | "🔴 Write commands are temporarily disabled — a configuration issue was detected, contact your server operator" | error |
| 503 (idempotency store unavailable/corrupt — new row, round-5 audit DBA #762) | "⚠️ Could not verify this hasn't already run — please check with your server operator before retrying" | error |

**Corrected after round-4 audit (was MEDIUM, batch #755, UI/UX hat):** two new rows added above — a `roleSnapshotAt`-stale rejection (#744/#754) previously fell into the generic, misleading "not authorized" 403 despite the actor being genuinely authorized; and "RW subsystem disabled because the Section 3.5 self-check found route-table drift or a socket-startup failure" previously had no distinct mapping from the transient-sounding generic `503`, even though it represents a persistent config problem an operator needs to act on, not a connectivity blip.

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
| Write adapter bridge (preview + execute) | **DESIGNED** (Section 3, corrected after round-2 and round-3 audits) — not built | #215 |
| Per-action minimum tier table (`WRITE_ACTION_MIN_TIER`) | **DESIGNED** (Section 3.3a; round-3 added the `Object.hasOwn` guard round-2's version was missing) — not built | #729, #747 |
| Internal credential: Unix domain socket + path-scoping | **DESIGNED** (Section 3.4/3.2 — round-2's TCP-source-IP approach replaced with a Unix socket after round-3 found it broken in both directions; round-4/5 added ADMIN_ALLOWED_IPS scoping, root-UID refusal, restart-safety, split-brain protection, TOCTOU-safe chmod) — not built | #728, #742, #750, #751, #753, #756, #757 |
| `WRITE_ACTION_ROUTES` mapping table + startup self-check against `actions.js` | **DESIGNED**, self-check's real limitation now documented (needs a second, per-entry verification layer, see #731) — not built | #216, #731 |
| Route table correctness (ban/unban, give-item, guild.remove, history-clear phrase) | **FIXED IN DESIGN** (round-2 found ban/unban + give-item; round-3 found guild.remove + history-clear's phrase) | #730, #743, #747 |
| `guild:create` / `guild:rename` / `base:destroy` / `server:maintenance` | **DEFERRED** (Section 7) — no Core endpoint, out of scope this round | #216 |
| `GET /api/items` catalog endpoint (autocomplete) | **DESIGNED** (Section 3.6, corrected — the #218 allowlist-reuse claim was false) — not built, **no test coverage yet designed** | #222, #736, #745 |
| Server restart/stop confirmation phrases | **GENUINELY STILL OPEN** — a prior revision incorrectly claimed this was already reflected; verified both routes have zero server-side enforcement today | #223, #732 |
| `player:give-item` item-type allowlist/caps | **GENUINELY STILL OPEN** — #218's mitigations don't exist anywhere in this codebase; a prior revision incorrectly implied otherwise | #218 |
| Per-actor rate-limit isolation through the loopback | **FIXED IN DESIGN** (Section 3.8 — synthesized session now carries a stable `id`) | #733 |
| Idempotency cache persistence | **DESIGNED** (Section 3.8 — persisted via `jsonStore.js`'s atomic writer + a per-key `Map<idempotencyKey, Promise>` lock with settled-entry cleanup, after round-4 found round-3's `restartQueue.js`-convention fix had a race, and round-5 found round-4's own global-queue fix was itself a new DoS vector, then found the per-key fix's own Map had no cleanup) — not built | #736, #746, #752, #758 |
| Actor-role freshness enforcement | **DESIGNED** (Section 3.8 — a new signed `roleSnapshotAt` field on its own independent `WRITE_BRIDGE_SIGNED_ACTOR_FIELDS` set, after round-3 found round-2's fix was a bot-side-only promise, round-4 found the first attempt broke the shared cross-repo signing array, and round-5 added the missing numeric-range validation) — not built | #734, #744, #749, #754 |
| `discordWritesEnabled` standardization | **Core needs no change** (verified: already accepts both `"1"`/`"true"` since an upstream merge that predates this doc) — bot-side status needs re-verification | #217 |
| Section 6 test-plan coverage for all new mechanisms | **REWRITTEN and extended each round** — still has minor gaps as of round 5 (batch #762) | #735, #745, #762 |
| Actor signing on all write adapter routes | **EXISTS** | #207 (verified) |
| Interaction with console `policy.js`'s own IAM gate | **Documented after round-5 audit (was MEDIUM, batch #762, Architect hat):** the loopback's real target route also passes through the standard `evaluate(session, action)` check as a second, independently-maintained layer — verified today's real `DEFAULT_POLICIES` for `admin` tier already deny 4 of the 6 owner-tier-restricted actions Section 1 requires, consistent with (not conflicting with) `WRITE_ACTION_MIN_TIER`. No live conflict, but the two tables aren't tied together — a Layer 2 test should assert `WRITE_ACTION_MIN_TIER`'s per-action minimum always stays ≥ what `policy.js` would independently require, so future drift between them is caught rather than silently accumulating. | #762 |

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
Discord-bot-side behavior against mocks.** Further extended after round-3
audit (QA HIGH #745: the item catalog endpoint had zero coverage even after
the rewrite; several smaller gaps in batch #747). Every bullet below marked
*(new, Core)* is required Layer 1/2/3 coverage the write-bridge design adds;
bullets without that marker are unchanged from the original doc.

### Layer 1: Unit Tests (per component)
- `validateWriteParams()` — control chars, SQL fragments, length limits, enum validation
- `writeCooldown.checkGroup()` — per-group keying, expiry, cross-group isolation
- `writeConfirmation.js` — all 7 button interaction states (already tested, extend for new destructive confirmations)
- `writeExecute()` / `writePreview()` — mock adapter returns fixture nonce/result
- *(new, Core)* **Principal-type resolution (3.2):** unit test the new auth-resolution branch — correct token over the Unix socket → `discord-write-bridge` session recognized; correct token over a *different* channel (e.g. a plain TCP connection, simulating a spoofed source) → rejected; wrong token over the real socket → rejected; a request whose `(method, path)` isn't an exact `WRITE_ACTION_ROUTES` match → rejected even with valid credentials (path-scoping, #728/#742); a request without a CSRF token over the bridge's own channel → accepted (asserting the deliberate CSRF bypass, not an accidental gap, #747).
- *(new, Core)* **Credential comparison:** assert `crypto.timingSafeEqual` is actually used, not `===`, for the internal token check; assert a length-mismatched token is rejected cleanly (no thrown `RangeError`) — the length-equality guard added after round-5 audit, batch #762 (this bullet had no explicit test for it despite the guard being real and required).
- *(new, Core)* **`meetsMinTier()` (3.3a):** table-driven, every `WRITE_ACTION_ROUTES` key against every tier — assert it matches Section 1's tier ladder exactly; assert an action present in `WRITE_ACTION_ROUTES` with no `WRITE_ACTION_MIN_TIER` entry throws (fail closed) rather than defaulting open; assert a poisoned key (`"constructor"`, `"__proto__"`, `"toString"`) is rejected via `Object.hasOwn`, never resolved to an inherited value (#747).
- *(new, Core)* **`WRITE_ACTION_ROUTES` lookup safety:** `"constructor"`/`"__proto__"`/`"toString"` as `action` → rejected via `Object.hasOwn`, never resolves to an inherited value.
- *(new, Core)* **Route self-check (3.5), both branches:** a deliberately-mismatched entry → refuses to enable the RW subsystem (not a full-process crash — see 3.5's failure-scope correction) with a specific logged error; the current real table against the current real `actions.js` → passes clean. Re-run in CI so a future route rename is caught automatically.
- *(new, Core)* **Nonce store:** single-use consumption (a re-presented already-consumed nonce is rejected), 60s TTL expiry, correct `actorUserId`/`action`/`params` binding.
- *(new, Core)* **Idempotency cache module (persisted, 3.8):** same key + same params → cached result, no re-invocation of the loopback; same key + different params → `409`; **two concurrent requests with the identical key racing each other → the second waits for the first's result rather than both executing (regression test for the concurrency race #746 found) — achieved via a deliberately controlled synchronization point (stub/delay the underlying atomic-write step with an injected manual-resolve gate so both requests are provably in the cache-check window simultaneously before either completes), not a naive `Promise.all` that could pass trivially without ever proving real overlap (round-4 audit, QA hat, batch #755)**; two *different* keys, one artificially slowed, don't block each other (regression test for the global-queue DoS, #752); a queued operation exceeding its timeout returns `503` rather than hanging; a corrupt/unreadable cache file causes `write/execute` to fail closed with `503`, not silently proceed as if empty (#755); cache survives a process restart, where "restart" means re-instantiating the module in a *fresh process* (spawn/kill/respawn against the same on-disk file), not just re-calling the constructor in the same test process (#747).
- *(new, Core)* **Eviction/pruning (3.8):** expired-but-unconsumed nonce/idempotency entries are actually removed by the periodic sweep, not just excluded from lookups; a single actor exceeding the per-actor entry bound is capped (#747).
- *(new, Core)* **Audit attribution:** a loopback-executed action produces an audit-log entry correctly identifying the real Discord actor (`discordUserId`), never the bridge's internal credential and never blank.
- *(new, Core)* **Credential non-leakage:** the internal token never appears in any `audit()` payload, error response body, logged output, or the persisted idempotency-cache file (Requirement 24, extended after round-3 to cover the new on-disk cache, #747) — a capture-based assertion against real logged/persisted output during a simulated loopback call.
- *(new, Core)* **Rate-limit per-actor isolation (3.8, #733):** two different Discord actors performing the same action in the same window are NOT throttled by each other's activity (regression test for the shared-bucket bug this round's audit found).
- *(new, Core)* **Item catalog endpoint (3.6, #745):** `requireDiscordCapability(moderator)` gates the route and console `policy.js` is never consulted; **both directions of the tier boundary explicitly asserted (round-4 audit, QA hat, batch #755) — `public`/`observer` rejected, `moderator`/`admin`/`owner` accepted, not just the design fact restated**; prefix-match/25-result-cap/case-insensitivity behavior; a catalog file change is not reflected until a Core restart (regression-proofing the documented deploy-only-refresh caveat).

### Layer 2: Integration Tests
- Full lifecycle: slash command → preview nonce → confirmation → execute → result embed
- Nonce expiry (60s timeout) → bot shows "expired" embed (`410`, per Section 4's corrected error table)
- Idempotency replay (same key, same params) → bot shows cached result
- Idempotency collision (same key, different params) → bot shows "already executed"
- All error codes from the corrected error table (Section 4), including the new `410` and the split kill-switch-vs-permission `403` rows
- *(new, Core)* **Per-route-table-entry correctness (resolves the self-check's documented blind spot, #731; relabeled from Layer 1 to Layer 2 after round-3 audit, since it genuinely runs against a real test Core instance, #747):** one integration test per `WRITE_ACTION_ROUTES` entry, asserting the *actual* expected effect by independently querying/observing state the loopback call itself doesn't control (a real DB row, a mock game-server call log) — never by re-checking the response body the same code path just returned, which would recreate a shallow tautology (#747). Concrete worked examples: `player.ban` really bans, not unbans; `player.give-item` really targets the player's inventory, not a storage container; `guild.remove` actually removes the named member, not a 404.
- *(new, Core)* **Tier-floor negative test (Section 0's invariant):** table-driven across every `WRITE_ACTION_ROUTES` entry, assert `requireDiscordCapability()` rejects `public`/`observer`-tier actors before a nonce is ever issued.
- *(new, Core)* **Confirmation-phrase pass-through:** every entry with a `confirmPhrase` (3.5) — the loopback body carries the exact required phrase; a mismatched/missing phrase → the real endpoint's `400`, not a false success. **Cross-consistency check (added after round-3, QA #747):** every action listed under Section 4's "Type confirmation string" tier has a non-empty `confirmPhrase` in `WRITE_ACTION_ROUTES` — a table-driven check between the two lists, not just a per-entry pass-through test, so a destructive action (e.g. `grant-all`) can't ship without its documented phrase gate unnoticed.
- *(new, Core)* **Stale-role rejection (#734) and freshness enforcement (#744/#749/#754):** an actor whose role is revoked between `write/preview` and `write/execute` is rejected; test table for `roleSnapshotAt` (round-4/5 audit, QA + DBA hats, batch #755/#754/#762 — a prior revision only stated the negative case, an inverted-tautology risk, and omitted a malformed-value case entirely): a fresh `roleSnapshotAt` is **accepted**; a stale one (`Math.abs(now - roleSnapshotAt) > maxRoleAgeSeconds`) is **rejected**; a **future-dated** `roleSnapshotAt` is also rejected (not just old ones); the boundary at exactly `maxRoleAgeSeconds` is explicitly pinned to one behavior; a **malformed value** (`NaN`, a string, `undefined`) is rejected by the upstream `Number.isSafeInteger` guard, not silently accepted via a `NaN` comparison always evaluating false. Also confirm `write/preview`/`write/execute` verify this field via `WRITE_BRIDGE_SIGNED_ACTOR_FIELDS` (3.8), and that an old-format actor payload lacking `roleSnapshotAt` entirely still verifies correctly against **all five** routes the shared array serves — `link`, `verify`, `unlink`, `steam-link`, `broadcast` (round-5 audit, QA hat — a prior revision's regression test named only 2-3 of these; the shared `SIGNED_ACTOR_FIELDS` array must remain untouched for every one of them, not just a sample).
- *(new, Core)* **Kill-switch dual-checkpoint (#747):** `discordWritesEnabled()` is independently checked and rejects at both `write/preview` and `write/execute` — specifically, a switch flipped off *after* a valid preview/nonce but *before* the confirm-click reaches `write/execute` is still rejected, with the dedicated kill-switch error message, not the generic permission-denial one.
- *(new, Core)* **Broadcast exception path (Group F):** confirm `broadcast.*` never reaches the loopback/`WRITE_ACTION_ROUTES` machinery at all — it stays on its existing, separate `broadcastProvider()` path.

### Layer 3: End-to-End
- Real Core HTTP mock server with nonce store (extend `scripts/mock-adapter.js`)
- Bot-side Discord interaction mocks with button state machine
- Concurrency test: two simultaneous write commands serialize correctly
- *(new, Core)* **Loopback reachability under the project's real default config:** boot Core with `ADMIN_BIND_HOST=auto` (this project's shipped default) and confirm the write-bridge's own Unix-socket self-check (3.1) actually succeeds and is reachable by the internal client, and that a same-host process presenting a valid TCP source address (simulating a trusted reverse proxy per `CONSOLE_TRUSTED_PROXY_IPS`, connecting to the *TCP* listener since `network_mode: host` makes that reachable) is rejected by the `viaWriteBridgeSocket:false` path-scoping check — not, as a prior revision's wording implied, because it "cannot reach the socket file," which is imprecise (a TCP-sourced caller never touches the Unix socket at all; it's rejected by the flag check on the listener it *did* reach). Corrected after round-4 audit, batch #755, Architect hat.
- *(new, Core)* **`ADMIN_ALLOWED_IPS` exemption (#750):** boot Core with `ADMIN_ALLOWED_IPS` set to a value that would never match a Unix-socket connection's (empty) remote address, and confirm write-bridge requests still succeed — a regression test for the pre-existing IP-allowlist gate silently rejecting 100% of write-bridge traffic under this real, documented config.
- *(new, Core)* **Root-UID guard (#751):** simulate `process.getuid() === 0` and confirm the write-bridge refuses to enable RW routes, logging loud; confirm it enables normally under a non-root UID.
- *(new, Core)* **Socket restart safety (#753):** start Core, leave a stale file at the socket path (simulating an unclean prior shutdown), restart, and confirm the write-bridge subsystem comes up successfully (stale file removed, no `EADDRINUSE`) rather than crashing the whole process. **Extended after round-5 audit (was LOW, batch #762, QA hat):** also inject a synthetic non-`EADDRINUSE` listener error (e.g. a permissions error) and confirm graceful RW-subsystem disablement, not just the one specific reproduced error code.
- *(new, Core)* **Socket live-instance protection (#762):** simulate a second Core instance starting while a first is still genuinely live on the socket path (connect-probe succeeds) — confirm the second instance refuses to unlink and steal the path, disabling its own RW subsystem instead of silently taking over traffic from the still-running first instance.
- *(new, Core)* **Socket permission enforcement (#755):** assert the created socket file's mode is exactly `0700` after boot. **Extended after round-5 audit (was LOW, batch #762, QA hat):** also assert the self-check refuses to mark the RW subsystem healthy if a mocked/forced wrong resulting mode is detected — not just the happy-path assertion that the real mode is correct.
- *(new, Core)* **`sun_path` length invariant, stated explicitly (round-4 audit, Network hat):** the socket path (`runtime/generated/discord-write-bridge.sock`, resolved relative to the container's fixed `/repo` WORKDIR) is safely under Linux's 108-byte `AF_UNIX` path limit today — verified empirically that exceeding this limit produces a doubly-deceptive silent failure (the `'listening'` event fires and reports success, yet no socket file is actually created). This margin is an accidental byproduct of the container's fixed WORKDIR, not a stated design invariant elsewhere in this doc; re-check if `repoRoot` resolution logic is ever changed (e.g. a future bare-host execution mode).
- *(new, Core)* **Item catalog autocomplete latency (3.6, #745):** a realistic prefix query against the full real catalog responds within the bot's 3s autocomplete budget.

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
- `player:kick-all` — a real, existing Core capability requiring the confirmation phrase `"KICK ALL ONLINE PLAYERS"` (cited in Section 4's confirmation-phrase verification note as one of the real, verified precedents), but never wired into any Discord command in this design — deferred pending its own tier assignment and `WRITE_ACTION_ROUTES` entry, a real command-design decision out of scope for this revision (added after round-5 audit, batch #762, UI/UX hat — a prior revision cited this route as supporting evidence for phrase-injection without ever stating its own disposition)

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
| 740 | Batched MEDIUM/LOW: bare-property lookup, path traversal, IAM conflation, doc contradictions, false precedent claims, missing CHANGELOG entry, etc. | multiple | MEDIUM/LOW (batch) — corrected after round-3 audit found this table understated the issue's own severity |

**Round 3 (2026-09-09, re-auditing the round-2 corrections), 8 hats, 6 issues filed:**

| # | Title | Hat(s) | Severity |
|---|-------|--------|----------|
| 742 | Loopback-source verification broken in both directions under real deployment configs | Network, Security | CRITICAL |
| 743 | guild.remove route entry missing the target member path segment | Architect, Cloud Security | HIGH |
| 744 | Actor-role-freshness fix was a bot-side-only promise, no Core enforcement | Security | HIGH |
| 745 | GET /api/items catalog endpoint has zero test coverage | QA | HIGH |
| 746 | Idempotency cache: concurrency race + weak persistence convention | DBA | MEDIUM |
| 747 | Batched MEDIUM/LOW: CSRF-bypass ambiguity, path-scoping location, kill-switch re-check point, history-clear phrase, action-field vocabulary, meetsMinTier guard, confirmPhrase-is-UX clarification, and 14 more | multiple | MEDIUM/LOW (batch) |

**Round 4 (2026-09-09, re-auditing the round-3 corrections, especially the new Unix-socket mechanism), 8 hats, 7 issues filed:**

| # | Title | Hat(s) | Severity |
|---|-------|--------|----------|
| 749 | roleSnapshotAt fix breaks every actor-signed Discord route on Core/bot version skew | Cloud Security, Security | CRITICAL |
| 750 | Unix-socket listener unconditionally 403'd by the existing ADMIN_ALLOWED_IPS gate | Architect, Network | CRITICAL |
| 751 | Unix-socket trust boundary collapses under this project's own default root-UID container config | Architect, Security, Cloud Security | CRITICAL |
| 752 | Idempotency-cache serialization is a global queue, not per-key — new DoS vector | Security | HIGH |
| 753 | No restart-safety handling for the Unix socket; unhandled listener error can crash the whole console | Network, UI/UX, QA | HIGH |
| 754 | roleSnapshotAt freshness check never rejects a future-dated timestamp | DBA | HIGH |
| 755 | Batched MEDIUM/LOW: socket permission mechanism, fail-open-on-corruption, queue backpressure, timing-safe length guard, kill-switch listener-gating, history-clear Section 2 duplicate, Layer-1 exit gate, and 12 more | multiple | MEDIUM/LOW (batch) |

Full findings and STRIDE reports: comments on #215.
