# Hop B Mechanism Comparison — Unix Socket vs. apiKeys.js — 2026-09-22

**Purpose:** Hop B is the internal loopback call `write/execute` (already Hop-A-authenticated:
bot token + actor signature + capability + per-action tier verified) makes to Core's own
real mutation route (e.g. `POST /api/players/:id/kick`) to actually perform the write,
reusing `task()`/`confirmedTask()` unchanged rather than reconstructing synthetic `req`/`res`
(confirmed necessary: both functions are tightly coupled to real `req`/`res` — Architect hat,
verified against `server.js:4072-4148`). That internal call still needs to authenticate
itself against Core's own normal route-dispatch/auth layer, since the real target routes are
plain, existing, console-IAM-gated routes, not `/api/integrations/discord/*` routes.

Two real options exist. This document compares them honestly, including where each is
worse, not just where each is better — no option is presented as obviously correct.

## Option 1: Unix domain socket + `discord-write-bridge` principal (current design, §3.1-3.4, 9 audit rounds)

**Mechanism:** a second `http.Server` on `runtime/generated/discord-write-bridge.sock`
(mode `0700`), a new principal type recognized only for connections arriving via that
socket, an in-memory random token (`crypto.randomBytes(32)`, generated once at boot,
never persisted), exact-path-match scoping against `WRITE_ACTION_ROUTES`.

**Real strengths, verified today:**
- Zero network reachability by construction — an AF_UNIX socket has no IP/port concept at
  all (Network hat, verified against Node's socket semantics, not just the doc's claim).
  Reachability is filesystem-permission-gated only, immune to `ADMIN_BIND_HOST`/reverse-proxy
  topology variance the way a TCP-address check (the original, rejected round-2 design) was not.
- 9 rounds of adversarial audit, several findings empirically reproduced against real Node
  behavior on this host (the `sock.destroy()` no-arg vs. with-`Error` hang, the umask TOCTOU
  window, the `ADMIN_ALLOWED_IPS` exemption chain).

