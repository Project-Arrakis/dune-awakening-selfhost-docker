# Write-Bridge Two-Hop Audit Brief — 2026-09-22

**Purpose of this document:** ground a comprehensive, adversarial Layer 1
audit of issue #215 (the Discord write-bridge for
`Project-Arrakis/dune-awakening-selfhost-docker`) before any implementation
code is written. This audit must be right the first time — this feature
will eventually go to an upstream maintainer (`Red-Blink`), and a design
gap found there instead of here is a reputational cost this project has
already paid once (see `meta` issue #12's post-merge-fix history).

**Critical context, discovered today, that this document exists to fix:**
earlier design work (this session) conflated two genuinely separate
credential/authentication problems into one, proposed a flawed fix for the
conflated version, and only caught the conflation after an initial 8-hat
audit round and a second self-check mid-edit. This document explicitly
separates the two problems (Hop A, Hop B) so this audit does not repeat
that mistake. **Every finding in this audit must state which hop (A, B, or
both) it applies to** — a finding that doesn't make this explicit is
itself incomplete.

## Hop A: the incoming request — Discord bot → Core's `write/preview`/`write/execute`

**Question:** how does Core authenticate/authorize the HTTP request arriving
from the Discord bot (mentat) at these two new endpoints?

**Current answer (verified today against real code, not assumed):**

1. Register `write/preview` → `POST /api/integrations/discord/write/preview`
   and `write/execute` → `POST /api/integrations/discord/write/execute` as
   new entries in `DISCORD_ADAPTER_ROUTES`
   (`console/api/src/integrations/discord/adapter.js:6`), and add both to
   `DISCORD_LIVE_ADAPTER_ROUTES` (`adapter.js:116`) — the array is a
   curated subset of `DISCORD_ADAPTER_ROUTES`'s own values, not a separate
   dispatch mechanism (confirmed by reading both).
2. Any path matching `DISCORD_ADAPTER_ROUTES`'s values is dispatched via
   `isDiscordAdapterRoute(path)` → `handleDiscordAdapterRoute()`
   (`server.js:1183-1184`), **before** the generic `handleApi()`/
   `apiKeys.authenticate()` path is ever reached (`server.js:1192`).
3. Inside `handleDiscordAdapterRoute()`, **every** matched route
   automatically gets `requireDiscordBotToken(req, config)`
   (`routes.js:192`) — a single, generic call inside the function's own
   `try` block, before any route-specific dispatch. This is the existing,
   already-shipped, already-production-tested bearer-secret check
   (`DUNE_DISCORD_ADAPTER_TOKEN`, `routes.js:721-728`) that already gates
   every existing Discord-adapter route, including the two existing writes
   (`BROADCAST`, `PLAYERS_LINK`).
4. Each write route additionally calls, in its own handler (matching the
   `BROADCAST` precedent at `routes.js:290-298`):
   - `discordWritesEnabled(config)` gate (`routes.js:292`'s pattern) —
     throws `writes_disabled` (403) if Discord-driven writes are off.
   - `readJsonWithActorSignature(req, { requireActorSignature: true })`
     (`routes.js:176-189`), which calls `verifyActorSignature({..., fields:
     WRITE_BRIDGE_SIGNED_ACTOR_FIELDS, required: true})` — the design doc's
     own "Core Side" intro (`docs/rw-architecture.md:467`, pre-existing,
     not something today's work added) already specifies this exact
     mechanism.
   - `requireDiscordCapability(actor, mapping, ...)` — the existing
     per-actor Discord-role-tier check.
   - `meetsMinTier(actorTier, action)` (§3.3a's not-yet-implemented
     `WRITE_ACTION_MIN_TIER` table) for the per-action tier ladder,
     since `requireDiscordCapability` alone can't distinguish `kick` from
     `give-item`.

**What this replaces:** an earlier same-session proposal to reuse
`apiKeys.js` (a bearer-token API-key mechanism) for this hop. That proposal
is abandoned — `apiKeys.authenticate()` is never reached for routes
registered under `DISCORD_ADAPTER_ROUTES` (finding #1 below), and the
mechanism above already exists, in production, today.

**What must be verified in this audit, not assumed:** every claim above,
against the exact current code (paths/line numbers may have drifted since
this morning — re-grep, don't trust the line numbers as gospel), AND
whether this mechanism is actually *sufficient* — e.g., does
`requireDiscordBotToken`'s single shared secret plus per-actor signature
verification provide real security here, or is there a gap (replay,
signature-scope, rate-limiting-isolation) specific to these two new,
higher-privilege routes that the existing lower-privilege routes don't
have to worry about?

## Hop B: the internal loopback — `write/execute` → Core's own real mutation route

**Question:** once Hop A has validated the incoming request, `write/execute`
must actually perform the mutation (kick, ban, restart, give-item, ...).
Verified today: the underlying functions behind most target actions
(`task()`, `server.js:4072`; `confirmedTask()`, `server.js:4463`) take real
`req`/`res` directly and are tightly coupled to them (read
`req.authSession` for audit attribution, `req.socket.remoteAddress` for
rate-limit keying, some branches write directly to `res`). Reconstructing a
synthetic `req`/`res` well enough to satisfy every target route was judged,
in the original design, too risky — so `write/execute` instead makes a
**real internal HTTP request** to Core's own real endpoint (e.g. `POST
/api/players/:id/kick`), reusing the real route handler completely
unchanged.

**That internal HTTP request needs its own answer to "how does IT
authenticate against Core's normal route-dispatch/auth layer" — this is
Hop B, and it is a completely separate problem from Hop A.** The real
target route (`/api/players/:id/kick`) is a normal, existing,
console-IAM-gated route — it does not match `/api/integrations/discord/*`,
so it does NOT go through `isDiscordAdapterRoute()`'s bypass; it goes
through the generic `handleApi()` path, which means it needs a real
`req.authSession` populated with a tier/identity that `evaluate()`, `task()`,
and `audit()` will accept and correctly attribute.

**Current design (docs/rw-architecture.md §3.1/§3.2/§3.4, PR #727 branch
`docs/rw-architecture-write-bridge-design`, 9 audit rounds deep):** a
second `http.Server` listening on a Unix domain socket
(`runtime/generated/discord-write-bridge.sock`, mode `0700`), a new
`discord-write-bridge` principal type recognized only for connections
arriving via that socket, an in-memory random token compared via
`crypto.timingSafeEqual`, exact-match path-scoping against a
`WRITE_ACTION_ROUTES` table, and extensive hardening around startup
race conditions, root-UID default container config, `ADMIN_ALLOWED_IPS`
interaction, and rate-limit/audit-attribution correctness (the synthesized
session carries `id: discord:${actor.userId}`, not a generic key id, so
`audit()` correctly attributes the real Discord actor, not a service
identity).

**Full historical detail (read directly, do not rely on this summary):**
`git -C /root/projects/repos/dune-awakening-selfhost-docker show
origin/docs/rw-architecture-write-bridge-design:docs/rw-architecture.md`
— §3.1 (~line 471), §3.2 (~line 481), §3.3/§3.3a (~line 569), §3.4 (~line
609). This content reflects real, empirically-reproduced findings across 9
rounds (CRITICALs #728, #742, #749, #751, #756, #763, #772, #779, #808,
#820 among them) — do not casually re-litigate settled, empirically-proven
findings without new evidence; DO independently re-verify that each cited
fix is still present and correct in the current text.

**Round 9's 15 findings (2026-08-08, never folded into the doc) — must be
resolved as part of this audit, not treated as separately deferred:**
#918 (Section 0 rename claim false on this branch — verify against real
`discordActorTier()`), #919 (auditAction summary counts wrong), #920
(self-verification pass skipped its own governance steps), #921 (Section 5
status-table Issue columns incomplete), #922 (catalog rate-limit can't key
on Discord actor identity), #923 (stop's post-match countdown has 3
unresolved gaps), #924 (stop's 60s vs restart's 90s window unexplained),
#925 (Section 3.8 contradicts itself on `runExclusive()` behavior), #926
(zero test coverage for #808/#820's queue-ordering fix), #927 (auditAction
test bullet self-contradicts), #928 (consistency-check script's regex
blind to template-literal `confirmPhrase`), #929 (`carePackageEnableRoute`
catch branch missing `audit()` call), #930 (Section 6 test example
contradicts Section 3.5's own admission), #931 (`runExclusive()` cited as
reusable but is a private non-exported closure), #932 (persisted
idempotency-cache lacks version/shape validation). Read each via `gh issue
view <N> --repo Project-Arrakis/dune-awakening-selfhost-docker` for full
text — titles alone are not sufficient to resolve them.

**What must be verified in this audit, not assumed:** does the Hop B
mechanism as currently designed actually get invoked correctly given Hop
A's now-clarified, separate resolution? (e.g., does anything in §3.1-3.4's
9 rounds implicitly assume Hop A was ALSO going through this same Unix
socket, which would now be wrong?) Is the `discord-write-bridge` principal
type's synthesized session correctly scoped so it can NEVER be used for
anything beyond the one exact-matched target route already validated by
Hop A + `meetsMinTier`? Are round 9's 15 findings still accurate against
the CURRENT real code (not just the doc's own prose)?

## Mandatory instructions for every hat

1. State explicitly, for every finding, whether it applies to Hop A, Hop
   B, or both. A finding that doesn't specify this is incomplete.
2. Verify every factual claim in this brief against the real, current code
   — do not trust this document's own claims, including its line numbers.
3. For Hop B, read the real historical content (git show command above) —
   do not rely solely on this brief's summary paragraph.
4. Cross-check round 9's 15 findings against current real code where
   relevant to your lens; state whether each is still valid, already
   fixed, or superseded.
5. Map every finding to STRIDE where applicable; say "N/A" explicitly
   where it doesn't.
6. This feature is destined for an eventual upstream PR to `Red-Blink`.
   The operator's own standing instruction: this must be correct the first
   time, without upstream having to catch a gap this audit should have
   caught. Be genuinely adversarial.
