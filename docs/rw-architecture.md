# RW Command Architecture — Discord Bot Write Operations

**Date:** 2026-08-08 (revised 2026-09-09, corrected after round-2 through round-7 audits, a mechanical cross-reference pass after round 6, an isolated four-hat review of the `stop` gate, a quick two-hat follow-up check, a coverage-closure pass extending the mechanical script and closing two long-standing design gaps, and a final confirmatory Eight-Hat round — all same day)

**Status:** Layer 1 Design (Requirement 20) — **NOT yet ready for Layer 2**

**Mechanical consistency check:** before dispatching a new Eight-Hat round, run `docs/design/scripts/rw-architecture-consistency-check.py` (added after round 6, issue #777) — it catches cross-reference bugs (stale citations, table/list mismatches) that hat rounds have repeatedly missed, for free, in minutes, so hat judgment isn't spent re-deriving facts a script can check deterministically. It is a detection tool, not a substitute for the filing/remediation/comment discipline below — any finding it surfaces still goes through the same process as a hat finding.

**Layer-1 exit gate, added after round-4 audit (was MEDIUM, batch #755, GRC hat — a real governance gap this session found in itself, not just in the design). Corrected after round-6 audit (was HIGH #764, GRC hat: this gate's own text had gone stale, still claiming "four consecutive rounds" and no round-6 requirement, after round 5 had already run and round 6 had already been dispatched). Corrected again after round-7 audit (was HIGH #790, GRC hat: the mechanical-pass fix for issue #777 — a real remediation, run after round 6 — was not governed with this same discipline; no comment was posted on #215, CHANGELOG.md wasn't updated, and this very paragraph never mentioned the script existed, despite being edited specifically to prevent exactly this recurrence one round earlier). Corrected again after the final confirmatory round (was HIGH #812, GRC hat: this paragraph and the Audit narrative above still described round 7 as the most recent pass, with no mention of the isolated review, quick check, coverage-closure pass, or this round itself — the exact staleness pattern this paragraph exists to prevent, recurring a third time):** eleven consecutive audit passes since round 2 have now each found real CRITICAL/HIGH findings — including, in every pass from round 3 onward, findings in the *immediately-prior remediation's own output* (hat-dispatched, scoped, or mechanical), and the most recent full pass (the final confirmatory round, #808-819) found the largest raw count of the entire history. **This design must not proceed to Layer 2 until a full Eight-Hat round finds zero new CRITICAL/HIGH findings against the immediately-prior round's corrections — this has not yet happened.** If any round finds CRITICAL/HIGH, another full round is mandatory, not optional, regardless of how many rounds that takes — treat "we ran an audit" as insufficient on its own; the outcome is what matters. A scoped review (an isolated N-hat check, a quick check, a coverage-closure pass) can close specific, named gaps cheaply, but does not itself satisfy this gate — only a full, unscoped Eight-Hat round finding zero new CRITICAL/HIGH does. **This requirement applies to EVERY remediation pass that touches this document, not only numbered hat-dispatch rounds — a mechanical-script fix, a self-verification catch, a scoped review, or any other correction must still: post its findings as a comment on #215, update `CHANGELOG.md`, get a Section 8 entry, and be reflected in this paragraph's own round count/"still required" status, in the same session it's made. Whoever updates this doc must update this paragraph in the same edit that resolves whatever prompted the update — do not let this paragraph go stale again, for a hat round or anything else.**

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
future-timestamp bypass in the freshness check. Filed as #749-755. **Round
5**, auditing round 4's own fixes, found 1 CRITICAL + 5 HIGH: an `opts`
parameter that could reach `undefined` and hang (not crash) every console
request once `ADMIN_ALLOWED_IPS` is set (empirically proven); the
`ADMIN_ALLOWED_IPS` write-bridge exemption scoped too broadly and
unimplementable without explicit function-signature threading; the new
per-key idempotency `Map` never removing settled entries (independently
found by 4 of 8 hats); a `secondFactorStore.js` corruption-handling citation
that was backwards (fails closed, not open — the third citation-accuracy
failure in this doc); one of two `clear-backpack` wording fixes from round 4
left unapplied; and `CHANGELOG.md` not updated for round 4 (self-caught and
fixed before the round finished). Filed as #756-762. **Round 6**, auditing
round 5's own fixes, found the largest finding set yet — 1 CRITICAL + 12
HIGH, several independently corroborated by 2 hats each: the round-5
`ADMIN_ALLOWED_IPS` exemption fix threads `opts` into `handleApi`/
`auth.requireAuth`, but the real `config.allowedIps` gate runs in
`server.js`'s outer request handler *before either function is ever
called* — CRITICAL #750 is still effectively unfixed as specified
(Architect + Security hats, independently); this doc's own header and
Section 8 tracking table were never updated to reflect round 5 (GRC hat —
the exact failure this exit-gate paragraph itself is meant to prevent);
a stale `history-clear` confirmation-phrase citation survived a third
location three rounds after being fixed elsewhere (GRC + UI/UX,
independently); the `warn` command's confirmation requirement contradicts
itself between Section 2 and Section 4, and Section 1's tier table lists
two phantom owner capabilities defined nowhere else (UI/UX); the canonical
`verifyActorSignature()` example was never updated for round 5's own
signed-fields threading fix, leaving a 4th, uncovered call site (Cloud
Security); the idempotency Map-cleanup fix can delete a still-in-flight
mutation's coordination entry on timeout, and the periodic pruning sweep
has no described synchronization with `write/execute`'s own cache write —
both real double-execution risks (DBA); `grant-all`'s cited IAM Action was
wrong, causing a miscount in round 5's own new cross-IAM-consistency
finding (DBA); the Unix-socket liveness probe has no `'timeout'` handler
and can silently hang Core's entire boot, not just RW (Network,
empirically proven); and three Section 6 test-plan gaps left CRITICAL
#756, HIGH #757, and the `roleSnapshotAt` signature binding completely
unguarded by any regression test (QA). Filed as #763-776. **A mechanical
cross-reference script** (`docs/design/scripts/rw-architecture-consistency-check.py`,
written after round 6 to catch this exact class of bug — several round-6
findings, like the `warn`/Section-4 contradiction and the `grant-all`
IAM-action miscitation, had been present unchanged since the doc's
*original* commit, surviving 4-5 hat rounds) found two more real gaps of
the same kind in minutes: `fill-water` missing from Section 4's lists (a
round-6 UI/UX finding had explicitly but wrongly cleared this), and
`ban`/`spawn`/`despawn`/`respawn`'s table cells never stating their real,
already-verified confirmation phrases inline. Filed as #777, fixed. **Round
7**, auditing round 6's fixes AND #777's own governance trail, found the
largest CRITICAL count yet — 2 CRITICAL + 11 HIGH: round 6's two
idempotency-cache fixes (#769/#770) have an unstated ordering dependency
where both plausible orderings are broken (DBA); the liveness-probe
timeout fix (`sock.destroy()` with no argument) never actually fires
`'error'`, so the probe's Promise never settles — reproducing, one level
up, the exact whole-console-boot-hang #772 was written to fix (Architect
+ Network, independently, both empirically proven); the brand-new `stop`
dual-confirmation gate (designed fresh in round 6) has serious problems
from nearly every angle — no fallback for single-admin deployments,
a `userId`-based exclusion one operator with two Discord accounts can
defeat, an unrealistic 30s response window never reconciled with the
60s nonce TTL, an ambiguous enforcement mechanism against the nonce
store's single-actor binding, and zero test coverage despite an explicit
same-paragraph commitment to add three tests (UI/UX, Security, Architect,
QA); `resolveWriteBridgePrincipal`'s path source is unspecified and the
`runExclusive()` idempotency-lock fix is unbounded, recreating round 4's
#752 DoS class (Architect + DBA, independently, on the latter); Section
3.8 never resolved a `fields`/`signedFields` naming ambiguity that could
reproduce round 6's own #768 bug via a different mechanism (Cloud
Security); and #777's own remediation wasn't governed with the same
discipline as a hat round — no #215 comment, no CHANGELOG entry — a
recurrence of the exact staleness pattern round 6 was created to prevent,
one commit later (GRC). Filed as #778-791. Full findings and STRIDE
reports for all completed rounds, plus #777: comments on #215. **Rather
than dispatching a full round 8 immediately, the user flagged the
reactive round-over-round pattern itself as wasting time/resources; the
work that followed reflects a deliberate, bounded coverage-closure plan
instead of open-ended continuation** (see
[[bounded-coverage-plan-over-open-ended-rounds]] for the reasoning). An
**isolated four-hat review** (Security, Architect, UI/UX, QA), scoped
specifically to round 7's brand-new `stop` dual-confirmation gate rather
than the whole document, found that gate structurally broken: 2 CRITICAL
(no wire-level correlation ID between the two confirmers' calls;
unspecified idempotency-key semantics with a plausible silent-fail-closed
path) + 4 HIGH (the single-admin fallback deciding whether the safety
control applies at all from unsigned, bot-cached role data; the "pending
stop request" record's storage/persistence/concurrency never stated;
ambiguity risking modification of the real, shared `/api/server/stop`
route; a two-click UX regression) + 1 batched MEDIUM/LOW set (#799).
Filed as #792-799; the gate was redesigned to reuse the existing nonce
store (two new fields, a bounded 5-minute TTL exception) instead of a
second record type. A **quick two-hat follow-up check** (Security,
Architect) on just the redesigned gate's nonce-reuse mechanism came back
with the smallest finding set of any pass to that point — MEDIUM #803
(atomicity of the lookup-verify-consume sequence) + LOW batch #804 (doc
cross-reference gaps) — both fixed. The coverage-closure plan's first
step, **extending the mechanical script** to verify every command's
endpoint (method+path) against real routes, found two regressions of
already-fixed CRITICAL/HIGH bugs purely from a deterministic check
(`ban`/`unban` inversion, `guild.remove`'s missing path segment — #806),
and two long-acknowledged, never-revisited design gaps were closed
(#807): the item-catalog endpoint's design and the `WRITE_ACTION_ROUTES`
self-check's `auditAction` field.

With the coverage-closure plan's steps complete, the user approved
proceeding to its final step: **one full confirmatory Eight-Hat round**
against the whole, further-corrected document — not scoped to a single
mechanism, the first genuinely fresh-eyes full read since round 7. This
round found the largest raw finding count of the entire audit history —
**1 CRITICAL + 10 HIGH + 6 MEDIUM + 1 LOW (18 distinct findings)** —
consolidated and filed as #808-819: a real cancellation gap in
`runExclusive()` where a timed-out operation's in-flight
`writeJsonAtomicAsync()` I/O isn't actually stopped (CRITICAL #808, DBA);
the `stop` gate's first-confirmation branch missing an explicit
actor-identity check (#809, Architect) and its atomicity claim naming an
outcome but not a mechanism (#810, DBA); a stale catalog refresh-policy
paragraph contradicting the endpoint's actual reused-function design
(#811, DBA+Security); this doc's own header/Section 8/CHANGELOG
governance trail going stale again — the same recurring failure mode
rounds 6 and 7 each found in themselves (#812, GRC); no UI mechanism
ever designed for a typed-confirmation command despite Section 4
requiring one (#813, UI/UX); the catalog endpoint's match semantics
undocumented for the real `id`/`name`/`category` fields and lack of
result ranking (#814, UI/UX); the `stop` gate's terminal outcomes never
notifying the primary's own original message (#815, UI/UX); missing test
coverage for the `auditAction` mechanical check (#816, QA), the
`runExclusive()` cleanup-ordering fix (#817, QA), and
`policy.js`/`WRITE_ACTION_MIN_TIER` drift (#818, QA); and a batched
MEDIUM/LOW set (#819) covering a missing rate limit on the catalog
endpoint, a Section 2/4 confirmation-classification contradiction for
`grant-all`, an unbounded pruning-sweep batch size, a test-matrix axis
gap, a generic success embed for high-risk commands, a stale
path-computation citation, and bare "Yes" confirmation cells with no
stated preview content. All resolved in this revision — full findings
and STRIDE reports for every pass since round 7: comments on #215.

This section of the doc, and every section below it, reflects the design
after remediating all CRITICAL/HIGH findings from rounds 2 through 7,
#777, the isolated review (#792-799), the quick check (#803-804), the
coverage-closure pass (#806-807), and the final confirmatory round
(#808-819). **Per the exit gate stated above, this final confirmatory
round did NOT come back clean — it found the largest finding count of
any pass yet, meaning another full round is technically required before
Layer 2 begins.** Per the coverage-closure plan's own stated stop
condition (a hard stop after this one confirmatory round, no automatic
further rounds), whether to run another full round or consider this
design stable enough to proceed is an explicit decision for the user,
not an automatic continuation — do not assume this pattern has stopped
just because this round's fixes look thorough; every prior round looked
thorough too.

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

2. **Two-phase confirmation** — Destructive operations use `write/preview` (validate authority + return impact preview) → user confirmation → `write/execute` (consume nonce + perform action). Nonce binds user identity, operation type, and parameters. 60s expiry prevents replay. **Exception, stated explicitly (added after a quick post-redesign check, Security hat, LOW): `server.stop`'s dual-confirmation gate deliberately allows a *different* user's identity to consume the nonce — see Section 3.8's "Nonce store" entry and Group C's Safety note. This is the one intentional exception to the identity-binding rule stated here.**

3. **Tier ladder** — Console capability tiers mapped to Discord roles via existing `discordActorTier()`:

| Discord Role | Capability Tier | Can do |
|-------------|----------------|--------|
| observer | `public` | RO only — no write commands |
| moderator | `moderator` | `player:warn` (map chat) |
| admin | `admin` | Most RW: player kick/ban, base refill, server start, map control, carepackage grant, guild add/remove |
| owner | `owner` | Destructive: server restart/stop, player inventory clear, give-item, grant-all, history clear |

**Corrected after round-6 audit (was HIGH #767, UI/UX hat): this row previously listed two phantom capabilities not defined, built, or even scoped as deferred anywhere else in this document.** "base destroy" is correctly *deferred* elsewhere (Group B, Section 5, Section 7 — "deferred until Core `DELETE /api/bases/:id` endpoint is implemented, #216") but was miscategorized here as a currently-available owner capability rather than a deferred one; removed from this row (see Group B for its real, deferred status). "guild delete" corresponded to nothing anywhere in this document at all — Group G only ever defined `add`/`remove`, both **admin**-tier (not owner), with no route, tier entry, or deferred-scope mention for a delete action; removed outright as a phantom. Since this table is explicitly cited elsewhere as the source of truth (below), leaving either in as "available" risked a Layer 2 implementer building a command or tier grant that doesn't correspond to any real, designed mechanism.

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
| `ban <name> [reason]` | write/execute → `POST /api/players/.../ban` | `players:mutate` | admin | Yes (shows player name + reason; requires typing `"BAN PLAYER"` — added by the mechanical cross-reference script (issue #777, run after round 6), this cell previously omitted the real phrase requirement stated only in a separate paragraph below) |
| `warn <name> <message>` | write/execute → `POST /api/admin/map-chat` | `admin:map-chat` | moderator | No (non-destructive) |
| `give-item <player> <item> [qty]` | write/execute → `POST /api/players/.../give-item` | `players:mutate` | **owner** | Yes (shows item name, quantity, recipient) |
| `clear-backpack <player>` | write/execute → `POST /api/players/.../clean-inventory` | `players:mutate` | **owner** | Yes (Discord-side confirmation only — user types `"CLEAN INVENTORY"`; this is a UX safeguard against misclicks, not independently verified against the typed text server-side — see Section 3.5's clarification. Wording corrected after round-4 audit, batch #755, UI/UX hat: a prior revision's "server-required phrase" wording implied server-side verification of the typed text, which is inaccurate) |
| `unban <player>` | write/execute → `DELETE /api/players/.../ban` | `players:mutate` | admin | Yes (shows player name + original ban reason/date) |
| `fill-water <player>` | write/execute → `POST /api/players/.../refill-water` | `players:mutate` | admin | No (non-destructive) |

**Corrected during Layer-1 gap-closure work (found while extending the mechanical consistency script to verify endpoints against real code, not just IAM actions/tiers): this table's `ban` row had regressed to the exact CRITICAL #730-class bug ("ban/unban inverted") this document's round-2 audit already fixed once.** The row showed `DELETE /api/players/.../ban` — identical to the `unban` row directly below it — while the real, currently-correct source of truth (Section 3.5's `WRITE_ACTION_ROUTES`, never itself wrong) has always specified `ban` as `POST` and `unban` as `DELETE`, confirmed directly against `playerBanRoute()`'s real method-dispatch logic in `server.js` (`req.method === "POST"` → `banPlayer()`; `req.method === "DELETE"` → `unbanPlayer()`). Only Section 2's human-readable table cell had drifted; Section 3.5's machine-readable table (what Layer 2 actually builds from) was correct throughout, so this was never live-exploitable — but it's the same "a reader of the human-readable table alone gets the wrong answer" pattern this document has now hit for `history-clear`, `clear-backpack`, `warn`, and `fill-water`. Fixed above.

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
| `refill generators <base>` | write/execute → `POST /api/bases/.../refill-generators` | `bases:mutate` | admin | Yes (preview shows the target base name/id and current fuel level) |
| `refill water <base>` | write/execute → `POST /api/bases/.../refill-water` | `bases:mutate` | admin | Yes (preview shows the target base name/id and current water level) |

**Note**: `destroy` deferred until Core `DELETE /api/bases/:id` endpoint is implemented (#216).

**Preview content stated after the final confirmatory round (was part of #819 batch, UI/UX hat): both rows previously carried a bare "Yes" with no stated preview content, unlike most other tables' Confirmation cells in this document.** A bare "Yes" leaves an implementer free to ship a preview with no actual context (e.g. just the subcommand name), which for a base-scoped mutation gives the confirming admin nothing to verify they're refilling the intended base. Preview content added above; both are already-available fields (base identity, current resource level), not new data Core would need to expose.

### Group C: `server` — Server Control

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `restart` | write/execute → `POST /api/server/restart` | `server:restart` | **owner** | Yes (shows live player count, 30s cancellable countdown, requires typing server name) |
| `stop [reason]` | write/execute → `POST /api/server/stop` | `server:stop` | **owner** | Yes (requires typing "STOP"; dual-confirmation gate when 2+ eligible admins exist — see Safety note and its round-7 redesign below) |
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
administrator to confirm (dual-confirmation gate).

**Corrected after round-6 audit (was MEDIUM, batch #776, UI/UX hat): the dual-confirmation gate had no described end-to-end mechanism anywhere in this document.** Round 6's own first-pass design was substantially redesigned in round 7 after five hats found real problems (#782/#785/#786/#787) — but round 7's own redesign (an "independent second `write/preview`→`write/execute` cycle" tied to a brand-new, unspecified "pending stop request" record) was itself found structurally broken by a dedicated four-hat isolated review before it ever reached a full round 8: no field anywhere carried the correlation ID between the two confirmers' calls; idempotency-key semantics for the two cycles were unspecified with a plausible silent-fail-closed path where the real mutation never runs even though both admins genuinely confirmed; "Core's `stop` handler" was ambiguous enough to risk modifying the real, shared `/api/server/stop` route the web console also calls directly; the real, already-shipped bot-side button-click code enforces the *opposite* (same-user-only) authorization rule the second confirmer needs; the single-admin fallback decided whether a safety control applied *at all* using unsigned, unbounded, bot-cached role data — exactly the class of bug `roleSnapshotAt` exists to prevent; and the second confirmer's flow was ambiguous enough that a literal implementation could require two clicks instead of one. Filed as #792-799.

**Redesigned again (this pass) to reuse existing, already-hardened infrastructure instead of inventing a new record type and a second full round-trip:**

1. **Reframed as a process/UX safeguard, not an independent security boundary — closing the single-admin-fallback trust-boundary concern at its root.** The primary admin is *already* fully authorized to execute `stop` solo, via the same signature+capability+tier+nonce stack every other owner-tier action uses — that stack, not this gate, is the real security boundary, exactly the framing this document already established for `confirmPhrase` (Section 3.8: "a UX safeguard, not an independent security boundary"). The dual-confirmation gate is *additive* process friction on top of an already-fully-authorized action, intended to catch a single compromised or mistaken admin, not a hard technical control. This reframing is what makes the single-admin-fallback decision safe to make from best-effort, bot-cached role data: if the cache is stale and wrongly believes there's only one admin, the primary was still fully authorized to act solo anyway (nothing bypassed that wasn't already bypassable); if the cache is stale the other way (believes 2+ when there's really 1), the request simply times out after 5 minutes with a clear message naming the console UI as a direct alternative (point 8 below) — never a silent security failure either way.

2. **Enforcement mechanism, reusing the existing nonce store instead of a new record type.** Full mechanism specified in Section 3.8's "Nonce store" entry above — summarized here: `write/execute` for `action: "server.stop"` is handled entirely inside the **write-bridge's own handler**, before any internal loopback call is made — the real `server.js` route for `POST /api/server/stop` is never touched, matching Section 3.1's "reuse real route handlers unchanged" principle exactly (closing the ambiguous-enforcement-layer finding). When 2+ eligible admins exist, the primary's confirming call does **not** invoke the loopback — it marks the existing nonce `secondConfirmationRequired`/`primaryConfirmedAt` and returns a distinct `{ ok: true, pending: true, awaitingSecondConfirmation: true }` response (never the normal `{ ok: true, result: {...} }` — the primary's own client can now show an explicit "⏳ waiting for a second admin to confirm (up to 5 minutes)" state, closing the missing-feedback gap). A second `write/execute` call presenting the **same nonce**, signed by a **different** actor with their own fresh `verifyActorSignature()`/`requireDiscordCapability()`/`roleSnapshotAt` check (full rigor, not inherited), arriving within the nonce's extended 5-minute window, is the one and only call that invokes the real loopback and consumes the nonce. Because only one call ever reaches the loopback, there is no idempotency-key ambiguity to resolve — the primary's own call never touches the idempotency cache at all when a second confirmation is required.

3. **Second-embed click mechanism, closing the two-click UX ambiguity and the button-authorization mismatch.** The second embed's Confirm button uses a **distinct handler**, not the existing same-user-only `handleWriteButtonInteraction()` path (whose "this confirmation belongs to another user" rejection is exactly backwards for this case) — it explicitly requires a *different*, currently-eligible admin/owner and rejects the original requester. One click on this button triggers exactly one bot-side call to `write/execute` with the same nonce, per point 2 — never a second preview step, never a second embed shown to the clicker. This embed is posted as a normal, non-ephemeral channel message (not tied to the primary's own interaction), so every admin in the channel can actually see and act on it — an ephemeral second embed would make the gate silently unsatisfiable for anyone but the excluded primary.

4. **Timing budget.** The nonce's extended 5-minute TTL (point 2, Section 3.8) is the second confirmer's entire window, explicitly distinct from the primary's own 30-second self-cancel countdown for their own typed-phrase confirmation — soliciting a different human's attention is a fundamentally different problem than giving the same person a chance to abort.

5. **`userId`-exclusion residual risk**, now correctly scoped given point 1's reframing: a `userId` check cannot distinguish two genuinely different humans from one person operating two Discord accounts that both hold `admin`/`owner` — a Discord-identity-model limitation no technical control here can close, and not expected to, since this gate was never the real security boundary to begin with (point 1). Guild-administration/GRC responsibility, not something this control verifies.

6. **Single-admin fallback discoverability.** When the fallback applies, the primary's own preview embed includes a one-line note ("only one eligible admin found — proceeding without a second confirmation") so a solo operator who's read community docs describing the two-person gate isn't left wondering whether it silently failed.

7. **Second-embed content.** Shows the same live player count the primary confirmation shows, plus an optional reason string (`stop`'s command signature gains an optional `[reason]` parameter, shown on both embeds).

8. **Visual differentiation, and surfacing the residual risk to the people actually using it.** The second embed uses a distinct title and color (e.g. "🔒 SECOND CONFIRMATION REQUIRED") so it's never confused with the primary confirmation's own embed in the same channel, and its footer carries a brief, honest note — "this check confirms a different Discord account, not a different person" — so an admin relying on this gate can see its real guarantee, not just infer a stronger one from the UI's own framing. Point 5's design-doc-only residual-risk statement was real but reached only engineers/auditors, never the people actually depending on the control.

9. **Excluded-click feedback.** If the original requester clicks the second embed's own Confirm button, the distinct handler (point 3) responds with a visible ephemeral message — "You already confirmed this request; a different admin must provide the second confirmation" — never a silent no-op.

10. **Cancellation message.** On a 5-minute nonce expiry with no second confirmer, the bot posts "not enough confirmations, action cancelled" and names the console UI as a direct alternative for an operator who needs to stop the server outside this gate.

11. **Final-outcome notification to the primary, closing a gap found in the final confirmatory round (was HIGH #815, UI/UX hat): the redesign covered the transition INTO the waiting state, but never the transition OUT of it.** The primary confirmer, after seeing "⏳ waiting for a second admin," had no described way to learn whether the server actually stopped, was cancelled, or is still pending — the second embed and the cancellation message (point 10) are both posted as separate, non-ephemeral channel messages, not tied to the primary's own original interaction, so nothing guaranteed the primary ever saw either one. **Fix:** both terminal outcomes (a second confirmer's successful `write/execute`, and the 5-minute cancellation) edit the primary's own original confirmation message/interaction response directly — the one UI surface guaranteed visible to them — in addition to whatever else is posted to the channel. Success shows the real result (server stopped, by whom); cancellation shows the same message point 10 already specifies.

Layer 2 must add all of the following to Section 6's test plan (was HIGH #782, QA hat — this is the second time this same commitment has been made; verify it lands this time): single-admin fallback correctly waives the gate when exactly one eligible admin/owner exists, and the primary's preview embed notes it; the gate correctly activates when 2+ exist, and the primary's own confirming call returns `{ pending: true }` without ever invoking the real loopback (assert this with a call-count/spy on the loopback client, not just an observed Discord-side outcome — closing the round-7 test bullet's "primary's click could secretly trigger the real mutation" gap); a `stop` request where the same user attempts both confirmations is rejected by the distinct second-embed handler; a `stop` request with two distinct eligible admins succeeds, with the second confirmer's own `verifyActorSignature()`/`requireDiscordCapability()`/fresh-`roleSnapshotAt` checks independently exercised; the second confirmer's `write/execute` call is scoped to the *same* nonce as the primary's (not any other live pending `server.stop` nonce for the guild); a `stop` request where the second confirmation never arrives cancels cleanly within the 5-minute window; the second embed's content (player count, reason) and visual distinction from the primary embed; the second embed is genuinely channel-visible (not ephemeral) and reachable by an admin other than whoever triggered the primary confirmation.

The write-bridge must
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
| `spawn <preset>` | write/execute → `POST /api/maps/spawn` | `maps:spawn` | admin | Yes (shows preset, estimated resource usage; requires typing `"SPAWN MAP"` — added by the mechanical cross-reference script (issue #777, run after round 6), see Group A's `ban` row correction note above) |
| `despawn <map>` | write/execute → `POST /api/maps/despawn` | `maps:despawn` | admin | Yes (shows connected players; requires typing `"DESPAWN MAP"`) |
| `respawn <map>` | write/execute → `POST /api/maps/respawn` | `maps:restart` | admin | Yes (requires typing `"RESTART MAP"`) |
| `teleport <player> <map>` | write/execute → `POST /api/map/teleport-player` | `maps:teleport` | admin | Yes (shows player + destination) |

**Safety**: `spawn` checks available memory and port slots before confirming (#223). `despawn` warns about connected players. 15s cooldown group.

### Group E: `carepackage` — Care Packages

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `grant <player> <tier>` | write/execute → `POST /api/care-package/grant/:id` | `carepackage:grant` | admin | Yes (shows player + tier) |
| `grant-all` | write/execute → `POST /api/care-package/grant-eligible` | `carepackage:grant-all` | **owner** | Yes (shows eligible count; requires typing a confirmation phrase, matching Section 4's classification — corrected after the final confirmatory round, batch #819, this cell previously read as button-only, contradicting Section 4; exact phrase value still genuinely open, see Section 3.5's verification-status note) |
| `enable` | write/execute → `POST /api/care-package/enable` | `carepackage:write-config` | admin | No |
| `disable` | write/execute → `POST /api/care-package/disable` | `carepackage:write-config` | admin | No |
| `scan` | write/execute → `POST /api/care-package/run` | `carepackage:scan` | admin | No |
| `history clear` | write/execute → `POST /api/care-package/history/clear` | `carepackage:clear-history` | **owner** | Yes (requires typing `"CLEAR GRANT HISTORY"` — corrected after round-4 audit, batch #755, UI/UX hat: this row still showed the pre-round-3 wrong value even after Section 3.5's route table was corrected; both places must agree, Section 3.5's `WRITE_ACTION_ROUTES` is the single source of truth) |

**Corrected after round-6 audit (was HIGH #771, DBA hat): `grant-all`'s IAM Action was wrongly cited as `carepackage:grant` — identical to plain `grant`'s.** The real console (`actions.js:251-256`) uses a deliberately different, narrower action for `grant-all` — `carepackage:grant-all`, created specifically because of #219's server-wide-injection risk (the real code's own comment states this is "its own action, narrower than `carepackage:grant`"). Fixed in the table above. This miscitation had already propagated into round 5's own new cross-IAM-consistency finding in Section 5 below (fixed there too — see that section's own correction note).

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
| `add <player> <guild>` | write/execute → `POST /api/guilds/.../members` | `guilds:mutate` | admin | Yes (preview shows the target player and destination guild name) |
| `remove <player>` | write/execute → `DELETE /api/guilds/.../members/...` | `guilds:mutate` | admin | Yes (preview shows the target player and their current guild) |

**Preview content stated after the final confirmatory round (was part of #819 batch, UI/UX hat, same finding as Group B's above): both rows previously carried a bare "Yes" with no stated preview content.** Added above so the confirming admin can verify player identity and guild before either mutation runs, consistent with every other Yes-confirmation row in this document that states what its preview shows.

**Note**: `create` and `rename` deferred until Core `POST /api/guilds` and `PUT /api/guilds/:id` endpoints are implemented (#216).

**Corrected during Layer-1 gap-closure work (found by the same endpoint-verification script extension that caught the `ban`/`unban` regression above): `remove`'s table row had regressed to the exact HIGH #743 bug ("guild.remove route entry missing the target member path segment") this document's round-3 audit already fixed once.** The row showed `DELETE /api/guilds/.../members` with no segment for the target member, while Section 3.5's `WRITE_ACTION_ROUTES` (the real source of truth, never itself wrong here) has always correctly included both the `guildId` and `playerId` segments. Only Section 2's human-readable table cell had drifted. Fixed above.

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

**Security**: Both endpoints require `verifyActorSignature({ required: true, fields: WRITE_BRIDGE_SIGNED_ACTOR_FIELDS })` + `requireDiscordCapability()`. Nonce is single-use with 60s expiry. Idempotency key prevents duplicate executions.

**Corrected after round-6 audit (was HIGH #768, Cloud Security hat): this example was never updated for round 5's own signed-fields threading fix, leaving the one call site that actually verifies write-bridge signatures uncovered.** Section 3.8's threading fix names three functions and the **bot-side signing call** as needing the `WRITE_BRIDGE_SIGNED_ACTOR_FIELDS` override — but never explicitly names `write/preview`'s and `write/execute`'s own call to `verifyActorSignature()` as the fourth required call site, and this section's own canonical example (above) showed the call with no `fields` argument at all, unchanged since before round 5. Built as literally shown, `verifyActorSignature()` would default to the shared `SIGNED_ACTOR_FIELDS` array while the bot (correctly, per 3.8) signs with `WRITE_BRIDGE_SIGNED_ACTOR_FIELDS` — every write-bridge signature verification would fail from day one, and the doc itself already warns (3.8) that the predictable "fix" under pressure is folding `roleSnapshotAt` back into the shared array, reintroducing CRITICAL #749. **Fixed:** the example above now passes `fields: WRITE_BRIDGE_SIGNED_ACTOR_FIELDS` explicitly, matching 3.8's threading requirement — this is the fourth and final call site (alongside `canonicalActorSignaturePayload()`, `signActorPayload()`, and the bot-side signing call) that must use the write-bridge's own field set, not the shared one.

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

**Corrected after round-6 audit's own self-verification pass (not a hat finding — caught re-reading this round's own CRITICAL #763 fix below against this paragraph): this description is now only half-accurate once the #763 fix is applied.** The credential check (token comparison, path-scoped match) now runs once, earlier, inside `requestHandler` — triggered by `opts.viaWriteBridgeSocket === true`, exactly as this paragraph already says — but its purpose there is to decide the `ADMIN_ALLOWED_IPS` exemption (see the #763 correction below), not merely to gate auth-resolution. Its *result* (the resolved `discord-write-bridge` principal or `null`) is threaded through `opts` to `handleApi`/`auth.requireAuth`, which populate `req.authSession` directly from that already-verified result rather than re-running the token check a second time. The flag-first, no-token-eligibility guarantee this paragraph states remains true; only the mechanics of *where* the token itself gets checked moved, from inside the auth-resolution branch to inside `requestHandler`, one level up.

**Corrected after round-4 audit (was CRITICAL #750, found independently by Architect + Network hats, Network hat's finding empirically reproduced), then narrowed further after round-5 audit (was HIGH #757, found independently by Security + Architect hats): `requestHandler`'s real, pre-existing `ADMIN_ALLOWED_IPS` gate must exempt genuinely-authenticated write-bridge requests, not just Unix-socket-listener traffic in general.** `server.js`'s real dispatcher checks `config.allowedIps` *before* any routing/auth logic runs, on every request — `req.socket.remoteAddress` is `undefined` for a Unix-socket connection (empirically confirmed), which normalizes to `""`, which can never match a configured allowlist entry, so every write-bridge request would be unconditionally 403'd for any operator with `ADMIN_ALLOWED_IPS` set (the officially-documented, code-enforced compensating control for `ADMIN_AUTH_DISABLED=1` on a non-loopback bind — exactly the operators running the most security-conscious supported configuration) unless exempted.

**Round-4's first fix exempted this check purely on the listener flag (`opts.viaWriteBridgeSocket === true`) — round 5 found this is too broad and, separately, impossible to implement as described.** Per Section 3.2, a request arriving over the Unix socket that fails the token check or doesn't match a `WRITE_ACTION_ROUTES` entry "falls through to normal `requireAuth()` behavior," not an outright rejection. Exempting `ADMIN_ALLOWED_IPS` purely on the listener flag means **every** request over the socket skips the IP check, including ones that fall through to plain `requireAuth()` — under `ADMIN_AUTH_DISABLED=1` (where `requireAuth()` returns a synthetic owner-tier session for any request with zero credential check), any same-permission local process could open a plain, credential-less request over the socket and land in `requireAuth()` with full unauthenticated owner-tier API access, defeating the exact compensating control the operator turned on `ADMIN_ALLOWED_IPS` to provide. Separately, the flag itself has no described path to the code that needs it: `handleApi(req, res)` and `auth.requireAuth(req, res)` are both real, existing 2-argument functions with no `opts`/path parameter — the flag cannot reach the auth-resolution branch as literally described.

**Round-5's fix threaded `opts` into the wrong pair of functions — round 6 found the real `ADMIN_ALLOWED_IPS` gate runs before either of them is ever called, so CRITICAL #750 was still effectively unfixed (was CRITICAL #763, found independently by Architect + Security hats).** `handleApi(req, res, opts)` and `auth.requireAuth(req, res, path, opts)` are both structurally *downstream* of the real gate: `server.js`'s `createServer()` callback — the exact function this section calls `requestHandler` — checks `config.allowedIps` as its very first statement and unconditionally rejects with `403` before its own `try`/`handleApi`-dispatch block ever runs. Passing `opts` into `handleApi`/`requireAuth` cannot exempt a request that never reaches either function: a Unix-socket connection's `req.socket.remoteAddress` is `undefined` → normalizes to `""` → never matches any configured allowlist entry → `requestHandler` returns `403` and the response ends before `handleApi` (or the newly-opts-aware `requireAuth`) is ever invoked. As specified, every write-bridge request is still unconditionally rejected for any operator with `ADMIN_ALLOWED_IPS` set — the exact bug round 4 found and two subsequent rounds each believed had been fixed.

**Fixed:** the `config.allowedIps` check itself must move into `requestHandler`'s decision, not stay a blind pre-check ahead of it. Concretely: `requestHandler(req, res, opts)` performs the write-bridge credential check (token + method+path-scoped match against `WRITE_ACTION_ROUTES` — restated after the final confirmatory round, was part of #819 batch, to match the method-axis test coverage added in Section 6) **inline, before** the `config.allowedIps` branch, whenever `opts.viaWriteBridgeSocket === true` — if that check succeeds, skip the `allowedIps` branch entirely and proceed to dispatch (`handleApi`, which internally already knows via `opts`/`path` that this is an authenticated write-bridge request and must not re-run the credential check a second time, only propagate the resulting `discord-write-bridge` principal onto `req.authSession`); if it fails, fall through to the normal `config.allowedIps` check exactly as any other request would. This requires the credential-verification logic (token comparison, path-scope match) to be factored into a function callable from both `requestHandler` (for the exemption decision) and `handleApi`/`auth.requireAuth` (to actually populate `req.authSession`) — named here explicitly, not left for a Layer 2 implementer to invent: e.g. `resolveWriteBridgePrincipal(req, path)` returning the principal or `null`, called once by `requestHandler` to decide the `allowedIps` exemption and its result threaded through `opts` so `handleApi`/`requireAuth` don't have to re-verify. A request that fails write-bridge auth and falls through to `requireAuth()` remains fully subject to `ADMIN_ALLOWED_IPS`, exactly as it would over the TCP listener. Layer 2 must add a regression test that specifically calls `requestHandler` (not `handleApi` directly) with a real write-bridge credential and `ADMIN_ALLOWED_IPS` set, asserting success — a test against `handleApi` alone cannot catch this class of bug, since `handleApi` was never the broken layer.

**Corrected after round-7 audit (was HIGH #780, Architect + Security hats, corroborated): `resolveWriteBridgePrincipal(req, path)` is called from `requestHandler`, but `requestHandler` never computes a `path` value before this call — the only existing `path` computation lives inside `handleApi`, a different function invoked only after the `allowedIps` branch this call is meant to precede.** As specified, a Layer 2 implementer would either add a second, independent `new URL(req.url, ...).pathname` parse inside `requestHandler` — directly violating round 3's own categorical rule that path-scoping must reuse one canonicalized value, never re-parse `req.url` a second time (Section 3.5's #747 fix) — or have to invent an unstated refactor of `handleApi` to share its existing parse. Not exploitable today (both parses of the same immutable `req.url` are deterministic and would agree), but it leaves a stated invariant unsatisfied by omission, exactly the pattern that produced the #750→#757→#763 saga in this same call chain. **Fix:** `requestHandler` computes `path` once — hoist the `new URL(req.url, "http://localhost").pathname` computation out of `handleApi` and into `requestHandler`, before the `resolveWriteBridgePrincipal` call — and pass that single value down into both `resolveWriteBridgePrincipal` and `handleApi`'s own dispatch logic. `handleApi` no longer computes its own `path`; it receives the one `requestHandler` already derived.

**Corrected after round-7 audit (was HIGH #783, QA hat): the only existing test bullet for this credential-resolution logic (Section 6, "Principal-type resolution") predates `resolveWriteBridgePrincipal()` and tests only full-stack accept/reject outcomes, never this function's own contract.** Missing: a direct unit test of `resolveWriteBridgePrincipal(req, path)` itself, asserting its raw return value (principal object vs. `null`) across all four combinations of correct/wrong token × correct/wrong path; and a test proving `handleApi`/`requireAuth`, given a pre-resolved principal via `opts`, do NOT re-run the token comparison a second time — without this, an implementation could satisfy every existing test while `handleApi` silently re-verifies with a subtly different, drifted check, the same "two copies silently diverge" risk this document already flags for `constantTimeHexEqual`. Layer 2 must add both as their own Section 6 bullets, separate from the existing full-stack integration test.

**Corrected after round-4 audit (was HIGH #753, found independently by Network — empirically reproduced — + UI/UX + QA hats): the Unix-socket listener needs explicit restart-safety handling neither 3.1 nor 3.4 previously specified.** A Unix-socket file (unlike a TCP port) persists on disk across an unclean shutdown (OOM-kill, `docker restart`, host power loss) — `runtime/generated/` is a host bind-mount, not tmpfs, so a stale socket file survives a container restart. Empirically confirmed: (a) a stale file at the target path makes the next `.listen(socketPath)` fail with a real `EADDRINUSE`; (b) an unhandled `'error'` event on that listener throws by default, crashing the *entire* Node process — directly reproducing the whole-console-outage risk Section 3.5's failure-scope fix was written to prevent, just via a different startup path than the one that fix patched. **Fix:** (1) before `.listen(socketPath)`, remove any pre-existing file at that path (`fs.rmSync(socketPath, { force: true })` or equivalent stat-and-unlink); (2) attach an explicit `.on("error", ...)` handler to this specific `http.Server` instance that logs loudly and disables the RW subsystem only (matching Section 3.5's existing pattern), never left to the default throw-and-crash behavior.

**Corrected after round-5 audit (was MEDIUM, batch #762, Network hat — empirically reproduced and a mitigation empirically validated): unconditional unlink-before-listen removes the one signal that would otherwise catch two Core instances overlapping.** A prior revision's "remove any pre-existing file" step doesn't distinguish a genuinely stale file (no live listener behind it) from a file backing a *currently live* listener (e.g. a brief overlap between an old and new container during a restart). Empirically confirmed: an unconditional `fs.rmSync` silently deletes a still-live listener's directory entry, and the second process's `.listen()` then succeeds cleanly — zero `EADDRINUSE`, zero error-handler firing, on either process. The first process keeps running but becomes unreachable via the path (an orphaned instance holding resources); the second silently takes over all new traffic. This is a real regression relative to the un-patched behavior for exactly the overlap condition Section 3.4's single-process assumption already flags as the one thing that would invalidate this whole design's premises — turning a loud failure into a silent one. **Fix:** before unlinking, probe with a real `net.connect({ path: socketPath })` (short timeout). If the connect succeeds, a live listener is already there — do **not** unlink; treat it exactly like a genuine `EADDRINUSE` (log loud, disable the RW subsystem only, matching Section 3.5's pattern) and let the rest of Core boot normally. Only unlink when the probe fails (`ECONNREFUSED`/`ENOENT`, i.e. genuinely stale) — empirically validated this exact mitigation correctly distinguishes both cases.

**Corrected after round-6 audit (was HIGH #772, Network hat, empirically proven): the probe's `'timeout'` event must be explicitly wired to fail the probe, or a stalled probe can hang Core's entire boot, not just the RW subsystem.** Node's `net.Socket` `'timeout'` event is not terminal by itself — a socket with only `'connect'`/`'error'` handlers never settles once `'timeout'` fires (empirically confirmed on this host: a socket left this way stays open and unresolved indefinitely after its timeout fires). Local AF_UNIX `connect()` normally resolves in single-digit milliseconds either way, so this doesn't fire under a normal local-disk deployment — but `runtime/generated/` is an established host bind-mount, and nothing prevents an operator from bind-mounting it onto network-backed storage (NFS/CIFS, a stalled FUSE mount) or a host under severe I/O pressure, either of which can make the underlying syscall genuinely stall. If the probe's promise never settles, Core's boot sequence — which must decide unlink-vs-not before calling `.listen(socketPath)` — never proceeds, silently hanging the **entire console's boot**, not just RW: strictly worse than the already-fixed stale-socket `EADDRINUSE` case, since a hang is silent where a crash is loud and restart-supervised. **Fix, corrected after round-7 audit (was CRITICAL #779, Architect + Network hats, independently corroborated, both empirically proven this reproduces the exact hang it was meant to fix): the `sock.destroy()` call above must pass an `Error`, or the `'error'` handler this whole mechanism depends on never fires and the probe's Promise never settles.** Node's `net.Socket.destroy()` called with **no argument** emits only `'close'` — it does not emit `'error'`. Since this probe's entire decision logic branches on `'connect'` (live) vs. `'error'` with `ECONNREFUSED`/`ENOENT` codes (stale), a bare `sock.destroy()` on timeout reaches neither branch: the underlying socket handle is released (no fd leak), but whatever code is `await`ing this probe's result — which is what actually gates the unlink-vs-not decision before `.listen(socketPath)` — hangs indefinitely anyway. This reproduces, one level up, the exact whole-console-boot-hang this fix exists to prevent. Empirically confirmed independently by two hats on this host's real Node runtime: `sock.destroy()` (no arg) never fires `'error'`, even 5+ seconds later; `sock.destroy(new Error(...))` (with an arg) correctly fires `'error'` and settles the probe. **Corrected fix:** `sock.on('timeout', () => sock.destroy(new Error("write-bridge liveness probe timed out")))` — the `Error` argument is not optional, it is the entire mechanism by which this handler reaches the existing `'error'`-branch logic. On that branch: **timeout is a third, distinct outcome from both "live" and "genuinely stale" — treat it the same way as the live-listener case for safety (do NOT unlink, since a probe that couldn't complete is not proof of staleness), not the same way as `ECONNREFUSED`/`ENOENT`** (round-6's wording, "falling to the same path as `ECONNREFUSED`/`ENOENT`," directly contradicted the concrete instruction in the same sentence — `ECONNREFUSED`/`ENOENT` unlinks per this section's own round-5 semantics, while a timeout must not; corrected here, was MEDIUM, batch #791, Security hat). Log loud and disable the RW subsystem only, matching Section 3.5's blast-radius-scoping pattern; state explicitly that write-bridge subsystem startup (including this probe) must never block the main TCP listener's own readiness. The probe's arming (`sock.setTimeout(N)`) and its duration must be stated explicitly by Layer 2 — this design deliberately leaves the exact value unspecified (a short, fixed duration in the low seconds is sufficient given local AF_UNIX `connect()` normally resolves in single-digit milliseconds) but the arming call itself is mandatory, not implicit.

**Corrected after round-4 audit (was MEDIUM, batch #755, Architect/Cloud Security/Security hats): the socket's `mode 0700` claim needs an explicit mechanism.** Node's `http.Server`/`net.Server` for AF_UNIX sets permissions from the process umask at bind time, not a fixed `0700` — nothing produces that mode automatically. **Fix:** call `fs.chmodSync(socketPath, 0o700)` immediately in the `'listening'` callback (after the stale-file cleanup and error-handler attachment above), and add a startup self-check assertion that the resulting file mode is exactly `0700` before considering the RW subsystem healthy.

**Corrected after round-5 audit (was MEDIUM, batch #762, Security hat): chmod-after-listen leaves a real, if brief, TOCTOU window at ambient-umask permissions.** Node's `bind()` for a Unix-domain-socket path happens synchronously inside `.listen()`, creating the socket file on disk — but the `'listening'` event (where `chmodSync(0700)` runs, per the fix above) fires on a later tick. Under a common container umask (e.g. `022`), the file sits at mode `755` (world-connectable) for that window. Bounded by the credential's second check (the in-memory token, still required even with filesystem reachability) so this isn't a full bypass on its own — but "chmod after listen" is a well-known anti-pattern for exactly this reason, in a mechanism built specifically to close a permission boundary. **Fix:** set a restrictive `process.umask(0o077)` immediately before `.listen(socketPath)`, restoring the process's prior umask **synchronously, on the very next line, right after `.listen()` returns** — so the socket file is created with safe permissions atomically at bind time, eliminating the window rather than closing it after the fact. Keep the existing `chmodSync` + startup self-check assertion as defense-in-depth on top of this, not as the sole mechanism.

**Corrected after round-6 audit (was MEDIUM, batch #776, Architect + Network hats, independently corroborated, Network hat's timing empirically measured): restoring the umask in the `'listening'` callback instead of synchronously is NOT an equivalent alternative — a prior revision of this fix offered both as interchangeable.** `process.umask()` is process-global state, not scoped to this one socket. Empirically measured on this host: the synchronous-restore variant closes the window completely (the file's mode is already correct at the very first observable instant); the `'listening'`-callback variant leaves the restrictive `0o077` umask in effect for a real, measured ~1-2.5ms gap between `.listen()` being called and the `'listening'` event firing. Any *other* file-creation in the same Core process during that window (a log write, another module's atomic-write temp file, `secondFactorStore.js`, etc. — all plausible exactly during Core's own async-heavy boot sequence) silently inherits the tightened umask, an unintended over-restrictive-permissions correctness bug on unrelated files. **The `'listening'`-callback option is removed as a stated alternative — restore only synchronously, on the line immediately after `.listen()` returns.**

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

- **Path-scoping must reuse the already-canonicalized `path` value, never re-parse `req.url`.** The exact-match check against `WRITE_ACTION_ROUTES` (above) must consume the same `path` variable computed once via `new URL(req.url, "http://localhost").pathname` (`server.js:666-667`) — passed into this branch as a parameter, not independently re-derived inside `auth.js`. Two separate parses of the same input risk a normalization mismatch (querystring handling, `.`/`..` collapsing, trailing slashes) between what the credential check approves and what actually gets dispatched — exactly the class of confusion #728's path-scoping fix exists to prevent. **Corrected after the final confirmatory round (was part of #819, batch, GRC hat): this bullet previously said "`server.js`'s own dispatcher already computes once," a phrasing left over from before round 7's #780 fix and ambiguous about which function that dispatcher actually is today.** As of the #780 fix (see the correction below in this section), that single computation site is `requestHandler`, not `handleApi` — `handleApi` receives the already-computed value as a parameter and must not compute its own. Named explicitly here so this bullet and the #780 correction agree on exactly one function, not two different ones under the same "dispatcher" label.
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
2. **The token itself, compared via `crypto.timingSafeEqual`** (matching the existing pattern already used for actor-signature comparison in `integrations/discord/actorSignature.js:88-93`'s `constantTimeHexEqual` — including that function's length-equality guard *before* calling `timingSafeEqual`, added explicitly after round-4 audit, batch #755: `crypto.timingSafeEqual` throws `RangeError` on mismatched-length buffers, so the comparison must check `receivedToken.length === realToken.length` first, exactly as the cited precedent does, not a bare call that could throw on a malformed-length token), as defense-in-depth against a bug elsewhere in this same process that might expose the socket path to unintended callers within the process's own privilege boundary. **Clarified after round-6 audit (was LOW, batch #776, Cloud Security hat): `constantTimeHexEqual` is today a local, non-exported helper in `actorSignature.js` — Layer 2 must export it and import it here rather than reimplementing the identical length-guard-then-`timingSafeEqual` logic a second time**, to avoid the two copies silently drifting apart the way this document's own repeatedly-found duplicate-wording bugs (clear-backpack, history-clear) have shown unstated duplication tends to.

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
  "server.stop":          { method: "POST",   path: () => `/api/server/stop` },      // real Core phrase gate not yet built -- see #223/#732; dual-confirmation gate handled entirely in the write-bridge's own write/execute logic before this route is ever reached, see Section 3.8's Nonce store entry -- this real target route is never modified
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

**Failure scope, stated explicitly (round-2 audit, UI/UX CRITICAL #737):** a prior revision said this "refuses to boot with a loud error" without scoping the blast radius — Core also serves the entire game console/API to every operator of this fork, not just Discord write commands, so an unscoped crash on drift would take down the whole self-hosted stack on a routine update. **The self-check must fail closed on the RW subsystem only**: log the specific drifted entry loudly, disable write-bridge routes entirely, and let Core boot and serve everything else normally. A future update that breaks a `WRITE_ACTION_ROUTES` entry must never be able to take an operator's whole console offline. Layer 2 must also add a troubleshooting entry (`docs/integrations/discord-integration/admin-guide.md`/`faq.md` — full path per round-6's correction, batch #776, Cloud Security hat: this reference was still bare after round 5 fixed the identical ambiguity elsewhere in this doc) naming this exact failure mode and what an operator should do about it.

**Corrected after round-2 audit (was HIGH #731, Architect meta-finding C4): this self-check has a real, structural blind spot and must not be described as a complete fix for #216-class drift.** It can only prove a `(method, path)` pair resolves to *some* known action — `actions.js`'s action namespace is deliberately coarser than `server.js`'s actual per-path handler identity, so it would have passed the original ban/unban-inversion and give-item-wrong-endpoint bugs cleanly (both resolved to real, valid actions, and both have since regressed at least once in this very document — see Group A/G's own correction notes above, caught only by extending the mechanical script, not by this self-check).

**Closed during Layer-1 gap-closure work (was HIGH #731, Architect hat — the "needs a second, per-entry verification layer" gap, flagged since round 2, finally has an actual design, not just an acknowledgment):** every real Core mutation handler already emits a unique, string-literal "behavioral fingerprint" at or near its dispatch point — either a literal action/task-name string passed directly at the dispatch call (e.g. `directDbMutation(req, res, "guilds.remove-member", ...)`, `giveSingleItemRoute(req, res, path, "adminGiveItem")`), or, for handlers that share one method-agnostic dispatch line (today's `ENDPOINT-METHOD-UNVERIFIED` case, e.g. `playerBanRoute`), a `req.method === "X" ? "action.a" : "action.b"` ternary immediately visible in the handler body (confirmed: `players.ban` vs `players.unban`, `players.give-item` vs `players.give-item-id`, `guilds.disband` vs `guilds.remove-member`). This design doesn't invent these fingerprints, only reads them.

**Required addition #1 (schema):** every `WRITE_ACTION_ROUTES` entry gains a required `auditAction` field — the exact real audit-log action string or dispatch-site literal the entry's handler is expected to emit — playing the same machine-checkable role `confirmPhrase` already plays. Example: `"player.ban": { method: "POST", path: ..., confirmPhrase: "BAN PLAYER", auditAction: "players.ban" }`, `"guild.remove": { method: "DELETE", path: ..., auditAction: "guilds.remove-member" }`. Layer 2 fills in every entry's real value against `server.js` directly, never guessed.

**Required addition #2 (mechanical script):** a new check in `docs/design/scripts/rw-architecture-consistency-check.py`, extending the existing endpoint-verification check's route extraction rather than duplicating it — at the matched dispatch line, extract the real fingerprint (direct-literal, or a brace-balanced scan into the handler body for the method-branching ternary case) and compare it against the entry's declared `auditAction`, flagging any mismatch (including same-family swaps like `players.ban` found where `players.unban` was declared) at the same severity as an endpoint-method mismatch, and explicitly flagging (never silently passing) any entry where neither extraction strategy finds a fingerprint at all.

**Deliberately a static, CI-time check, not a Layer-2 runtime self-check.** A runtime equivalent would require actually invoking handlers like `server.restart`/`map.despawn`/`player.ban` at every Core boot to observe which code path fires — several have real, irreversible, player-facing side effects (Strict Requirement 0), with no safe dry-run path. Static extraction has already caught this exact bug class twice in this document's own history (the original round-2 finding, and this session's `ban`/`unban` and `guild.remove` regressions), at zero runtime cost, catching drift the moment either the doc or `server.js` changes — strictly earlier than any boot-time check could. **#731 is closed by the combination of this static check (pre-merge) and the existing Layer 2 integration-test requirement below (pre-release) — not by a third, runtime-at-boot mechanism**, which would add real risk to this codebase's live mutation routes for no benefit static analysis doesn't already provide.

### 3.6 `GET /api/items` catalog endpoint (resolves #222)

A new read-only Core endpoint, `GET /api/items?q=<term>&limit=25`, gated **only** by the Discord bot's own capability system (`requireDiscordCapability`, minimum tier `moderator`) — not by console `policy.js` (round-2 audit, Security MEDIUM #740: a prior revision reasoned in console-IAM vocabulary for an endpoint whose only real caller is the Discord bot's own autocomplete handler, conflating the two separate tier spaces Section 0 itself declares independent). Backed by the real item **catalog** (names/ids/volume/stack size — `runtime/data/admin-items.json` via `adminCatalog.js`), capped at 25 results (Discord's own autocomplete choice limit) and required to respond within the bot's autocomplete 3s budget. **Rate-limited per actor, added after the final confirmatory round (was MEDIUM, batch #819, Security hat): this endpoint has the identical threat shape this design already recognizes and mitigates for `write/preview`** — cheap, no-mutation, fired repeatedly (on every autocomplete keystroke) by any `moderator`-tier-or-above actor. Applies the same per-actor rate-limit treatment already established for `write/preview` in the Eviction-policy paragraph below, rather than leaving this one read endpoint as the sole unbounded call path in the design.

**Corrected during Layer-1 gap-closure work (was MEDIUM-HIGH, QA hat, a quick scoped check of this long-flagged gap): match semantics must be substring, matching the codebase's only existing precedent, not a new prefix-only implementation this design previously specified.** `adminCatalog.js` already has a live, tested catalog-search function, `listCatalogItems()` — backing the existing `GET /api/admin/items/catalog` route and `marketItemOverrides.js` — and it implements **substring** matching (`q: "fiber"` matches "Plant Fiber," confirmed directly against its own test), not prefix matching. A prior revision of this section committed to a *new*, dedicated *prefix*-only match — a real, previously-unflagged inconsistency with the only existing precedent for catalog search in this codebase, and duplicate catalog-loading logic to boot. **Fixed: this endpoint reuses `listCatalogItems()` directly** rather than building a separate prefix-matching index — consistent with the existing admin-console item search, no new catalog-loading code, no boot-time in-memory index to keep in sync with the on-disk file. Empty/missing `q` (a real case — Discord fires autocomplete on field-focus before typing) returns the first 25 catalog rows in a stable order, matching `listCatalogItems()`'s own existing empty-term behavior rather than a separately-invented empty-array case.

**Corrected after the final confirmatory round (was HIGH #814, UI/UX hat): the design previously described this as matching "names," but `listCatalogItems()` actually filters against `id`, `name`, AND `category`, and does no result ranking at all — a plain `.slice(0, max)` over whichever order items sit in on disk.** "Stable order" (above) means "arbitrary file order," not a meaningful sort. **Concrete consequence:** under the 25-result Discord autocomplete cap, an admin's intended item can be pushed past the cap by unrelated substring/category matches earlier in the file, with no error or "more results" indicator — this directly affects `give-item`, an owner-tier command with an already-open economy-risk gap (#218). **Accepted for Layer 1 as a documented, real limitation, not silently glossed over:** this design does not add ranking (exact-match-first, then prefix, then substring) at this time — the real catalog's size is expected to be small enough that this is a minor, occasionally-annoying UX gap rather than a functional blocker, and adding ranking logic on top of a reused, already-correct function would reintroduce exactly the kind of new, unshared logic this fix was written to avoid. If the real catalog grows large enough for this to matter in practice, ranking should be added as a documented enhancement to `listCatalogItems()` itself (benefiting every caller, not just this endpoint), not as endpoint-specific logic here.

**Corrected after round-2 audit (was HIGH #736, DBA hat):** a prior revision claimed this reuses "the same source of truth" as `give-item`'s item-type allowlist per #218 — **false**. #218 is still open; none of its required mitigations (quest-item/admin-only-flag exclusion, 1-stack cap, 10/day volume limit) exist anywhere in this codebase today, and `admin-items.json` has no data field that could back such a filter. This endpoint reuses the item **catalog only** (for autocomplete display purposes) — the safety allowlist #218 requires is separate, not-yet-built enforcement that must still be added to `giveSingleItemRoute` (`server.js:1271`, the real handler behind `POST /api/players/:id/give-item` — see Section 3.5's route table; not the similarly-named but unrelated storage/base-container give-item routes), not something this endpoint provides. (Cross-reference named explicitly after round-3 audit, DBA finding, batch #747 — a prior revision left this pointer vague enough that a future implementer could misplace the fix among several similarly-named routes.)

**Catalog refresh policy — corrected after the final confirmatory round (was HIGH #811, DBA + Security hats, independently corroborated): this paragraph described a design this doc no longer uses.** It previously said a catalog update "requires a Core restart to take effect in this new in-memory index," matching `adminItemMetadata()`'s caching discipline — accurate for the ORIGINAL prefix-matching-index design, but this session's Layer-1 gap-closure fix above replaced that with direct reuse of `listCatalogItems()`, which was never cached or memoized to begin with — confirmed directly against real code: it does `JSON.parse(readFileSync(...))` fresh on every call, identical to `resolveCatalogItem`'s existing live-read behavior. **`admin-items.json` changes are git-committed/deploy-only (no runtime write path exists), but no Core restart is needed for a change to take effect — the very next `GET /api/items` call reflects it, same as every other `adminCatalog.js` function.** This paragraph's own stale claim had already propagated into a Section 6 test bullet asserting the opposite; both corrected together.

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

**Threading, made explicit after round-5 audit (was MEDIUM, batch #762, found independently by Cloud Security + Architect hats): three functions need the new parameter, not one.** A prior revision said only "`verifyActorSignature()` gains an optional `signedFields` parameter" — but the real `verifyActorSignature()` computes its expected signature via `signActorPayload()`, which itself calls `canonicalActorSignaturePayload()` — the function that actually hardcodes the shared `SIGNED_ACTOR_FIELDS` array. All three (`canonicalActorSignaturePayload()`, `signActorPayload()`, `verifyActorSignature()`) must gain the same optional parameter, named exactly `fields` — corrected after round-7 audit (was HIGH #789, Cloud Security hat): this sentence previously offered `fields`/`signedFields` as interchangeable, an unresolved ambiguity round 6's own fix to #768 didn't carry back here. `fields` is the name to use everywhere, matching the canonical example in Section 3 (already corrected there) — `signedFields` is not a valid alternative and must not appear in any Layer 2 implementation. (Why this matters: JS object literals silently ignore unrecognized keys — if `verifyActorSignature()`'s real parameter were ever named `signedFields` while a call site passes `fields:`, the function would silently fall back to its default, the *shared* array, causing every write-bridge signature to fail verification from day one — the exact #768 failure mode, reproduced via a naming mismatch instead of a missing argument.) Each defaults to `SIGNED_ACTOR_FIELDS` so every existing caller is unaffected, threaded through in that order. Left unspecified, a Layer 2 implementer facing "thread a parameter through three functions across the call chain" might reasonably reach for the smaller-looking shortcut of folding `roleSnapshotAt` back into the shared array — reintroducing the exact CRITICAL #749 this whole redesign exists to prevent. The **bot-side** signing call must also pass this same override explicitly when producing the envelope for `write/preview`/`write/execute` — it can never produce a signature Core will accept otherwise.

**Corrected after round-6 audit (was MEDIUM, batch #776, Cloud Security hat): this array's zero-rollout-risk argument only covers its initial creation, not its future evolution.** The "ships together as one new feature" reasoning above explains why `WRITE_BRIDGE_SIGNED_ACTOR_FIELDS` didn't need #691's coordinated-rollout discipline *this first time* — but says nothing about a later change to this same array. A future field addition here, deployed Core-ahead-of-bot (the documented normal rollout condition per #749's own finding), would reproduce #749's exact failure mode, just scoped to the write bridge instead of five shared routes. **Fix:** any future change to `WRITE_BRIDGE_SIGNED_ACTOR_FIELDS` must follow the same coordinated, versioned, Core/bot-synchronized rollout discipline #691 established for the shared array — this array being independent from the shared one doesn't exempt it from needing the same discipline going forward, only from needing it retroactively for its one-time initial creation.

**Made concrete after round-7 audit (was MEDIUM, batch #791, Cloud Security hat): the fix above restated the principle without saying where it's enforced.** The real #691 precedent for the shared array is enforced today as an inline code comment directly adjacent to the array's declaration (`policy.js`'s own comment: "a deliberate, tracked deferral — see issue #691's own body for why expanding that set is a separate, coordinated, versioned change"), not just narrated in a design doc a future engineer has no in-context reason to go read. **Fix:** Layer 2 must add an equivalent inline code comment directly atop the `WRITE_BRIDGE_SIGNED_ACTOR_FIELDS` declaration in `writeActionRoutes.js`, referencing this design doc's round-6/round-7 finding by number, so an engineer editing the array months from now sees the coordination requirement in context — not only by already knowing to go read this doc's revision history.

This has zero compatibility risk for `link`/`verify`/`unlink`/`steam-link`/`broadcast` — none of them are touched — and zero rollout-ordering risk for the write bridge itself, since it and its signing contract ship together as one new feature. Domain separation between the two field sets is already sound without any further change: `canonicalActorSignaturePayload()`'s signed message already includes the server-resolved, never-attacker-controlled `route` string, so a signature computed for `write/preview`'s route can never be reinterpreted as valid for `link`'s or any other route's — no additional domain-separator prefix is needed.

`write/execute` first validates `Number.isSafeInteger(roleSnapshotAt) && roleSnapshotAt > 0` — rejecting immediately on failure — **added after round-5 audit (was MEDIUM, batch #762, DBA hat): a prior revision of this enforcement stated only the comparison, omitting this upstream validation step despite claiming to "match `verifyActorSignature()`'s own existing `timestamp` skew check exactly," which does validate first (`Number.isSafeInteger(timestamp) && timestamp > 0`, `actorSignature.js`). Without it, a malformed value (`NaN`, a string, `undefined`) produces `Math.abs(now - NaN) === NaN`, and `NaN > maxRoleAgeSeconds` is always `false` in JavaScript — silently PASSING the freshness check instead of rejecting, neutralizing the entire #734/#744/#749/#754 fix chain with no attacker involvement, just a bot-side bug.** Only once that validation passes does `write/execute` enforce `Math.abs(now - roleSnapshotAt) > maxRoleAgeSeconds → reject` (bounded in *both* directions, matching `verifyActorSignature()`'s own existing `timestamp` skew check exactly — a prior revision of this enforcement formula only bounded staleness, not a future-dated value, found separately as #754) before consulting `actor.roleIds` for anything. This doesn't prove the bot genuinely re-queried Discord, but it closes the specific, concrete bug this fix targets — an accidental replay of the original interaction's cached payload — and gives Core an actual enforceable invariant instead of a doc-only promise, consistent with how every other trust boundary in this design is treated.

**Nonce store**: an in-memory `Map<nonce, { actorUserId, action, params, expiresAt }>`, single-use (deleted on first consumption), 60s TTL. A server restart mid-confirmation simply expires the pending nonce — nothing has mutated yet, so losing it is safe; the user just retries.

**Extended for `server.stop`'s dual-confirmation gate, added after an isolated four-hat review of the round-7 `stop` redesign (Security, Architect, UI/UX, QA — see Group C's Safety note below for the full finding list this replaces, filed as issues #792-799):** the round-7 redesign's "independent second `write/preview`→`write/execute` cycle" tied to a brand-new, unspecified "pending stop request" record was found structurally broken — no field anywhere carried the correlation ID, idempotency-key semantics for the two cycles were unspecified with a plausible silent-fail-closed path, the enforcement layer ("Core's `stop` handler") was ambiguous enough to risk modifying the real, shared `/api/server/stop` route the web console also calls, and the real bot-side button-click code enforces the opposite (same-user-only) authorization rule the second confirmer needs. **Redesigned to reuse this existing nonce store instead of inventing a new record type:** when `write/execute` is called for `action: "server.stop"` and the write-bridge (never the real `server.js` route — see below) determines a second confirmation is required, the nonce entry gains two additional fields, `secondConfirmationRequired: boolean` and `primaryConfirmedAt: number | null`, and is **not deleted** on this first call — instead of invoking the real loopback, `write/execute` returns a new, explicit response shape `{ ok: true, pending: true, awaitingSecondConfirmation: true }` (distinct from the normal `{ ok: true, result: {...} }`, so the primary's own client can never mistake a pending confirmation for a completed one — closing the round-7 redesign's unaddressed response-contract gap), and extends this specific nonce's TTL to 5 minutes from `primaryConfirmedAt` (a stated, bounded, per-action exception to the store's general 60s TTL, not a silent inconsistency). **The discriminator between the primary's call and a second confirmer's call, stated explicitly (added after a quick post-redesign check, Architect hat): `primaryConfirmedAt == null` means this is the primary's first call (mark pending, do not execute); `primaryConfirmedAt` already set means this is a candidate second confirmation (verify actor difference + freshness, then execute). Corrected after the final confirmatory round (was HIGH #809, Architect hat): the first branch must ALSO verify `actor.userId === nonce.actorUserId` before marking `primaryConfirmedAt` — Section 1's own stated rule is that every nonce binds to a single actor's identity, with the second-confirmer's *consuming* call as the one, explicitly named exception; a prior revision of this discriminator left the first branch's identity check unstated, which — read literally — would accept any actor's call as "the primary's first call" regardless of whether they actually hold the nonce, not just the one exception this document itself declares.** A second `write/execute` call presenting the **same nonce**, from a different actor (verified via that actor's own fresh `verifyActorSignature()` + `requireDiscordCapability()` + `roleSnapshotAt` check — full rigor, not inherited from the primary), whose `actorUserId` differs from the nonce's original `actorUserId`, arriving within 5 minutes of `primaryConfirmedAt`, is what actually triggers the real loopback call and consumes the nonce. **This lookup-verify-consume sequence must be synchronous/atomic and complete *before* the loopback call is issued, not deleted in a `finally` after the loopback resolves (added after the same quick check, Architect hat, MEDIUM) — two distinct eligible admins clicking the second embed within milliseconds of each other each carry their own fresh idempotency key (per-attempt, not shared), so the idempotency-cache's per-key lock does NOT serialize between them; only the nonce's own atomic consume-then-execute ordering prevents both from reaching the real loopback. Corrected after the final confirmatory round (was HIGH #810, DBA hat): "must be synchronous/atomic" names the outcome but not the mechanism, and was unpinned against future change.** Verified against real code: `verifyActorSignature()` and both `requireDiscordCapability()` implementations are plain synchronous functions today (no `async`, no I/O) — this sequence is genuinely atomic simply because there is no `await` between the nonce lookup and the Map mutation that marks it consumed, relying on Node's single-threaded run-to-completion semantics, not any explicit lock. **This is fragile, not permanent**: if either verification function is ever made `async` (e.g., a future live policy-store lookup) without this constraint being visible in context, the sequence silently regains an await point and two concurrent second-confirmer calls could both pass verification before either marks the nonce consumed. **Fix:** Layer 2 must add an inline code comment directly atop this lookup-verify-consume block stating it must contain zero `await` between the nonce lookup and the consumption write, referencing this design doc's finding by number — mirroring the same enforcement discipline this document already requires for `WRITE_BRIDGE_SIGNED_ACTOR_FIELDS`'s own future-change comment. The nonce itself *is* the correlation mechanism — no new ID, no new store, no ambiguity about which pending request a confirmation resolves, since a nonce is already single-use and already looked up by its own value. **A primary's own raw retry against the same nonce (a client-level retry, not a second-embed click) is rejected by the same actor-difference check** — same `actorUserId` as the nonce's original, so it can never itself satisfy the second-confirmer branch; the response contract for this specific case is the same `503`/re-returned-`{pending: true}` behavior every other retried-but-not-yet-resolved write/execute call already gets, not a new error path.

**Idempotency cache — corrected after round-2 audit (was HIGH #736, DBA hat): must be persisted, not in-memory.** A prior revision justified an in-memory-only idempotency cache by citing `restartQueue`'s "in-memory entries" as precedent — **this citation was factually wrong**: `services/restartQueue.js`'s `readState`/`writeState` persist to disk (mode `0o600`) precisely because that state must survive a restart. The real precedent in this codebase for state that must survive a restart is to persist it, not accept its loss. Losing the idempotency cache mid-flight is a real gap: if Core restarts between a `write/execute` call that already performed a non-idempotent mutation (give-item, grant-all, carepackage grant, guild add/remove all qualify) and a bot-side retry using the same idempotency key, the post-restart cache is empty and the retry silently double-executes.

**Corrected further after round-3 audit (was MEDIUM #746, DBA hat): `restartQueue.js`'s own convention is the weaker of two available precedents, and lacks concurrency control entirely.** `restartQueue.js`'s local `writeJson` is a plain `writeFileSync` (no temp-file + rename, not atomic), and its readers silently swallow any parse failure and return an empty state with no logging — acceptable for losing an in-flight restart countdown, not acceptable for silently reopening the exact double-execution gap this fix exists to close. Worse, `restartQueue.js`'s read-modify-write pattern (`readState` → mutate in memory → `writeState`) has no lock or compare-and-swap — tolerable for restart-queue entries (rare, effectively human-serialized) but not safe for the idempotency cache, whose entire purpose is protecting against near-simultaneous duplicate requests bearing the same key (Section 4's own stated threat model: "network retries or impatient users"). Two requests with the identical key arriving close together could both read a cache-miss before either writes back, both executing the non-idempotent mutation — the exact outcome this fix was meant to prevent, just via a race instead of a restart.

**Fixed:** the idempotency cache is persisted to `runtime/generated/discord-write-idempotency.json` using `jsonStore.js`'s `writeJsonAtomicAsync` (temp-file + fsync + atomic rename, explicitly documented in this codebase for "security-sensitive stores," and already the pattern `auth/secondFactorStore.js` uses for a structurally identical problem — small, security-relevant, per-key JSON state that must survive a crash without silent loss — corrected after round-4 audit, batch #755: a prior revision cited `services/playerBans.js` as this precedent, but `playerBans.js` actually uses the *synchronous* `writeJsonAtomic`, not the async variant; `secondFactorStore.js` is the real match).

**Corrected after round-4 audit (was HIGH #752, Security hat): the serialization must be scoped per idempotency key, never a single global queue.** A prior revision of this fix serialized *all* reads/writes through one in-process queue — meaning any single slow real endpoint call (a hung `server.restart`, a stalled map spawn) would stall the entire RW pipeline for every actor and every action, a new, unbounded DoS vector materially worse than the narrow race it was meant to fix. **Fixed:** a `Map<idempotencyKey, Promise>` — only requests sharing the *same* key wait on each other; unrelated keys never block one another. A same-key request arriving while an earlier one with the same key is still in flight awaits that first request's result rather than racing it. Each queued operation has a bounded timeout (matching the existing 60s nonce/confirmation window is a reasonable default); a request that doesn't resolve within it returns `503` rather than hanging indefinitely, so a single degraded-disk or hung-mutation event can't turn into an unbounded pile of stuck requests even for that one key.

**Corrected after round-5 audit (was HIGH #758, found independently by 4 hats — DBA, Security, Architect, QA): the `Map<idempotencyKey, Promise>` must delete each entry once its Promise settles.** A prior revision of this fix never stated this — since idempotency keys are fresh UUIDs generated per write attempt (Section 4), the Map would otherwise accumulate one entry per every RW action ever performed for the life of the process, a guaranteed unbounded-growth DoS under ordinary legitimate usage, not just an attack scenario. **Fixed:** the Map entry is removed in a `finally` block immediately after its Promise settles (success, failure, or timeout) — the settled *result* doesn't need to stay in this in-memory Map once the persisted idempotency-cache file has recorded it; only the in-flight coordination needs to exist. Map size at any moment is bounded by the number of currently in-flight requests, never cumulative history.

**Corrected after round-6 audit (was HIGH #769, DBA hat): the `finally` block must be attached to the real mutation attempt's own settlement, never to the bounded-timeout wrapper around it.** A prior revision's wording didn't distinguish "the client observing this key gave up waiting (bounded timeout → 503)" from "the underlying mutation attempt itself has finished" — these are not the same event. If wired the idiomatic-but-wrong way (`try { return await Promise.race([fn(), timeout(60000)]) } finally { inFlight.delete(key) }`), the `finally` fires when the *race* settles at the 60s timeout, not when `fn()` (the real loopback call + mutation) itself finishes — `fn()` keeps running in the background with its result discarded, the Map entry is gone, and the persisted cache file hasn't been written yet either (that only happens once `fn()` completes). A retry with the same key arriving in this window finds no in-flight entry and no persisted record, and **re-executes the mutation** — reopening exactly the double-execution risk #736/#746/#752/#758 exist to prevent, for any real endpoint slower than the bounded timeout. **Fix:** the Map entry's `finally`-based deletion must be attached directly to `fn()`'s own promise, not to a `Promise.race` wrapper around it. A timed-out *observer* stops waiting and returns `503` to its caller, but the Map entry — and thus the in-flight coordination guarantee — must persist until the real underlying mutation attempt actually settles, one way or another, independent of how many callers gave up waiting on it.

**Corrected after round-7 audit (was CRITICAL #778, DBA hat): this fix and the #770 fix below (persisted-cache write routed through `runExclusive()`) have an unstated ordering dependency, and neither plausible resolution of it was safe as previously written.** `fn()` must do two things before it can be considered "settled" for the purposes of this Map's cleanup: perform the real mutation, AND persist the result to the idempotency-cache file. The fix above never states whether the persisted write happens *inside* `fn()`, before its promise resolves, or as a separate, unawaited step after. Both readings are broken on their own: if the persisted write is NOT awaited inside `fn()`, the Map entry can be deleted (mutation succeeded, `fn()` "settled") while the actual cache-file write is still queued behind `runExclusive()` — a retry in that window finds neither the Map entry nor a persisted record and **re-executes the mutation**, reopening exactly the risk this section exists to prevent. If the persisted write IS correctly awaited inside `fn()`, then `fn()`'s settlement — and every downstream consumer of it, including the client-facing bounded-timeout race above — is now gated on the `runExclusive()` queue's own lock-hold time, which (see the #770 fix below) was itself unbounded until round 7. **Fix, both halves now mandatory together:** (1) `fn()` must `await` the `runExclusive()`-queued persisted-cache write before its own promise resolves or rejects — this is the only ordering that doesn't reopen double-execution; (2) because of (1), the `runExclusive()` queue's lock-hold time must be bounded (see the #770 fix below, now updated) — an unbounded queue would otherwise let one stalled write delay every actor's `fn()` settlement, and thus every actor's Map cleanup and client response, indefinitely.

**Corrected after round-4 audit (was MEDIUM, batch #755, DBA hat), citation corrected after round-5 audit (was HIGH #759, DBA hat — the third citation-accuracy failure this document has had, worth a future implementer's extra caution when reusing any precedent this doc cites): an unreadable/corrupt cache file must fail closed, not fail open to empty.** A prior revision claimed `secondFactorStore.js`'s own corruption handling ("log a warning, then proceed as if the store were empty") was the *contrasting* precedent this fix deliberately diverges from — this was backwards. The real `secondFactorStore.js` **fails closed** on corruption: its own class doc comment states "callers on the auth path MUST treat this as 'cannot verify the second factor' → deny, NEVER as 'no second factor configured' → allow," and `loadRaw()` throws `SecondFactorCorruptError` on any unreadable/invalid/malformed state, never silently proceeding as empty. The "log and proceed as empty" behavior a prior revision described belongs to a different, explicitly-advisory function in that same file (`loadWatermarkEpoch()`, a non-authoritative side channel), not the main store — conflated in error. This is consistent with, not different from, the fix below: "empty" for the idempotency cache specifically means "no evidence this action already executed," which is precisely the condition that lets a retried `write/execute` silently re-run a non-idempotent mutation, so failing closed here follows the same real precedent `secondFactorStore.js` already establishes for security-sensitive state, not a deliberate departure from it. **Fixed:** if the idempotency-cache file exists but fails to parse, `write/execute` rejects the in-flight request with a `503`-class error ("idempotency store unavailable, cannot safely verify this hasn't already run") rather than silently treating the key space as empty, and logs at a severity that would actually surface to an operator monitoring the process, not just a debug-level warning. This also resolves round-5's DBA finding (batch #762) that the idempotency-corruption case deserves its own distinct error-table row rather than the generic `503` — see Section 4.

A retried `write/execute` with the same key and same params returns the cached result without re-invoking the loopback; same key with different params returns `409 "already executed"` per the existing error table. **Residual risk, stated explicitly:** a crash in the narrow window between the loopback mutation succeeding and the cache write reaching disk is still possible (this is inherent to any record-after-effect pattern without transactional coordination between two separate I/O operations) — accepted as a deliberate tradeoff, since it narrows the original bug's always-empty-after-restart window to a sub-second crash-timing window, not eliminated entirely. The nonce store stays in-memory (above); only the idempotency cache needs persistence, since only it protects against a real, already-executed mutation being silently repeated.

**Retention and redaction, stated explicitly (round-3 audit, Security hat Finding E):** persisting executed-action parameters and results (player names, ban reasons, item grants) to disk indefinitely, rather than erasing them on restart as the prior in-memory design did, is a small incremental information-disclosure surface (mirroring the already-accepted precedent that equivalent-sensitivity data already persists via the existing audit log). Consumed idempotency entries are pruned on the same periodic timer as expired ones (below), and cached `result` payloads pass through the same secret-redaction discipline (Requirement 24) as audit-log writes before being persisted — not stored raw.

**Eviction policy, stated explicitly (round-2 audit, DBA/Security LOW #740):** both stores are actively pruned on a periodic timer (not just checked lazily on lookup), with a max-entry-per-actor bound as a belt-and-braces cap against unbounded growth from a misbehaving moderator+-tier actor flooding `write/preview` (which is cheap to call repeatedly since it doesn't mutate anything).

**Corrected after round-6 audit (was HIGH #770, DBA hat): the persisted idempotency cache's pruning sweep and `write/execute`'s own cache write are two unsynchronized read-modify-write operations against the same file.** The persisted cache is a single JSON file, written via `writeJsonAtomicAsync` — an atomic *file replace*, not a locked read-modify-write. `write/execute` must read the file (check for a cached result), then write it (record the new execution); the periodic pruning sweep independently does the same (read, drop expired entries, write back) against the identical file, with no described coordination between the two. Concrete failure: `write/execute` reads state A, performs the real mutation, and is about to persist state A+entry; concurrently the pruning timer reads the same state A, prunes expired entries, and writes back state A-minus-expired; if the pruning write lands *after* `write/execute`'s write, the just-recorded entry for the mutation that actually ran is silently overwritten and lost — a retry with the same key then finds no record and **re-executes the mutation**. This is the same class of bug round 3's #746 already caught once in `restartQueue.js`'s own read-modify-write pattern, recurring here between two *different* code paths the round-4/5 per-key `Map` fix doesn't cover at all (the pruning sweep isn't keyed to any specific idempotency key), and the trigger window recurs on every pruning-timer tick, not just a rare simultaneous-request coincidence. **Fix:** route both the pruning sweep's writes and `write/execute`'s cache write through the same serialization discipline `secondFactorStore.js` already establishes for exactly this hazard class — `runExclusive()`, a single Promise-chain queue every reader/writer of the file goes through — rather than two independent unsynchronized read-modify-write sequences.

**Corrected after round-7 audit (was HIGH #781, DBA + Architect hats, independently corroborated): the `runExclusive()` queue above has no stated timeout, reproducing round-4's already-rejected #752 (a single unbounded queue is a DoS vector) at the cache-persist layer instead of the mutation layer.** `runtime/generated/`'s own precedent elsewhere in this document (the #772 liveness-probe fix, above) already establishes that this directory can be bind-mounted onto network-backed storage or run under I/O pressure, making `writeJsonAtomicAsync`'s underlying `fs/promises` calls genuinely stall with zero timeout protection of their own. Because #778's fix (above) now requires `fn()` to await this queue before settling, an unbounded stall here delays every concurrent actor's mutation confirmation, not just the one whose write is slow — the same DoS class the sibling per-key `Map`'s own 60s bound was built to prevent, left unguarded here. **Fix:** each `runExclusive()`-queued operation (a pruning-sweep tick, or one `write/execute`'s cache-persist call) must carry its own bounded timeout, matching the per-key `Map`'s existing 60s default. On timeout, the queued operation is abandoned (its caller's own outer bounded-timeout race, per the #769 fix above, already handles returning `503` to the client) and the queue proceeds to the next entry — a single stalled write must never block the queue indefinitely. Layer 2 must also bound the pruning sweep's own per-tick work (a stated max batch size, e.g. 500 entries per sweep tick, resuming from where the previous tick left off rather than restarting the whole file each time), since it iterates the entire cache file and its own worst-case duration scales with total cache size, not a single key.

**Corrected after the final confirmatory round (was CRITICAL #808, DBA hat): "abandoned" was never defined precisely enough to be safe against the real, uncancellable I/O primitive this design already uses.** `jsonStore.js`'s `writeJsonAtomicAsync` has no `signal`/`AbortController` parameter anywhere in its real signature — a caller giving up on waiting for it (the "abandon" behavior above) does NOT stop the underlying `open`/`writeFile`/`sync`/`rename` sequence from continuing to run in the background. If the queue lets the *next* entry start (a different key's persist call, or the pruning sweep) while an earlier "abandoned" write is still silently completing, both can read-modify-write the same file concurrently — reopening the exact unsynchronized-concurrent-write hazard `runExclusive()` was invented to close in the first place, one layer down, at precisely the stalled-network-storage scenario this section's own fix already cites as the realistic trigger. A retry against the losing write's key then finds no record of its own already-real mutation and re-executes it. **Fix, made concrete:** the queue maintains a monotonically increasing generation counter, incremented each time an operation is abandoned on timeout. Every queued operation captures the current generation when it starts, and — immediately before its own final `rename()` step inside `writeJsonAtomicAsync` — checks whether the queue's generation counter has advanced past its own captured value; if so, it skips the rename entirely (its result is discarded, exactly as if it had been genuinely cancelled) rather than silently completing and clobbering whatever ran after it. This requires `writeJsonAtomicAsync` to accept an optional pre-rename generation-check callback — a small, additive change to an otherwise-unmodified function, not a rewrite. Layer 2 must add a test proving this: start a write, let it "time out" and get abandoned, let a second write for the same file complete normally, then let the first write's background I/O finally reach its rename step — assert the first write's rename is skipped and the second write's result survives on disk untouched.

**Corrected after round-7 audit (was HIGH #788, Security hat): it is not stated whether `write/preview` also reads this same persisted cache — if it does, this section's own "cheap to call repeatedly" justification for `write/preview`'s unrestricted call frequency (below, Eviction policy) no longer holds, since every preview call would then also contend for the bounded `runExclusive()` queue above.** **Fix:** `write/preview` must NOT read the persisted idempotency-cache file through `runExclusive()` — if a preview-time "already executed" hint is wanted, it must read the file directly and tolerate staleness (never authoritative, never queued), keeping preview calls genuinely cheap and off the bounded queue that `write/execute`'s authoritative check and the pruning sweep share.

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
- **None**: start, enable, disable, scan, warn, fill-water
- **Button click**: kick, unban, give-item, refill, restart-service, teleport, grant, broadcast, `guild add`, `guild remove`, `broadcast-shutdown`
- **Type confirmation string**: ban, server restart, server stop, spawn, despawn, respawn, clear-backpack, history clear, grant-all

**Corrected after round-6 audit (was HIGH #766 + MEDIUM batch #776, UI/UX hat): this list previously contradicted Group A's own table and omitted several real Yes-confirmation commands.** `warn` was listed under "Button click" here while Group A's table (line 167) correctly marks it "No (non-destructive)" — `warn` only sends a map-chat message via `POST /api/admin/map-chat`, genuinely non-destructive; moved to "None" to match Group A, the actual source of truth for per-command confirmation requirements. `base refill generators`/`base refill water` (Group B, both "Yes") were previously represented only by an ambiguous singular "refill" that matched neither subcommand's real name — that entry is now understood to mean both `base refill` subcommands specifically, not a different, unlisted `refill` command. `broadcast-shutdown` (Group F, "Yes") and `guild add`/`guild remove` (Group G, both "Yes") were missing from every list entirely; added to "Button click" (matching their peers' confirmation style — none of the three require a typed phrase per their own Group F/G table rows). Section 6's own test plan treats these three lists as the canonical cross-reference for a consistency check against every command table — this correction closes the gap that check would otherwise have silently passed around.

**Corrected by a mechanical cross-reference script, not a hat dispatch (2026-09-09, same session as round 6): `fill-water` (Group A, "No") was in fact ALSO missing from every list — the sentence directly above, written during round 6's own remediation, incorrectly asserted it was "correctly already absent."** A script parsing every Section 2 table row and diffing it against these three lists' actual membership caught this immediately; it had been missed by every hat dispatch through round 6, including the same UI/UX hat that specifically re-derived these three lists in the same round. Added to "None" above, alongside its true peers (`start`/`enable`/`disable`/`scan`, all similarly non-destructive with no confirmation at all). This script also caught that Group A's `ban` row and Group D's `spawn`/`despawn`/`respawn` rows state only "Yes (shows ...)" with no mention of the real, required typed confirmation phrase their own routes enforce (`"BAN PLAYER"`, `"SPAWN MAP"`, `"DESPAWN MAP"`, `"RESTART MAP"` — all independently verified against `server.js` back in round 2, and already correctly reflected in these three lists and in the paragraph below) — fixed in each of those rows directly, so a reader of Section 2 alone no longer needs to already know about the separate phrase-mapping paragraph below to learn these four commands require typed confirmation, not just a button click.

**Verification status of required phrases, stated explicitly (round-2 audit gap this correction pass caught in its own remediation, not a new finding filed separately). Corrected after round-6 audit (was HIGH #765, GRC + UI/UX hats, independently corroborated): this paragraph still cited `history-clear`'s phrase as unverified/wrong, three rounds after it was actually fixed and verified.** The Architect hat's round-2 audit directly verified the exact real phrases for `ban` (`"BAN PLAYER"`), `clean-inventory` (`"CLEAN INVENTORY"`), `spawn`/`despawn`/`respawn` (`"SPAWN MAP"`/`"DESPAWN MAP"`/`"RESTART MAP"`), and kick-all (`"KICK ALL ONLINE PLAYERS"`) — those are real, confirmed against `server.js`. **`history-clear`'s phrase was also independently verified, in round 3**: Section 3.5's `WRITE_ACTION_ROUTES` entry and the Group E table both correctly show `confirmPhrase: "CLEAR GRANT HISTORY"`, confirmed directly against `server.js:3570-3573` (see Section 3.5's own round-3 correction note) — this paragraph's prior wording ("carries forward... unverified against real code") had gone stale and was still repeating the pre-round-3 wrong value (`"CLEAR HISTORY"`) a third time, in a third location, after being fixed in the other two. `grant-all` remains the one genuinely open item: it still has no `confirmPhrase` entry in `WRITE_ACTION_ROUTES` despite appearing in this "type confirmation string" list. **Required Layer 2 task:** verify `grant-all`'s real server-side phrase requirement (if any) against `server.js` directly before implementation — `history-clear` needs no further verification, it's already done.

**Typed-confirmation UI mechanism, designed after the final confirmatory round (was HIGH #813, UI/UX hat): the "Type confirmation string" tier had no described mechanism anywhere for how a Discord user actually supplies the typed text.** Nothing in this document said whether this was a modal, a re-invoked command parameter, or a follow-up plain-text message — a real gap affecting a third of all commands, including the highest-severity ones (`ban`, `restart`, `stop`, `grant-all`). **Design: Discord's native Modal component**, opened when the user clicks the confirmation embed's Confirm button (not shown as a separate step — the button click itself triggers the modal, so the flow is still "one embed, one interaction" from the user's perspective, matching the button-click tier's own UX). The modal has a single short-text input field, labeled with the exact required phrase (e.g. "Type BAN PLAYER to confirm"), pre-filled with nothing (never pre-filled with the correct answer). On submit:
- If the typed text doesn't match the required phrase exactly (case-sensitive, no trimming beyond leading/trailing whitespace), the bot responds with an ephemeral "Confirmation text didn't match — click Confirm to try again" message and does **not** consume the nonce or the confirmation window's remaining time — the user can reopen the modal and retry until the window expires.
- If it matches, `write/execute` is called exactly as the button-click tier already does, with the typed phrase passed through in the request body (Section 3.5's existing "the write-bridge must inject the real, exact server-required confirmation phrase... into the loopback body" behavior is unaffected — the bot-side match above is purely a misclick safeguard, matching the existing, already-correct "not independently verified against the typed text server-side" framing).
- `server.restart`'s per-operator "type the server name" variant works identically, with the modal's label instructing the user to type the specific server's name (sourced from the same config `write/preview`'s response already returns for the preview embed) rather than a fixed literal.

The 60s confirmation window (or 30s for the primary half of the `stop` gate) continues running across a mismatched-and-retried attempt — a modal that stays open past the window's expiry submits into an already-expired nonce, which `write/execute` already correctly rejects per the existing nonce-TTL/expiry error path.

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
| 200 | "✅ Action completed" (higher-risk commands show command-specific result content instead of this generic string — see note below) | success |
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

**Higher-risk commands must not use the generic "✅ Action completed" success embed, added after the final confirmatory round (was part of #819 batch, UI/UX hat).** For `grant-all`, `despawn`, and `stop`, the bare generic string gives the invoking admin no way to confirm what actually happened without a separate audit-log lookup — for `grant-all` specifically (owner-tier, server-wide-injection risk per #219), an admin who fat-fingered a wrong item ID would see the identical success embed as a correct grant. These three commands' success embeds must instead surface command-specific result content already available in `write/execute`'s own response body: `grant-all` shows the eligible-player count actually granted; `despawn` shows what was despawned and a count; `stop` shows which confirmation path was taken (single-admin fallback vs. two-admin gate) and the final player count at shutdown. Every other command keeps the generic string — this is a targeted exception for the three commands whose blast radius most rewards a specific confirmation, not a redesign of the whole embed system.
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
| Internal credential: Unix domain socket + path-scoping | **DESIGNED** (Section 3.4/3.2 — round-2's TCP-source-IP approach replaced with a Unix socket after round-3 found it broken in both directions; round-4/5 added ADMIN_ALLOWED_IPS scoping, root-UID refusal, restart-safety, split-brain protection, TOCTOU-safe chmod; round-6's `ADMIN_ALLOWED_IPS` fix found not to reach the real gate, corrected round-7 via `resolveWriteBridgePrincipal()` called inline from `requestHandler`; round-7 also fixed the split-brain liveness probe's timeout handler, which never settled its own Promise) — not built | #728, #742, #750, #751, #753, #756, #757, #763, #772, #779, #780 |
| `WRITE_ACTION_ROUTES` mapping table + startup self-check against `actions.js` | **DESIGNED** — handler-identity verification layer designed (a new `auditAction` field per entry, checked mechanically pre-merge, plus the existing Layer 2 integration-test requirement pre-release closes #731 without an unsafe runtime-at-boot mechanism) — not built | #216, #731 |
| Route table correctness (ban/unban, give-item, guild.remove, history-clear phrase) | **FIXED IN DESIGN** (round-2 found ban/unban + give-item; round-3 found guild.remove + history-clear's phrase) | #730, #743, #747 |
| `guild:create` / `guild:rename` / `base:destroy` / `server:maintenance` | **DEFERRED** (Section 7) — no Core endpoint, out of scope this round | #216 |
| `GET /api/items` catalog endpoint (autocomplete) | **DESIGNED** (Section 3.6, corrected — the #218 allowlist-reuse claim was false; match semantics corrected to substring, reusing `listCatalogItems()`, not a new prefix-only index) — not built. **This row's own "no test coverage yet designed" claim was itself stale — Section 6 already had two bullets for this endpoint since round 4 (batch #755), never reconciled back here; a third bullet closing the match-semantics ambiguity has now been added.** | #222, #736, #745 |
| Server restart/stop confirmation phrases | **GENUINELY STILL OPEN** — a prior revision incorrectly claimed this was already reflected; verified both routes have zero server-side enforcement today | #223, #732 |
| `player:give-item` item-type allowlist/caps | **GENUINELY STILL OPEN** — #218's mitigations don't exist anywhere in this codebase; a prior revision incorrectly implied otherwise | #218 |
| Per-actor rate-limit isolation through the loopback | **FIXED IN DESIGN** (Section 3.8 — synthesized session now carries a stable `id`) | #733 |
| Idempotency cache persistence | **DESIGNED** (Section 3.8 — persisted via `jsonStore.js`'s atomic writer + a per-key `Map<idempotencyKey, Promise>` lock with settled-entry cleanup tied to the real mutation's own settlement, which must itself await the bounded, timeout-protected `runExclusive()`-serialized persisted write before resolving (round-7 fix for the ordering dependency between the two), plus that same bounded serialization between the persisted cache's own writes and its periodic pruning sweep — `write/preview` deliberately exempted from this lock. History: round-4 found round-3's `restartQueue.js`-convention fix had a race, round-5 found round-4's own global-queue fix was itself a new DoS vector, round-6 found the per-key fix's own Map had no cleanup then that the cleanup fix could delete a still-in-flight entry and the pruning sweep was unsynchronized with `write/execute`'s own write, round-7 found the two round-6 fixes had an unstated ordering dependency and the resulting shared lock was unbounded — not built | #736, #746, #752, #758, #769, #770, #778, #781, #788 |
| Actor-role freshness enforcement | **DESIGNED** (Section 3.8 — a new signed `roleSnapshotAt` field on its own independent `WRITE_BRIDGE_SIGNED_ACTOR_FIELDS` set, after round-3 found round-2's fix was a bot-side-only promise, round-4 found the first attempt broke the shared cross-repo signing array, and round-5 added the missing numeric-range validation) — not built | #734, #744, #749, #754 |
| `discordWritesEnabled` standardization | **Core needs no change** (verified: already accepts both `"1"`/`"true"` since an upstream merge that predates this doc) — bot-side status needs re-verification | #217 |
| Section 6 test-plan coverage for all new mechanisms | **REWRITTEN and extended each round** — still has minor gaps as of round 5 (batch #762) | #735, #745, #762 |
| Actor signing on all write adapter routes | **EXISTS** | #207 (verified) |
| Interaction with console `policy.js`'s own IAM gate | **Documented after round-5 audit (was MEDIUM, batch #762, Architect hat), count corrected after round-6 audit (was HIGH #771, DBA hat — the original count relied on the wrong IAM Action citation for `grant-all`, now fixed in Group E's table above):** the loopback's real target route also passes through the standard `evaluate(session, action)` check as a second, independently-maintained layer — verified today's real `DEFAULT_POLICIES` for `admin` tier already deny **3** of the 6 owner-tier-restricted actions Section 1 requires (`server:restart`, `carepackage:grant-all`, `carepackage:clear-history` — a 4th Deny-list entry, `admin:history:clear`, is an unrelated route with no corresponding command in this doc and was miscounted in the original round-5 pass), consistent with (not conflicting with) `WRITE_ACTION_MIN_TIER`. No live conflict, but the two tables aren't tied together — a Layer 2 test should assert `WRITE_ACTION_MIN_TIER`'s per-action minimum always stays ≥ what `policy.js` would independently require, so future drift between them is caught rather than silently accumulating, using the corrected `carepackage:grant-all` action for `grant-all` specifically, not the wrong `carepackage:grant` value this table cited until this round. | #762, #771 |

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
- *(new, Core)* **Credential comparison:** assert `crypto.timingSafeEqual` is actually used, not `===`, for the internal token check; assert a length-mismatched token is rejected cleanly (no thrown `RangeError`) — **this test bullet added after round-5 audit, batch #762, for a guard that has required this behavior since round 4/#755 (Section 3.4); this bullet simply had no explicit corresponding test until now.** Corrected after round-6 audit (was LOW, batch #776, QA hat): a prior revision of this bullet's own wording said "the length-equality guard added after round-5 audit," directly contradicting Section 3.4's round-4/#755 attribution for the same guard — the guard itself is round-4; only its test coverage here is round-5.
- *(new, Core)* **`meetsMinTier()` (3.3a):** table-driven, every `WRITE_ACTION_ROUTES` key against every tier — assert it matches Section 1's tier ladder exactly; assert an action present in `WRITE_ACTION_ROUTES` with no `WRITE_ACTION_MIN_TIER` entry throws (fail closed) rather than defaulting open; assert a poisoned key (`"constructor"`, `"__proto__"`, `"toString"`) is rejected via `Object.hasOwn`, never resolved to an inherited value (#747).
- *(new, Core)* **`WRITE_ACTION_ROUTES` lookup safety:** `"constructor"`/`"__proto__"`/`"toString"` as `action` → rejected via `Object.hasOwn`, never resolves to an inherited value.
- *(new, Core)* **Route self-check (3.5), both branches:** a deliberately-mismatched entry → refuses to enable the RW subsystem (not a full-process crash — see 3.5's failure-scope correction) with a specific logged error; the current real table against the current real `actions.js` → passes clean. Re-run in CI so a future route rename is caught automatically.
- *(new, Core)* **`auditAction` handler-identity check (3.5), added after the final confirmatory round (was HIGH #816, QA hat), both branches, mirroring the route self-check above:** every `WRITE_ACTION_ROUTES` entry has a non-empty `auditAction` value (a table-driven completeness check, mirroring the existing `confirmPhrase` cross-consistency check — an entry with a missing value must fail this check, not silently pass); a deliberately-mismatched `auditAction` (e.g. `players.ban` declared where the real handler emits `players.unban`) is flagged by the mechanical script, not silently passed; the current real table against the current real `server.js` dispatch/handler-body fingerprints passes clean; an entry whose real handler exposes neither a direct-literal nor a method-branching-ternary fingerprint is explicitly flagged as unverifiable, never silently treated as passing.
- *(new, Core)* **Nonce store:** single-use consumption (a re-presented already-consumed nonce is rejected), 60s TTL expiry, correct `actorUserId`/`action`/`params` binding — **except `server.stop`'s dual-confirmation gate (see its own dedicated test bullet below), which deliberately allows consumption by a different `actorUserId` than the one that created the nonce; this generic bullet's binding assertion must not be written as a blanket rule that would incorrectly reject that case (added after a quick post-redesign check, Security hat, LOW).** Two distinct eligible admins concurrently confirming the same `server.stop` nonce must be proven, via a call-count/spy assertion, to result in exactly one loopback call — not just "eventually consistent," since the two calls carry different per-attempt idempotency keys and cannot rely on the idempotency cache to serialize them (added after the same check, Architect hat, MEDIUM — the nonce's own atomic consume-then-execute ordering is the only thing preventing a double-invocation here, and must complete before the loopback call is issued, not in a `finally` after it settles).
- *(new, Core)* **Idempotency cache module (persisted, 3.8):** same key + same params → cached result, no re-invocation of the loopback; same key + different params → `409`; **two concurrent requests with the identical key racing each other → the second waits for the first's result rather than both executing (regression test for the concurrency race #746 found) — achieved via a deliberately controlled synchronization point (stub/delay the underlying atomic-write step with an injected manual-resolve gate so both requests are provably in the cache-check window simultaneously before either completes), not a naive `Promise.all` that could pass trivially without ever proving real overlap (round-4 audit, QA hat, batch #755)**; two *different* keys, one artificially slowed, don't block each other (regression test for the global-queue DoS, #752); a queued operation exceeding its timeout returns `503` rather than hanging; a corrupt/unreadable cache file causes `write/execute` to fail closed with `503`, not silently proceed as if empty (#755); cache survives a process restart, where "restart" means re-instantiating the module in a *fresh process* (spawn/kill/respawn against the same on-disk file), not just re-calling the constructor in the same test process (#747). **Cleanup-ordering regression test, added after the final confirmatory round (was HIGH #817, QA hat) — proves the #769/#778 fix specifically, not just its symptoms:** using the same controlled-synchronization-point technique above, stub the persisted-write step with a long, controllable delay so the client-facing bounded-timeout race fires first (asserting the `503` the existing bullet above already covers) — then, WHILE the persisted write is still deliberately held open, issue a same-key retry and assert it still finds the original in-flight coordination entry and awaits/dedupes against it, rather than finding no record and re-invoking the real mutation. This is the one scenario that actually distinguishes the correct fix (cleanup tied to the real mutation's own settlement) from the "idiomatic-but-wrong" implementation (cleanup tied to the timeout race) — every other bullet in this list would pass against either implementation.
- *(new, Core)* **`policy.js`/`WRITE_ACTION_MIN_TIER` drift check, added after the final confirmatory round (was HIGH #818, QA hat) — the test Section 5's own status table already promised, never actually written until now:** for every `WRITE_ACTION_ROUTES` entry with a corresponding real `policy.js` IAM action, assert `WRITE_ACTION_MIN_TIER`'s declared minimum tier is always >= what `policy.js`'s `DEFAULT_POLICIES` would independently require for that same action — a future edit that silently loosens one table without the other is caught here, not left to silently accumulate as a defense-in-depth gap between the two independently-maintained tier gates.
- *(new, Core)* **Eviction/pruning (3.8):** expired-but-unconsumed nonce/idempotency entries are actually removed by the periodic sweep, not just excluded from lookups; a single actor exceeding the per-actor entry bound is capped (#747). **A `server.stop` nonce awaiting its second confirmation (`primaryConfirmedAt` set, within its 5-minute window) is treated as a live entry by the sweep, never reaped early as if it were merely a stale, unconsumed nonce — added after a quick post-redesign check, Security hat.** **Sweep-vs-write concurrency, added after round-7 audit (was HIGH #784, QA hat):** the pruning sweep and a `write/execute` cache-persist call running concurrently against the same file must not lose either operation's data and must not deadlock — exercise both running simultaneously (not sequentially) via the same controlled-synchronization-point pattern used above for the idempotency-cache race test, and assert each `runExclusive()`-queued operation's bounded timeout (added after round-7 audit, #781) is actually enforced, not just documented.
- *(new, Core)* **`write/preview` never contends for the persisted-cache lock, added after round-7 audit (was HIGH #788, Security hat):** a burst of `write/preview` calls (from one or many moderator-tier actors) running concurrently with a real `write/execute` cache-persist call must not measurably delay the `write/execute` call — proving `write/preview` doesn't read the persisted cache through the same bounded `runExclusive()` queue `write/execute` and the pruning sweep share.
- *(new, Core)* **`resolveWriteBridgePrincipal()` unit contract, added after round-7 audit (was HIGH #783, QA hat):** call the function directly (not through `requestHandler`/`handleApi`) across all four combinations of correct/wrong token × correct/wrong path, asserting its raw return value (principal object vs. `null`); separately assert that `handleApi`/`auth.requireAuth`, given a pre-resolved principal via `opts`, do not independently re-invoke the token comparison (a call-count/spy assertion on the underlying comparison function). **Extended after the final confirmatory round (was part of #819, batch, QA hat): the match this function performs is token + method+path-scoped, not token + path-scoped alone — `WRITE_ACTION_ROUTES` entries key on method+path pairs (Section 3.5), so two different actions can share a path and differ only by HTTP method.** The four-combination matrix above (correct/wrong token × correct/wrong path) is restated as an eight-case matrix, adding a third axis (correct/wrong method): a correct token against a real path but the wrong method for that path's `WRITE_ACTION_ROUTES` entry must return `null`, exactly like a wrong path — a test suite exercising only the original two axes cannot catch a method-scoping regression at all.
- *(new, Core)* **`stop` dual-confirmation gate, redesigned after an isolated four-hat review found round 7's version structurally broken (#792-799) — third time this test-plan commitment has been made, verify it actually lands:** single-admin fallback correctly waives the gate when exactly one eligible admin/owner exists, and the primary's preview embed notes it; the gate correctly activates when 2+ exist, **and the primary's own confirming call is proven (via a call-count/spy assertion on the loopback client, not just an observed Discord-side outcome) to never invoke the real loopback** — returning `{ pending: true, awaitingSecondConfirmation: true }` instead; a `stop` request where the same user attempts both confirmations is rejected by the second embed's distinct button handler, not the primary's own same-user-only handler; a `stop` request with two distinct eligible admins succeeds, with the second confirmer's own `verifyActorSignature()`/`requireDiscordCapability()`/fresh-`roleSnapshotAt` checks independently exercised; **the second confirmer's `write/execute` call is proven scoped to the exact same nonce as the primary's** (construct a scenario with two simultaneous, unrelated pending `server.stop` nonces for the same guild and confirm a second-confirmer click only resolves its own); a `stop` request where the second confirmation never arrives cancels cleanly within the nonce's 5-minute extended TTL; **a second confirmer's click arriving just before vs. just after the 5-minute boundary is correctly accepted/rejected** (assert both sides of the boundary explicitly, not just "eventually cancels"); the second embed's content (player count, reason), footer residual-risk note, and visual distinction from the primary embed; **the second embed is genuinely channel-visible, not ephemeral, and confirmable by an admin who was never the primary's own interaction target;** the primary admin's own client, on receiving `{ pending: true }`, renders an explicit "waiting for a second admin" state, never a bare success or a blank response; the eligible-admin count used for the single-admin-fallback decision is scoped to the specific guild the `stop` command was issued in, not global across every guild the bot manages. **Added after the final confirmatory round:** a first-call attempt from an actor who is NOT the nonce's own `actorUserId` is rejected, not accepted as "the primary's first call" (HIGH #809); the lookup-verify-consume block contains zero `await` statements between the nonce lookup and the consumption write (HIGH #810, a static/lint-level check, not just a runtime behavioral test); both a successful second confirmation and a 5-minute cancellation result in the primary's own original message/interaction being updated with the real outcome, not left on a stale "waiting" state (HIGH #815).
- *(new, Core)* **Audit attribution:** a loopback-executed action produces an audit-log entry correctly identifying the real Discord actor (`discordUserId`), never the bridge's internal credential and never blank.
- *(new, Core)* **Credential non-leakage:** the internal token never appears in any `audit()` payload, error response body, logged output, or the persisted idempotency-cache file (Requirement 24, extended after round-3 to cover the new on-disk cache, #747) — a capture-based assertion against real logged/persisted output during a simulated loopback call.
- *(new, Core)* **Rate-limit per-actor isolation (3.8, #733):** two different Discord actors performing the same action in the same window are NOT throttled by each other's activity (regression test for the shared-bucket bug this round's audit found).
- *(new, Core)* **Item catalog endpoint (3.6, #745):** `requireDiscordCapability(moderator)` gates the route and console `policy.js` is never consulted; **both directions of the tier boundary explicitly asserted (round-4 audit, QA hat, batch #755) — `public`/`observer` rejected, `moderator`/`admin`/`owner` accepted, not just the design fact restated**; substring-match/25-result-cap/case-insensitivity behavior (corrected from "prefix-match" during Layer-1 gap-closure work, matching 3.6's corrected match-semantics design above); **a catalog file change on disk IS reflected on the very next `GET /api/items` call, with no Core restart required (corrected after the final confirmatory round, was HIGH #811 — this bullet previously asserted the opposite, matching a since-superseded design)**; the endpoint's result set correctly reflects a match against `id`, `name`, AND `category` fields, not names alone (HIGH #814).
- *(new, Core)* **Item catalog match semantics, added during Layer-1 gap-closure work (was MEDIUM-HIGH, QA hat) — resolves the prefix-vs-substring ambiguity with a discriminating test, not just "some query returns some rows":** assert `q: "administ"` matches an item named "Administrator's Badge" (a prefix hit, which any implementation should return) **and also matches** an item named "The Grand Administrator" (a substring-only hit — this is the one case that actually distinguishes substring matching from prefix-only matching, proving the endpoint reuses `listCatalogItems()`'s real substring behavior rather than a silently-reintroduced prefix-only implementation). Also assert empty/missing `q` returns the first 25 catalog rows in a stable order, not an empty array.

### Layer 2: Integration Tests
- Full lifecycle: slash command → preview nonce → confirmation → execute → result embed
- Nonce expiry (60s timeout) → bot shows "expired" embed (`410`, per Section 4's corrected error table)
- Idempotency replay (same key, same params) → bot shows cached result
- Idempotency collision (same key, different params) → bot shows "already executed"
- All error codes from the corrected error table (Section 4), including the new `410` and the split kill-switch-vs-permission `403` rows
- *(new, Core)* **Per-route-table-entry correctness (resolves the self-check's documented blind spot, #731; relabeled from Layer 1 to Layer 2 after round-3 audit, since it genuinely runs against a real test Core instance, #747):** one integration test per `WRITE_ACTION_ROUTES` entry, asserting the *actual* expected effect by independently querying/observing state the loopback call itself doesn't control (a real DB row, a mock game-server call log) — never by re-checking the response body the same code path just returned, which would recreate a shallow tautology (#747). Concrete worked examples: `player.ban` really bans, not unbans; `player.give-item` really targets the player's inventory, not a storage container; `guild.remove` actually removes the named member, not a 404.
- *(new, Core)* **Tier-floor negative test (Section 0's invariant):** table-driven across every `WRITE_ACTION_ROUTES` entry, assert `requireDiscordCapability()` rejects `public`/`observer`-tier actors before a nonce is ever issued.
- *(new, Core)* **Confirmation-phrase pass-through:** every entry with a `confirmPhrase` (3.5) — the loopback body carries the exact required phrase; a mismatched/missing phrase → the real endpoint's `400`, not a false success. **Cross-consistency check (added after round-3, QA #747):** every action listed under Section 4's "Type confirmation string" tier has a non-empty `confirmPhrase` in `WRITE_ACTION_ROUTES` — a table-driven check between the two lists, not just a per-entry pass-through test, so a destructive action (e.g. `grant-all`) can't ship without its documented phrase gate unnoticed.
- *(new, Core)* **Stale-role rejection (#734) and freshness enforcement (#744/#749/#754):** an actor whose role is revoked between `write/preview` and `write/execute` is rejected; test table for `roleSnapshotAt` (round-4/5 audit, QA + DBA hats, batch #755/#754/#762 — a prior revision only stated the negative case, an inverted-tautology risk, and omitted a malformed-value case entirely): a fresh `roleSnapshotAt` is **accepted**; a stale one (`Math.abs(now - roleSnapshotAt) > maxRoleAgeSeconds`) is **rejected**; a **future-dated** `roleSnapshotAt` is also rejected (not just old ones); the boundary at exactly `maxRoleAgeSeconds` is explicitly pinned to one behavior; a **malformed value** (`NaN`, a string, `undefined`) is rejected by the upstream `Number.isSafeInteger` guard, not silently accepted via a `NaN` comparison always evaluating false; **extended after round-6 audit (was LOW, batch #776, QA hat): also `0` and a negative integer** — both pass `Number.isSafeInteger` but must fail the separate `roleSnapshotAt > 0` bound, a distinct condition from the safe-integer guard that the malformed-value case alone doesn't exercise. Also confirm `write/preview`/`write/execute` verify this field via `WRITE_BRIDGE_SIGNED_ACTOR_FIELDS` (3.8), and that an old-format actor payload lacking `roleSnapshotAt` entirely still verifies correctly against **all five** routes the shared array serves — `link`, `verify`, `unlink`, `steam-link`, `broadcast` (round-5 audit, QA hat — a prior revision's regression test named only 2-3 of these; the shared `SIGNED_ACTOR_FIELDS` array must remain untouched for every one of them, not just a sample). **Tamper test, added after round-6 audit (was HIGH #775, QA hat): "verify this field" alone doesn't prove `roleSnapshotAt` is actually cryptographically covered by the signature, only that verification "happens."** Add an explicit test: sign a valid write-bridge envelope, mutate `roleSnapshotAt` in the body afterward *without* re-signing, and assert `verifyActorSignature()` rejects it — proving the field is bound inside the signed message, not merely present in the request body alongside an unrelated, still-valid signature. Without this, a canonical-payload implementation bug that silently drops the `fields` override (the exact shortcut #749's own history warns about) could pass every other test in this table while leaving `roleSnapshotAt` completely unauthenticated.
- *(new, Core)* **Kill-switch dual-checkpoint (#747):** `discordWritesEnabled()` is independently checked and rejects at both `write/preview` and `write/execute` — specifically, a switch flipped off *after* a valid preview/nonce but *before* the confirm-click reaches `write/execute` is still rejected, with the dedicated kill-switch error message, not the generic permission-denial one.
- *(new, Core)* **Broadcast exception path (Group F):** confirm `broadcast.*` never reaches the loopback/`WRITE_ACTION_ROUTES` machinery at all — it stays on its existing, separate `broadcastProvider()` path.

### Layer 3: End-to-End
- Real Core HTTP mock server with nonce store (extend `scripts/mock-adapter.js`)
- Bot-side Discord interaction mocks with button state machine
- Concurrency test: two simultaneous write commands serialize correctly
- *(new, Core)* **Loopback reachability under the project's real default config:** boot Core with `ADMIN_BIND_HOST=auto` (this project's shipped default) and confirm the write-bridge's own Unix-socket self-check (3.1) actually succeeds and is reachable by the internal client, and that a same-host process presenting a valid TCP source address (simulating a trusted reverse proxy per `CONSOLE_TRUSTED_PROXY_IPS`, connecting to the *TCP* listener since `network_mode: host` makes that reachable) is rejected by the `viaWriteBridgeSocket:false` path-scoping check — not, as a prior revision's wording implied, because it "cannot reach the socket file," which is imprecise (a TCP-sourced caller never touches the Unix socket at all; it's rejected by the flag check on the listener it *did* reach). Corrected after round-4 audit, batch #755, Architect hat.
- *(new, Core)* **`ADMIN_ALLOWED_IPS` exemption (#750):** boot Core with `ADMIN_ALLOWED_IPS` set to a value that would never match a Unix-socket connection's (empty) remote address, and confirm write-bridge requests still succeed — a regression test for the pre-existing IP-allowlist gate silently rejecting 100% of write-bridge traffic under this real, documented config. **This test must call `requestHandler` itself, not `handleApi` directly, added after round-6 audit (was CRITICAL #763, found independently by Architect + Security hats): the real `config.allowedIps` gate lives in `requestHandler` (the `createServer()` callback), structurally before `handleApi` is ever invoked — a test that only exercises `handleApi` cannot catch a bug where the exemption never reaches the actual gate, which is exactly the bug round 5's own fix had.**
- *(new, Core)* **`ADMIN_ALLOWED_IPS` fall-through negative case, added after round-6 audit (was HIGH #774, QA hat):** with `ADMIN_ALLOWED_IPS` set and `ADMIN_AUTH_DISABLED=1`, send a request over the Unix socket with an invalid/missing write-bridge token (failing write-bridge auth and falling through to plain `requireAuth()`) — confirm it is still rejected by the IP allowlist, not silently granted a synthetic owner-tier session. This is the negative-case counterpart to the positive-only test above; without it, an implementation that over-broadly exempts all socket traffic (round 4's original mistake) would still pass every other test in this section.
- *(new, Core)* **`opts`-omitted hang regression, added after round-6 audit (was HIGH #773, QA hat, for CRITICAL #756):** call `requestHandler(req, res)` with the third argument omitted entirely (not `{}`, not `{ viaWriteBridgeSocket: false }` — literally omitted) with `ADMIN_ALLOWED_IPS` set, and assert the request receives a real `200`/`403` response within a bounded time, never an unhandled-rejection-masked silent hang. Section 3.2's own text mandates this test explicitly; prior revisions of this section never actually included it.
- *(new, Core)* **Root-UID guard (#751):** simulate `process.getuid() === 0` and confirm the write-bridge refuses to enable RW routes, logging loud; confirm it enables normally under a non-root UID.
- *(new, Core)* **Socket restart safety (#753):** start Core, leave a stale file at the socket path (simulating an unclean prior shutdown), restart, and confirm the write-bridge subsystem comes up successfully (stale file removed, no `EADDRINUSE`) rather than crashing the whole process. **Extended after round-5 audit (was LOW, batch #762, QA hat):** also inject a synthetic non-`EADDRINUSE` listener error (e.g. a permissions error) and confirm graceful RW-subsystem disablement, not just the one specific reproduced error code.
- *(new, Core)* **Socket live-instance protection (#762):** simulate a second Core instance starting while a first is still genuinely live on the socket path (connect-probe succeeds) — confirm the second instance refuses to unlink and steal the path, disabling its own RW subsystem instead of silently taking over traffic from the still-running first instance.
- *(new, Core)* **Socket permission enforcement (#755):** assert the created socket file's mode is exactly `0700` after boot. **Extended after round-5 audit (was LOW, batch #762, QA hat):** also assert the self-check refuses to mark the RW subsystem healthy if a mocked/forced wrong resulting mode is detected — not just the happy-path assertion that the real mode is correct. **Extended again after round-6 audit (was MEDIUM, batch #776, QA hat): the final-mode assertion alone cannot distinguish the fixed (umask-before-listen) implementation from the vulnerable (chmod-after-listen-only) one — both converge on mode `0700` by the time boot completes, so this test on its own is tautological relative to the TOCTOU fix it's meant to guard.** Add a test that exercises the window itself: mock/spy `process.umask` and assert it is called with `0o077` before `.listen(socketPath)` and restored synchronously immediately after `.listen()` returns, before the `'listening'` event fires — proving the fix is actually the umask-based one, not just that the end state happens to look right.
- *(new, Core)* **`sun_path` length invariant, stated explicitly (round-4 audit, Network hat):** the socket path (`runtime/generated/discord-write-bridge.sock`, resolved relative to the container's fixed `/repo` WORKDIR) is safely under Linux's 108-byte `AF_UNIX` path limit today — verified empirically that exceeding this limit produces a doubly-deceptive silent failure (the `'listening'` event fires and reports success, yet no socket file is actually created). This margin is an accidental byproduct of the container's fixed WORKDIR, not a stated design invariant elsewhere in this doc; re-check if `repoRoot` resolution logic is ever changed (e.g. a future bare-host execution mode). **Extended after round-6 audit (was LOW, batch #776, Network hat, empirically confirmed): the connecting side's failure mode under truncation is specifically a misleading `ENOENT`**, not a distinct "path too long" error, even when a real file genuinely exists at the literal (untruncated) path — a truncation-driven `ENOENT` on the split-brain liveness probe (3.2) could be misread by that probe's own logic as "no prior instance," rather than "the path itself is silently wrong." Not a live issue today (the current path is safely short), but relevant if this path is ever lengthened and the probe's `ENOENT` branch is used for operator-facing log wording.
- *(new, Core)* **Item catalog autocomplete latency (3.6, #745):** a realistic query against the full real catalog responds within the bot's 3s autocomplete budget.

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

**Round 5 (2026-09-09, re-auditing the round-4 corrections), 8 hats, 7 issues filed:**

| # | Title | Hat(s) | Severity |
|---|-------|--------|----------|
| 756 | requestHandler's opts parameter can be undefined, hanging every console request for ADMIN_ALLOWED_IPS operators | Network | CRITICAL |
| 757 | ADMIN_ALLOWED_IPS exemption scoped too broadly and viaWriteBridgeSocket has no described path to the auth-resolution code | Security, Architect | HIGH |
| 758 | Per-key idempotency lock Map has no stated entry cleanup — unbounded memory growth | DBA, Security, Architect, QA | HIGH |
| 759 | secondFactorStore.js corruption-handling precedent was miscited (fails closed, not open) — 3rd citation-accuracy failure | DBA | HIGH |
| 760 | clear-backpack duplicate inaccurate wording not fully fixed; root-UID startup refusal lacks operator-facing completeness | UI/UX, Architect | HIGH |
| 761 | CHANGELOG.md was not updated for round-4 findings, breaking an established pattern from rounds 2-3 | GRC | HIGH |
| 762 | Batched MEDIUM/LOW: split-brain race, TOCTOU chmod window, roleSnapshotAt validation, and remaining doc-consistency findings | multiple | MEDIUM/LOW (batch) |

**Round 6 (2026-09-09, re-auditing the round-5 corrections), 8 hats, 14 issues filed — the largest finding set of any round so far:**

| # | Title | Hat(s) | Severity |
|---|-------|--------|----------|
| 763 | ADMIN_ALLOWED_IPS exemption fix never reaches the real gate in server.js — CRITICAL #750 still unresolved | Architect, Security | CRITICAL |
| 764 | Design doc's own header and Section 8 tracking table were never updated for round-5 findings | GRC | HIGH |
| 765 | Section 4 still cited the stale pre-round-3 history-clear confirmation phrase, a 3rd occurrence | GRC, UI/UX | HIGH |
| 766 | warn command's confirmation requirement contradicted itself between Section 2 and Section 4 | UI/UX | HIGH |
| 767 | Section 1 tier table listed phantom owner capabilities (base destroy, guild delete) undefined elsewhere | UI/UX | HIGH |
| 768 | Canonical verifyActorSignature() example was never updated for round-5's signed-fields threading fix | Cloud Security | HIGH |
| 769 | Idempotency Map cleanup could delete the coordination entry for a still-in-flight mutation on timeout | DBA | HIGH |
| 770 | Idempotency-cache pruning sweep and write/execute's persisted write were unsynchronized against the same file | DBA | HIGH |
| 771 | grant-all's cited IAM Action was wrong, causing a miscount in round-5's own new cross-IAM finding | DBA | HIGH |
| 772 | Unix-socket liveness probe had no 'timeout' handler — could hang Core's entire boot | Network | HIGH |
| 773 | No regression test for CRITICAL #756's own hang scenario, despite the design mandating one | QA | HIGH |
| 774 | No regression test for #757's ADMIN_ALLOWED_IPS narrowing fix | QA | HIGH |
| 775 | No test proved roleSnapshotAt is cryptographically covered by the signature | QA | HIGH |
| 776 | Batched MEDIUM/LOW: umask restore-timing, SIGNED_ACTOR_FIELDS future governance, Section 4 confirmation-list gaps, dual-confirmation UX gap, and remaining test/citation nits | multiple | MEDIUM/LOW (batch) |

**Mechanical cross-reference pass (2026-09-09, after round 6 — not a hat dispatch), 1 issue filed:**

| # | Title | Source | Severity |
|---|-------|--------|----------|
| 777 | fill-water missing from Section 4 lists; ban/spawn/despawn/respawn missing inline confirmation-phrase mentions | mechanical script | LOW |

**Round 7 (2026-09-09, re-auditing round 6's corrections AND #777's own governance trail), 8 hats, 14 issues filed — highest CRITICAL count of any round so far:**

| # | Title | Hat(s) | Severity |
|---|-------|--------|----------|
| 778 | Idempotency fixes #769/#770 have an unstated ordering dependency — both plausible orderings are broken | DBA | CRITICAL |
| 779 | Liveness-probe timeout fix never settles its Promise — reproduces the exact hang #772 was meant to fix | Architect, Network | CRITICAL |
| 780 | resolveWriteBridgePrincipal's path source is unspecified, violating round-3's anti-double-parse rule | Architect, Security | HIGH |
| 781 | runExclusive() fix for the idempotency cache is unbounded — recreates round-4's #752 DoS class | DBA, Architect | HIGH |
| 782 | stop dual-confirmation gate has zero test coverage despite an explicit round-6 commitment | QA | HIGH |
| 783 | resolveWriteBridgePrincipal has no dedicated unit test | QA | HIGH |
| 784 | runExclusive() fix has no sweep-vs-write concurrency regression test | QA | HIGH |
| 785 | stop dual-confirmation gate's identity/authorization model is broken | UI/UX, Security | HIGH |
| 786 | stop dual-confirmation gate's timing budget is unreconciled with the nonce TTL | UI/UX | HIGH |
| 787 | stop dual-confirmation gate's enforcement mechanism is ambiguous against the nonce store's actor binding | Architect | HIGH |
| 788 | runExclusive() contention risk if write/preview also touches the persisted cache | Security | HIGH |
| 789 | Section 3.8 never resolved the fields/signedFields naming ambiguity | Cloud Security | HIGH |
| 790 | Mechanical-pass fix #777 was not governed with the same discipline as hat rounds | GRC | HIGH |
| 791 | Batched MEDIUM/LOW: stop-gate UX gaps, timeout-fix wording contradiction, governance script hardening | multiple | MEDIUM/LOW (batch) |

**Isolated review (2026-09-09, after round 7 — a scoped 4-hat dispatch against ONLY the `stop` dual-confirmation gate, not a full-document round), 8 issues filed:**

| # | Title | Hat(s) | Severity |
|---|-------|--------|----------|
| 792 | No wire-level correlation mechanism for the second confirmer's request | Architect, Security | CRITICAL |
| 793 | Idempotency-key semantics unspecified with a silent-fail-closed path | Architect | CRITICAL |
| 794 | Single-admin fallback decided from unsigned, unbounded bot-cached role data | Security | HIGH |
| 795 | Pending record had no stated storage location or concurrency control | Architect | HIGH |
| 796 | Enforcement layer risked modifying the real shared /api/server/stop route | Architect | HIGH |
| 797 | Second confirmer's flow could require two clicks instead of one | UI/UX | HIGH |
| 798 | Test bullet never proved the primary's own click doesn't trigger the real mutation | QA | HIGH |
| 799 | Batched MEDIUM/LOW: button-code authorization mismatch, atomicity, test-coverage, UX-surfacing gaps | multiple | MEDIUM/LOW (batch) |

This isolated review was dispatched deliberately narrower than a full 8-hat round — scoped to just the `stop` dual-confirmation gate, the newest and least-battle-tested mechanism in the document, before committing to a full round 8 across everything. All CRITICAL/HIGH resolved by redesigning the gate to reuse the existing nonce store instead of inventing a new record type and a second full preview/execute round-trip.

**Quick follow-up check (2026-09-09, after the isolated review's redesign) — a narrow 2-hat dispatch (Security, Architect) against only the redesigned nonce-reuse mechanism, 2 issues filed:**

| # | Title | Hat(s) | Severity |
|---|-------|--------|----------|
| 803 | Nonce consume-then-execute check needs explicit atomic ordering before the loopback call | Architect | MEDIUM |
| 804 | Batched LOW: doc cross-reference and unstated-edge-case gaps in the redesigned mechanism | Security, Architect | LOW (batch) |

The smallest finding set of any pass so far — a good sign the `stop` gate's third design is converging. All fixed.

**Coverage-closure pass (2026-09-09, after the quick check) — mechanical script extension + two single-hat checks against specific, long-acknowledged gaps rather than another full round, 2 issues filed:**

| # | Title | Hat(s)/Source | Severity |
|---|-------|--------|----------|
| 806 | ban and guild.remove Section-2 rows regressed to already-fixed CRITICAL/HIGH bugs (ban/unban inversion, missing path segment) | mechanical script (extended for endpoint verification) | HIGH |
| 807 | Item-catalog endpoint's prefix-match design inconsistent with codebase precedent; WRITE_ACTION_ROUTES self-check's flagged-since-round-2 gap never designed | QA, Architect | MEDIUM |

Deliberately not another full round: the mechanical script was extended to verify every command's real endpoint (method+path) against `server.js`'s actual dispatch table, which alone found #806 in minutes; #807 closed two specific, already-on-the-record gaps (item-catalog test coverage flagged since round 3, `WRITE_ACTION_ROUTES` self-check flagged since round 2) with one scoped hat check each. Both fixed — see [[bounded-coverage-plan-over-open-ended-rounds]] for why this approach was chosen over another reactive full round.

**Final confirmatory round (2026-09-09, the coverage-closure plan's last step — a full, unscoped Eight-Hat round against the whole further-corrected document), 12 issues filed covering 18 distinct findings — the largest raw finding count of the entire audit history:**

| # | Title | Hat(s) | Severity |
|---|-------|--------|----------|
| 808 | runExclusive() cancellation gap: a timed-out operation's in-flight writeJsonAtomicAsync() I/O is never actually stopped | DBA | CRITICAL |
| 809 | stop gate's first-confirmation branch never checks the calling actor matches the nonce's own actorUserId | Architect | HIGH |
| 810 | stop gate's atomicity claim names an outcome, not a mechanism | DBA | HIGH |
| 811 | Catalog refresh-policy paragraph still described a design this doc no longer uses, contradicting the reused-function fix | DBA, Security | HIGH |
| 812 | Doc header, Section 8 tracking table, and CHANGELOG.md never updated to reflect the isolated review, quick check, or coverage-closure pass | GRC | HIGH |
| 813 | No UI mechanism ever designed for a typed-confirmation command despite Section 4 requiring one | UI/UX | HIGH |
| 814 | Catalog match semantics described as name-only; real listCatalogItems() also matches id/category and does no ranking | UI/UX | HIGH |
| 815 | stop gate's terminal outcomes never notify the primary's own original message/interaction | UI/UX | HIGH |
| 816 | No test coverage for the auditAction mechanical-fingerprint mechanism designed in #807 | QA | HIGH |
| 817 | No regression test proving the #769/#778 idempotency-ordering fix specifically, only its symptoms | QA | HIGH |
| 818 | No test asserting WRITE_ACTION_MIN_TIER stays >= what policy.js's DEFAULT_POLICIES would require | QA | HIGH |
| 819 | Batched MEDIUM/LOW: missing catalog rate limit, grant-all Section 2/4 confirmation-classification contradiction, unbounded pruning-sweep batch size, method-axis test gap, generic success embed on high-risk commands, stale path-computation citation, bare "Yes" cells with no stated preview content | multiple | MEDIUM/LOW (batch) |

All CRITICAL/HIGH resolved in this revision. **This round did not come back clean** — per the Layer-1 exit gate, another full round is technically required before Layer 2 begins; whether to run it is an explicit decision left to the user, per the coverage-closure plan's own hard-stop condition, not an automatic continuation.

Full findings and STRIDE reports for the coverage-closure pass and the final confirmatory round: comments on #215.