**Real weaknesses, verified today:**
- Large amount of genuinely novel infrastructure: a new listener, socket-file lifecycle
  (stale-file cleanup, liveness probe, restart-safety), synchronous umask handling, a
  root-UID startup refusal. This is where the 6+ CRITICALs (#742, #751, #756, #772, #779,
  #820) came from — novelty is where the bugs were.
- No rotation story at all — "Rotation: N/A... nothing to rotate" was true when the token
  was purely in-memory and per-process-lifetime, but this framing was written before this
  fork gained a real persisted-credential mechanism (`apiKeys.js`) to compare against.
- **New finding, this round (Security Architect, verified against real code):** the
  synthesized session sets `discordUserId`, but `audit.js`'s `principalOf()` reads
  `session.userId` — every write-bridge mutation's audit-log entry would carry no Discord-actor
  attribution at all, only a tier. A real, unfixed defect regardless of which option is chosen
  for the transport, since this is about the session *shape*, not the socket.
- **New finding, this round (Security Architect):** the tier claim crossing the loopback is
  trusted as an opaque string with no independent re-derivation at the Hop B boundary — Hop
  A's `meetsMinTier()` is the sole enforcement point; a future bug reusing this internal
  client without going through that gate would get silent access to whatever tier it asserts.
- **New finding, this round (Architect):** the Unix-socket dispatch's safety from a Hop A/B
  cross-mixing bypass is real today but is an *accident* of `WRITE_ACTION_ROUTES`'s current
  contents and `handleApi`'s current dispatch order, not a stated, protected invariant.
- Introduces a second, structurally different mechanism for "let a non-cookie principal
  populate `req.authSession` and skip CSRF" — `apiKeys.js` already solved this exact class
  of problem via a short-circuit at `server.js:1223` (`session = bearer?.session ||
  auth.requireAuth(req, res)`); the Unix-socket design instead threads `opts` through
  `requireAuth()`/`handleApi()` itself, a different integration pattern for the same kind
  of decision (Security Architect, finding F4).

## Option 2: reuse `apiKeys.js`, properly scoped by the real target-route `policyAction` values

**Mechanism:** mint one dedicated, file-backed API key via the existing `apiKeys.js`
lifecycle (`create()`/`revoke()`), scoped via `apiKeyScopes.js`'s explicit per-namespace
**action-list** form (not a blanket "write" level, which over-grants) to exactly the union
of `policyAction` values `WRITE_ACTION_ROUTES` actually needs (e.g. `players:mutate`,
`server:restart`, `carepackage:grant`, ...) — **not** scoped to the two Hop-A arrival routes,
which was the wrong framing when this was first proposed for Hop A and correctly rejected.
`write/execute`'s internal call presents this key as a normal `Authorization: Bearer` header
to the real target route, which — being a plain admin route, not a `/api/integrations/discord/*`
route — actually reaches `apiKeys.authenticate()` (confirmed: Architect's finding #5(a)).

**Real strengths:**
- Eliminates the entire Unix-socket subsystem — no new listener, no socket-file lifecycle,
  no umask handling, no root-UID refusal. Removes the exact class of complexity that produced
  6+ CRITICALs in Option 1's own history.
- Reuses a real, already-shipped, already-in-production credential lifecycle (create/revoke,
  a real Settings UI) instead of an in-memory-only, no-rotation credential — closes the
  rotation gap Option 1 has no answer for.
- Follows the *already-established* integration pattern (`bearer?.session || ...`) for this
  exact class of decision, rather than introducing a second, differently-structured mechanism
  (Security Architect's F4 concern, directly addressed).
- Multi-worker-scaling-safe by construction (file-backed, not per-process in-memory) — Option
  1's own §3.4 explicitly flags single-process as a load-bearing, currently-true-but-fragile
  assumption; Option 2 has no such assumption to track.

**Real weaknesses, verified today — this is not a free win:**
- **Does NOT, by itself, fix the audit-attribution problem.** `audit.js`'s `principalOf()`
  handles the `apiKeyId` case by attributing the action to *the API key itself*
  (`{ type: "api-key", id: session.apiKeyId }`), never to a Discord actor — the identical
  class of defect Option 1 has (missing `userId`), just via a different code path. Whichever
  option is chosen, the internal call's session must be explicitly augmented with the real
  actor's `userId` before reaching `audit()` — this is not solved by Option 2's mechanism
  on its own.
- **Real, unresolved collision with issue #1007** (the `apiKeys.js` crown-jewel deny-list
  gap, filed today as a separate issue): `tier1-upstream`'s real fix (commit `8654bbd0`)
  denies `players:give-item`, `carepackage:grant`, `carepackage:write-config`,
  `carepackage:grant-all`, `carepackage:clear-history`, and `server:restart` to **every**
  API key, unconditionally, once ported to `main` — 6 of ~25 write-bridge actions. If Option
  2 is chosen, #215 and #1007 become mutually coupled: either the write-bridge's own service
  key needs an explicit, separately-justified exemption from that backstop (itself a real
  design decision requiring its own security review, since it deliberately opens a hole in a
  control designed to have none), or the two issues must be sequenced together, not developed
  independently as currently filed.
- **Network exposure is qualitatively different from Option 1, not just quantitatively.** A
  leaked Option-2 key is usable from anywhere Core's admin port is reachable — the same
  exposure class already accepted for Hop A's shared secret. A leaked Option-1 token
  additionally requires filesystem access to the socket path (same host, same user, or root)
  — a real, if narrow (per §3.4's own residual-risk framing, an attacker with that access
  already has broader compromise), additional barrier Option 2 does not have. Choosing
  Option 2 means the *entire* write-bridge (both hops) shares one network-exposure profile;
  choosing Option 1 means Hop B specifically has an extra, independent barrier Hop A lacks.
- **Real new design work, not previously required:** credential bootstrap/provisioning
  lifecycle is currently undesigned for this use case — who calls `create()` and when (first
  boot only vs. every boot), idempotency across restarts, audit attribution for the creation
  event itself (the normal creation path assumes an owner's browser session; a self-minted-at-
  boot key has no such actor).
- `apiKeys.js`'s own persistence layer (the flat `api-keys.json` file) has real, independently
  confirmed pre-existing gaps: a cross-process concurrent-write race (no file lock, only
  in-process serialization) and shared-fate blast radius (a corrupted file takes down every
  API-key integration at once, including the write-bridge, not just the one that corrupted
  it) — DBA hat, confirmed against real code in an earlier round today. Neither is introduced
  by Option 2, but Option 2 would make the write-bridge dependent on this store's existing
  reliability profile, which Option 1 has no exposure to at all.

## What is NOT a differentiator between the two options

- Hop A's mechanism (`requireDiscordBotToken` + `verifyActorSignature` + `requireDiscordCapability`
  + `meetsMinTier`) is unaffected either way — this comparison is scoped to Hop B only.
- The two-phase `write/preview` → nonce → `write/execute` flow, the persisted idempotency
  cache, and the dual-confirmation `server.stop` flow (§3.8) are unaffected either way — all
  of that logic sits above Hop B's transport choice, not inside it.
- The `WRITE_ACTION_MIN_TIER` per-action tier ladder (§3.3a) is unaffected either way.
- Round 9's 15 findings are almost entirely about §3.5-3.8 (route table, nonce, idempotency,
  tier mapping) — largely orthogonal to this specific transport decision, and apply either way.

## Open question for adversarial review

Is Option 2's complexity reduction (removing an entire novel subsystem that has already
produced 6+ CRITICALs) worth its real costs (a new mutual dependency on #1007's resolution,
a real provisioning-lifecycle design gap, a qualitatively broader network-exposure profile for
this specific internal credential, and inherited pre-existing reliability gaps in `apiKeys.js`'s
own store)? Or does Option 1's extra, independent barrier (filesystem-permission-gating,
orthogonal to network exposure) justify carrying its remaining complexity, once its two real
new gaps (audit attribution, tier-claim defense-in-depth) are fixed?

This document does not pick a winner. Both options require real, concrete fixes before either
is implementation-ready. The audit dispatched against this document should adjudicate which
option is actually sounder given real deployment conditions, not just enumerate more findings
against whichever option is chosen by default.
