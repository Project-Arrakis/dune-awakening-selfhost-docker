# Discord-Verified-Player Enforcement — Design Spec

**Status:** Design only. Not approved for implementation.

**Revision history:** An Eight-Hats Layer 1 (design) audit was run against
the original version of this spec (2026-09-27, 8 independent dispatched
agents — findings posted in full to
[`dune-awakening-selfhost-docker#1077`](https://github.com/Project-Arrakis/dune-awakening-selfhost-docker/issues/1077)).
It found **5 independent CRITICAL findings from 5 different hats**,
converging on two root problems: (1) the originally-proposed system-actor
authorization bypass was forgeable by anyone holding the same secret every
routine human action already uses, and (2) the rollback design had an
unaddressed single point of failure that could permanently lose a
character's true inventory capacity. This revision fixes both at the
architecture level, not by adding caveats around the original design.
Every section below reflects the *revised* design; see the tracking issue
for the full original audit if you need the before/after.

**Repos affected:** `dune-awakening-selfhost-docker` (Core — new write
action, new persisted state), `mentat` (the Discord bot — new background
enforcement service, new local state, new player-facing commands).

**Tracking:** [`dune-awakening-selfhost-docker#1077`](https://github.com/Project-Arrakis/dune-awakening-selfhost-docker/issues/1077)
(Core), [`mentat#409`](https://github.com/Project-Arrakis/mentat/issues/409)
(mentat, cross-linked).

**Risk classification:** **HIGH.** This introduces the write-bridge's
first-ever unattended, no-live-human write path, mutating a column the
closed-source game engine also manages, gated on player fairness. Blast
radius, once the fixes in this revision are implemented: a failure mode
affects at most one character's inventory capacity per incident (the new
dedicated secret and per-call resolution described in section 4.2 prevent
a single compromise from escalating further than that).

## 1. Problem

Chronicles of Kanly (the live Discord guild for this self-hosted server) has
a role hierarchy — 🏛️ Naib, 🗡️ Fedaykin, 🔪 Crysknife-Bearer, 🌫️
Off-worlder, 🏳️ Houseless, 🦅 House Atreides, 🐍 House Harkonnen — and an
existing, secure mechanism (`/dune player link` + `/dune data verify`) for
proving a Discord account controls a specific in-game character. What's
missing: nothing currently checks whether a character's linked Discord
account actually holds an appropriate role, and nothing happens in-game if
it doesn't. A player can join the game server and play normally regardless
of their Discord standing.

The operator wants unverified characters to be *playable but crippled* —
specifically, their backpack capacity cut to near-nothing — until their
linked Discord account holds one of the three most-trusted roles.

## 2. What already exists (do not rebuild)

- **Registration/linking is already solid.** `/dune player link` resolves
  a claimed character name, then proves ownership via a private in-game
  whisper containing a 6-character time-boxed code (or an instant
  Steam-based path for characters with a Steam ID on file), verified via
  `/dune data verify`. Rate-limited against guessing
  (`docs/security/discord-player-link-hardening.md`). One Discord account
  ↔ one character, enforced 1:1 by `linkPlayerProvider()`
  (`console/api/src/integrations/discord/linkProvider.js`).
- **The write-bridge pattern already exists** for authenticated,
  capability-gated, audited mutations triggered from Discord:
  `WRITE_ACTION_MIN_TIER` (per-action minimum role tier),
  `requireDiscordCapability`/`requireSelfScopedCapability`, HMAC
  actor-signature verification (`actorSignature.js`) on `write/preview` and
  `write/execute`, `audit()` logging. Existing player-affecting actions —
  `player.kick`, `player.ban`, `player.warn`, `player.give-item`,
  `player.clear-backpack`, `player.fill-water` — all resolve their target
  via a real player ID (`validatePlayerId`), **never a character name**;
  the earlier version of this spec proposed a character-name-addressed
  action, which the Architect hat correctly flagged as not fitting this
  pattern at all. This revision uses `playerControllerId`, which mentat
  already has on hand from its own linking table — this also removes an
  entire unneeded name-resolution/ambiguity step from the design.
- **Every write/execute call carries `roleSnapshotAt`**, a timestamp
  proving the acting human's roles were re-derived from Discord within a
  narrow window (anti-replay). The original spec's system-actor bypass
  skipped this check entirely — a real gap, fixed in section 4.2 below.
- **The underlying game data for backpack capacity is real and already
  read.** `dune.inventories` (`inventory_type = 0`, `actor_id =
  <player's current pawn id>`) has `max_item_count`/`max_item_volume`
  columns. `duneDb.js`'s `backpackCapacity()` already reads them.
  `giveItemToPlayer()` already writes to a *different* column on this
  exact row, inside `db.transaction(...)` with an explicit `for update`
  lock — this codebase already treats concurrent access to this row as a
  real hazard, a precedent this design's write action must follow (section
  4.2 does).

## 3. Scope decisions (confirmed with the operator, 2026-09-27)

| Question | Decision |
|---|---|
| Which roles count as "verified"? | Only 🏛️ Naib, 🗡️ Fedaykin, 🔪 Crysknife-Bearer. |
| What triggers enforcement? | Continuous live check: linked-but-lacking-role triggers it too, not just "never linked." |
| Enforcement mechanism | Cap `max_item_count`/`max_item_volume` low (operator's stated target: 1 / 10). |
| Fail-open vs. fail-closed | Fail-closed, softened: a character with a known-good "verified" status keeps it through a check *failure* (mentat/Core outage) — it is only re-constrained once a check actively *re-confirms* the role is gone. See section 4.1 for the bound this revision adds (a character never known-good stays constrained; a check failure never silently extends trust forever — section 4.1's staleness cap addresses the audit's Security F5 finding). |
| Existing (pre-launch) players | Grace period, then applies to everyone. **Owner: the operator. Decision needed before rollout step 5 (section 9) begins** — this spec does not fix the exact duration, but per the GRC audit finding, an undated open item with no named owner is not acceptable; the operator is the explicit, sole owner of picking the date, and rollout must not proceed past the announcement step without it being picked. |

## 4. Architecture

### 4.1 mentat: the enforcement watcher

Owns the *decision* of whether a character is currently believed verified,
and when to call Core. It does **not** own game-data recovery state
(section 4.2 explains why that moved to Core in this revision).

**Inputs:**
- `guildMemberUpdate` / `guildMemberRemove` gateway events — requires
  adding `GatewayIntentBits.GuildMembers` to `src/index.js`'s persistent
  `Client` (the privileged intent is already approved at the Discord
  Developer Portal). **Audit note (Network hat):** this intent is
  bot-wide, not per-guild — enabling it increases inbound gateway event
  volume for every guild mentat serves, not just Chronicles of Kanly. Fine
  at this deployment's single-guild scale; an operator of this fork running
  mentat across many guilds should know this before opting in. Worth a
  line in the eventual operator-facing docs, not a design blocker.
- A periodic reconciliation sweep (recommended interval: 30 minutes,
  matching `atlasRefresher`/`startScheduler`'s existing pattern), reading
  from the gateway-populated member cache (not a fresh REST fetch per
  character — avoids the unbounded-request-volume concern the DBA and
  Network hats both raised). **Audit note:** process in small batches with
  a short delay between them rather than one unbounded pass, matching this
  codebase's existing rate-limited-loop conventions elsewhere.

**Local state** (mentat's own SQLite, additive migration per this
project's Requirement 26 — `CREATE TABLE IF NOT EXISTS`, with `DROP TABLE
IF EXISTS enforcement_status` as the documented rollback, tested against a
copy of mentat's real production database before merge, not just an empty
fixture):

```
enforcement_status (
  player_controller_id TEXT PRIMARY KEY,
  discord_user_id       TEXT NOT NULL,
  verified               INTEGER NOT NULL,   -- 0/1
  last_checked_at        TEXT NOT NULL,
  last_transition_at     TEXT NOT NULL
)
```

**Revised three-state semantics (closing the QA audit's F2 finding — this
is now a complete, testable state-transition table, not just stated
intent):**

| State | Row exists? | `verified` | Meaning | Capacity |
|---|---|---|---|---|
| Never established | No | — | Never linked, or a check has never succeeded | Constrained (true fail-closed) |
| Trusted | Yes | 1 | Last successful check found the role present | Normal |
| Actively lost | Yes | 0 | Last successful check found the role *absent* | Constrained |

A **failed check attempt** (mentat/Core outage, Discord API error) never
writes to this table at all — `last_checked_at` only advances on a
*successful* check, of either outcome. This is what makes the "trusted"
state survive an outage: nothing about a failure ever touches the row.

**Staleness bound (closing Security audit finding F5 — the original
"softened forever" design was an exploitable one-way ratchet):** if
`last_checked_at` on a "Trusted" row is older than a fixed ceiling (24
hours — long enough to survive any realistic mentat outage or deploy, short
enough that a sustained failure can't entrench privilege indefinitely), the
reconciliation sweep treats it as a **once-only** forced re-check on its
next run, not an automatic downgrade — if that forced re-check itself
fails, only then does the row move to "actively lost." This preserves the
outage-survival property while closing the indefinite-entrenchment gap.

**On unlink** (closing QA audit finding F7): the row is **deleted**
outright, not set to `verified = 0`. This means "no row" uniformly means
"nothing currently tracked for this character" — re-linking always starts
from "never established," which is the intended anti-abuse behavior (you
cannot unlink to dodge a pending re-check and keep your old trusted state).
`/dune player unlink`'s existing confirmation flow must warn the player
their capacity will drop immediately if enforcement is active for their
guild (closing UI/UX audit finding #7) — this is a one-line addition to an
already-existing confirmation prompt, not new UX surface.

**On a status transition,** mentat calls the new Core write action
(4.2), signed with the dedicated system-actor credential described there.

### 4.2 Core: the new write action (revised architecture)

**What changed from the original design, and why:** the original version
kept Core "stateless" (mentat alone remembered a character's pre-constraint
values) and authorized the automated caller via a bypass sharing the same
secret every human write already uses. The audit found both of these to be
the design's real load-bearing risks — independently, from the Architect,
DBA, QA, Security, and Cloud Security hats. Both are fixed here by moving
"what should this character's real capacity be" into Core's own database,
written atomically with the mutation itself, and by giving the automated
caller its own, narrowly-scoped credential distinct from the one every
human command already uses.

**New Postgres table** (`console` schema, alongside the existing
`discord_pending_links`/link tables — additive, backward-compatible per
Requirement 26):

```sql
create table if not exists console.discord_enforcement_state (
  player_controller_id  bigint primary key,
  constrained            boolean not null,
  restore_max_item_count  integer,
  restore_max_item_volume integer,
  updated_at              timestamptz not null default now()
);
```

`restore_max_item_count`/`restore_max_item_volume` are only ever populated
the first time a character is constrained (captured atomically, see
below) — they hold the character's real, perk-derived values, not a
guessed default. This is the single, durable, backed-up (via Core's
existing Postgres backup/restore-test cadence, Requirement 25 — unlike
mentat's SQLite, which was the original design's actual point of failure)
source of truth for "what to restore." mentat's own `enforcement_status`
table (4.1) never needs to track these values at all — it only tracks
*whether* mentat currently believes the character should be constrained,
which is a much smaller, recoverable-by-re-check piece of state if lost.

**Write action:** `player.set-backpack-cap`, params `{ playerControllerId,
constrained: boolean }` — a boolean, not raw capacity numbers, closing
Security audit finding F6 (no legitimate caller, human or system, should be
choosing arbitrary numeric values; the action only ever knows "make this
character's capacity normal" or "make it the enforced minimum," with the
enforced minimum defined as a config constant, not a per-call parameter).

**Behavior**, inside one transaction with `for update` (matching
`giveItemToPlayer()`'s existing, established locking pattern for this exact
row — closing DBA audit finding F1):
1. Resolve the character's *current* `actor_id` (pawn id) fresh, via the
   same join `resolvePlayerByName`/`backpackCapacity()` already use through
   `dune.player_state` — never cached or passed in by mentat, closing
   Architect audit finding #9 (pawn ids are not assumed stable across
   sessions; Core always resolves fresh at call time).
2. Read-and-lock the current `dune.inventories` row and
   `console.discord_enforcement_state` row for this character.
3. If `constrained: true` and no `discord_enforcement_state` row exists
   yet, capture the *current* `max_item_count`/`max_item_volume` into
   `restore_max_item_count`/`restore_max_item_volume` before overwriting —
   this capture and the `dune.inventories` overwrite happen in the same
   transaction, eliminating the crash-race the original design had (there
   is no longer a separate "remember this somewhere else" step that could
   be skipped by a crash).
4. Apply the new capacity (the fixed enforced minimum, or the stored
   restore values, matching `constrained`).
5. If no `dune.inventories` row exists yet for this character (a brand-new
   character whose first login hasn't been processed), return
   `{ ok: false, code: "inventory_not_ready" }` explicitly (closing QA
   audit finding F3) — mentat treats this as "retry on the next sweep," not
   a real failure.

**Authorization — a dedicated credential, not a bypass of the existing
one** (closing Security findings F1/F2 and Cloud Security findings F1/F2/F4,
all four of which independently converged on this as the design's most
serious problem):

- A new, distinct secret, `DUNE_DISCORD_ENFORCEMENT_ACTOR_SECRET`
  (`_FILE` variant supported, matching every other secret in this
  codebase's convention) — **never** `DUNE_DISCORD_ACTOR_SECRET`. A leak of
  the general actor secret (used by every human-triggered command) no
  longer grants this capability at all; the two trust domains are
  independently rotatable, closing Cloud Security finding F4.
- The signed payload includes a fresh timestamp field, checked for a tight
  freshness window (60 seconds) the same way `roleSnapshotAt` protects
  every human write/execute call today — closing Architect finding #8. A
  captured signed request cannot be replayed after the window closes.
- Core checks this dedicated secret and freshness window *instead of*
  `discordActorTier()`/`requireDiscordCapability()` for this one action
  only — not a bypass that lives *before* the general authorization path
  (as the original design had it), but a **completely separate
  verification function** with its own secret, so there is no shared code
  path where a bug could let a general human actor slip through as the
  system actor or vice versa.
- `player.set-backpack-cap` is **not** reachable via the normal
  `write/preview`/`write/execute` dispatch at all — it has its own,
  separate route, checked only by the mechanism above. This also directly
  resolves the original design's exposure of this action to any real
  owner-tier human (Security finding F6's secondary point).
- Requirement 27 (credential rotation) must be updated, as part of
  implementation, to name `DUNE_DISCORD_ENFORCEMENT_ACTOR_SECRET`
  explicitly and document its rotation procedure (closing GRC audit
  finding #13) — this is a real, new secret with a real, novel blast
  radius (autonomous write authority), and Requirement 27 currently names
  no secret like it.

**Audit:** the same `audit()` call every write action already uses,
`actorId` recording the fixed system identity — same trail, distinguishable
from a human action only by that field, per this project's own
Requirement 20 evidence-trail discipline.

### 4.3 Admin-assisted linking (for players who decline self-serve verification)

Some players won't or can't complete `/dune player link` + `/dune data
verify` (a rarely-online character with no Steam ID would need to catch a
5-minute whisper window). Second path: a designated Discord channel where a
player posts their character name, and a moderator manually vouches for the
link.

**Concrete channel name (closing UI/UX audit finding #4's "never specified"
gap):** a new channel, `#character-registration`, created under the same
category as the existing onboarding-facing channels. Once
`/dune player admin-link` succeeds, mentat posts a confirmation reply in
that same channel (closing the "zero acknowledgment" half of the same
finding) — this is a single confirmation message tied to the command's own
existing response, not a new listener/automation on the channel itself
(the "pure manual for v1" process decision is unchanged: nothing watches
the channel for unprocessed posts).

**Kept as two distinct commands, not merged into one.** `/dune player
link` (self-serve, cryptographically proven) and `/dune player admin-link`
(moderator-vouched, no independent proof) stay separate — the two paths
have genuinely different trust levels, and a moderator or player looking at
what happened later should be able to tell at a glance which kind of link
any given character has.

**New write action:** `player.admin-link`, params `{ targetDiscordUserId,
characterName }`. **Must call `linkPlayerProvider`'s real, shared
uniqueness-check logic directly** (refactored into its own exported
function if needed so both entry points call the identical code), not
reimplement the check separately — closing Security audit finding F4,
which found the original spec's "runs the exact same checks" framing was
a claim, not something the design actually enforced in code. On the
existing-conflict rejection, the moderator sees the exact same
lore-flavored error message `linkPlayerProvider` already returns for this
case (closing UI/UX audit finding #5 — no new message to write, the
existing one is already clear and already reused verbatim).

**Tier:** `WRITE_ACTION_MIN_TIER["player.admin-link"] = "moderator"` —
matching the operator's own framing, the same bar as `player.warn`.

**Trust tradeoff, stated explicitly:** this path has no independent proof
of ownership — the moderator's judgment *is* the security boundary, same
as `player.warn`/`kick`/`ban` today. What's different here (per the
Security hat's finding #10) is that this creates a *durable identity
binding* that then gates ongoing gameplay capacity, not an ephemeral
moderation action — worth a line in moderator-facing documentation, since
a bad admin-link is harder to walk back cleanly than a bad warning.

**Audit:** the same `audit()` call, `actorId` recording which moderator
performed the link — the paper trail if a bad admin-link is disputed later.

## 5. Player-facing communication (new section — closing 4 UI/UX audit findings)

The original design had **zero** player-facing communication anywhere —
the UI/UX hat found this to be the single biggest gap in the whole spec,
across four separate findings. This section is new.

- **New self-serve command, `/dune player status`** (any player, no
  minimum role): reports whether the caller's linked character is
  currently constrained or normal, and why (never linked; linked but
  lacking a qualifying role; linked and verified). This is the primary fix
  for "how does a player find out" (UI/UX finding #1/#2) — rather than a
  best-effort DM that could silently fail (closed DMs, rate limits), a
  command a player can run any time is a reliable, always-available answer.
- **Best-effort DM on transition** (constrain or lift), in addition to
  the status command, not instead of it — sent if the player's DMs are
  open, silently skipped (logged, not retried) if not. This closes the
  "no confirmation on lift" finding (#3) for the common case, while
  `/dune player status` remains the reliable fallback.
- **Grace-period announcement:** posted in `#announcements` (this guild's
  existing general-purpose announcement channel), pinned, a minimum of 14
  days before enforcement begins for existing players — closing UI/UX
  finding #6. The exact date is still the operator's call (section 3); this
  fixes the channel and minimum lead time, not the date itself.

## 6. Edge cases

- **Character exists but has no `dune.inventories` row yet:** handled
  explicitly in section 4.2 step 5 (`inventory_not_ready`, mentat retries
  on the next sweep).
- **Un-linking:** handled explicitly in section 4.1 (row deleted, player
  warned at unlink time).
- **Discord API/gateway outage vs. mentat process outage:** both covered
  by section 4.1's staleness-bounded softened fail-closed rule.
- **Multiple guilds:** mentat is multi-tenant; enforcement must be
  configured per-guild (a guild opts in, names its own "verified" roles)
  rather than hardcoding Chronicles of Kanly's role IDs into shared code.
  **The exact per-guild configuration interface (table/command/env) is
  explicitly deferred** — not designed here, not required for this guild's
  v1 rollout, and should get its own short design pass before a second
  guild ever enables this feature (closing QA audit finding F8 by naming
  the gap rather than leaving it silently unaddressed).

## 7. Rollback

Turning this off entirely: stop the watcher/sweep, then run a one-time pass
restoring every `constrained = true` row in
`console.discord_enforcement_state` via the same write action
(`constrained: false`) — Core already holds the true original values, so
this is a complete, reliable rollback with no dependency on mentat's own
database surviving (the original design's single point of failure, closed
by moving this state to Core in section 4.2).

## 8. Feasibility spike

**Tracked separately, not just in this spec's prose:** filed as
[`dune-awakening-selfhost-docker#1078`](https://github.com/Project-Arrakis/dune-awakening-selfhost-docker/issues/1078)
(closing GRC audit finding #12 — a real, destructive-adjacent test against
live game data needs an independently discoverable record, not just a spec
paragraph). See that issue for the full writeup.

**What was tested (2026-09-27, against `dune-dev`):** `UPDATE
dune.inventories SET max_item_count = 1, max_item_volume = 10 WHERE id =
<a real character's backpack row>`, on a row holding 18 real items, then
reverted. Confirmed: no CHECK constraint or trigger; the value persists
without being auto-reverted while the character is offline; no existing
items were touched by the write itself.

**Not yet verified — still a hard go/no-go gate, and the audit's QA and
DBA hats found this gate's scope was too narrow as originally stated:**
what the live game engine does when a character logs in *and plays* while
over its new, lower capacity. The original gate only named "watch a
login"; per DBA finding F3, the required test must also cover **picking up
an item, withdrawing from base storage into the backpack, completing a
trade, and completing crafting into the backpack** while over-cap — each
is an independent code path a login-only test wouldn't exercise. This
cannot be tested without a human at a real game client; it is the single
hard blocker before implementation begins.

**Required regression coverage, not just a one-off manual check (closing
QA audit finding F1):** once section 4.2's transactional write exists in
code, it must have a real, fixture-backed Postgres integration test
(matching this repo's own `console/api/test-support/vehicleStorageFixture.js`-style
conventions) asserting the full read-lock-capture-write flow, including
the byte-identical restore-value round-trip (closing QA finding F4) — this
is now natural to test precisely because section 4.2 moved the capture into
the same atomic, code-owned operation instead of a separate manual
mentat-side memory step.

## 9. Explicitly out of scope for this design

- Any change to the linking/verification mechanism itself.
- Any UI/dashboard for operators to see enforcement status.
- Per-guild enforcement configuration for guilds other than Chronicles of
  Kanly (section 6).
- Enforcement against anything other than backpack capacity.
- A false-positive incident-reporting process beyond `/dune player status`
  (letting the affected player self-diagnose) and `/dune player admin-link`
  (letting a moderator manually correct a wrongly-constrained character) —
  both already-designed mechanisms are sufficient remediation paths; a
  dedicated incident-tracking workflow is not needed for v1.

## 10. Rollout

1. File tracking issues — **done**: [`dune-awakening-selfhost-docker#1077`](https://github.com/Project-Arrakis/dune-awakening-selfhost-docker/issues/1077), [`mentat#409`](https://github.com/Project-Arrakis/mentat/issues/409).
2. Eight-Hats Layer 1 (design) audit — **done**, this revision is the result.
3. Run the widened login-behavior spike (section 8) against `dune-dev`. Hard go/no-go gate.
4. Implementation (via `writing-plans`), including the required regression tests (section 8) and the Requirement 27 documentation update (section 4.2).
5. Operator picks and announces the grace-period end date (section 3, section 5) — minimum 14 days' notice in `#announcements`.
6. Layer 2 (implementation) and Layer 3 (integration) Eight-Hats audits per the normal process, before this ever reaches `dune-prod2`.
