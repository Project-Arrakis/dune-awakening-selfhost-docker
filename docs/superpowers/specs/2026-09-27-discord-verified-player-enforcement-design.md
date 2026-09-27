# Discord-Verified-Player Enforcement — Design Spec

**Status:** Design only. Not approved for implementation. No Eight-Hats
Layer 1 (design) audit has been run against this document yet — per this
project's own Requirement 20, that audit is a required gate before any
implementation plan is written, not optional ceremony.

**Repos affected:** `dune-awakening-selfhost-docker` (Core — new write
action, new read data), `mentat` (the Discord bot — new background
enforcement service, new local state).

**Tracking:** Not yet filed as GitHub issues. Filing real issues (one per
repo, cross-linked, per Requirement 15) is the first concrete action once
this spec is approved — do not implement before they exist.

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
  ↔ one character, enforced 1:1. This fully replaces the "post your
  character name in a channel" idea floated during brainstorming — it's
  already stronger (cryptographically-adjacent proof of ownership vs. an
  honor system).
- **The write-bridge pattern already exists** for authenticated,
  capability-gated, audited mutations triggered from Discord:
  `WRITE_ACTION_MIN_TIER` (per-action minimum role tier),
  `requireDiscordCapability`/`requireSelfScopedCapability`, HMAC
  actor-signature verification on `write/preview` and `write/execute`,
  `audit()` logging. Existing player-affecting actions: `player.kick`,
  `player.ban`, `player.warn`, `player.give-item`, `player.clear-backpack`,
  `player.fill-water`.
- **The underlying game data for backpack capacity is real and already
  read.** `dune.inventories` (`inventory_type = 0`, `actor_id =
  <player_pawn_id>`) has `max_item_count`/`max_item_volume` columns.
  `duneDb.js`'s `backpackCapacity()` already reads them (default fallback
  40/225 if the row is missing). **Nothing in this codebase has ever
  written to these columns before this design** — see the feasibility
  spike in section 7.

## 3. Scope decisions (confirmed with the operator, 2026-09-27)

| Question | Decision |
|---|---|
| Which roles count as "verified"? | Only 🏛️ Naib, 🗡️ Fedaykin, 🔪 Crysknife-Bearer. Off-worlder/Houseless/House Atreides/House Harkonnen do **not** count. |
| What triggers enforcement? | Continuous live check: linked-but-lacking-role triggers it too, not just "never linked." A player who links, then loses the role or leaves the guild, becomes enforced again. |
| Enforcement mechanism | Soft penalty: cap `max_item_count`/`max_item_volume` low (operator's stated target: 1 / 10) rather than kick/ban. Character stays playable, just can't meaningfully carry anything. |
| Fail-open vs. fail-closed | Fail-closed, **softened**: a character that has *never* been successfully checked defaults to constrained. A character with a known-good "verified as of `<time>`" status keeps that status through a check failure — it is only re-constrained once a check actively re-confirms the role is gone, not merely because a check couldn't run. This specifically protects against a routine mentat restart/deploy (frequent — every push to the bot) mass-crippling every already-verified player. |
| Existing (pre-launch) players | Grace period, then applies to everyone. Exact duration is an operator call at rollout time, not fixed in this spec — see section 9. |
| System-actor authentication | A dedicated, reserved system actor identity (not a real Discord user), signed with the existing `DUNE_DISCORD_ACTOR_SECRET` HMAC scheme, explicitly allowlisted in Core to a sufficient tier for this one action. Same audit trail as any human-triggered action. No new credential type. |

## 4. Architecture

Two new pieces, one per repo, plus one new interface between them.

### 4.1 mentat: the enforcement watcher (new)

Owns all Discord-side state: who's linked, what role they currently hold,
and whether they're currently believed to be constrained. This is the
natural owner because mentat is the only side of this system with live
visibility into Discord role membership — Core has never known about
Discord roles beyond the `roleIds` array a live command's actor carries.

**Inputs:**
- `guildMemberUpdate` / `guildMemberRemove` gateway events (reactive —
  requires adding `GatewayIntentBits.GuildMembers` to the bot's persistent
  `Client` in `src/index.js`; the privileged intent is already enabled at
  the Discord Developer Portal per this session's earlier work, so this is
  a code-only change, not a new approval).
- A periodic reconciliation sweep (recommended interval: 30 minutes,
  matching the existing `atlasRefresher`/`startScheduler` pattern in
  `src/atlasRefresh.js`/`src/scheduler.js`) that walks every linked
  character from scratch. This is what makes the softened fail-closed rule
  actually safe: a sweep on reconnect after any outage re-establishes
  ground truth without ever needing to guess.

**New local state** (mentat's own SQLite, additive to `database.js`'s
existing `SCHEMA` string — matches this project's own established
per-repo persistence convention, not a new mechanism):

```
enforcement_status (
  player_controller_id TEXT PRIMARY KEY,   -- from the existing link table
  discord_user_id      TEXT NOT NULL,
  verified              INTEGER NOT NULL,   -- 0/1, current believed status
  last_checked_at       TEXT NOT NULL,      -- ISO timestamp of last successful check
  last_transition_at    TEXT NOT NULL       -- when `verified` last actually changed
)
```

`verified` is the field the softened fail-closed rule reads: a row that
exists with `verified = 1` stays trusted even if a later check attempt
throws, until a check actually completes and finds the role gone. A
character with **no row at all** (never successfully checked) is treated
as unverified — true fail-closed, per the operator's choice, only for the
"never established a baseline" case.

**On a status transition** (verified → unverified, or unverified →
verified), mentat calls the new Core write action (section 4.2) via the
existing write-bridge (`adapterClient.js`), signed as the system actor.

### 4.2 Core: the new write action

One new write action, `player.set-backpack-cap`, added to the existing
write-bridge dispatch (same place `player.give-item`/`player.clear-backpack`
live), not a new route or new auth mechanism.

**Params:** `{ characterName, maxItemCount, maxItemVolume }` — mirrors the
existing `player.give-item`-style action shape (character-name-addressed,
matching how every other player action in this bridge already resolves its
target).

**Behavior:** resolves the character the same way `resolvePlayerByName`
already does, then `UPDATE dune.inventories SET max_item_count = $1,
max_item_volume = $2 WHERE actor_id = $pawn_id AND inventory_type = 0`.
Returns the **previous** values in its response.

Mentat is responsible for remembering the previous (real, per-character,
perk-derived) values it received the first time it constrains a character,
and passing them back verbatim when lifting the constraint — Core stays a
simple, stateless read-then-write action; it does not need a new table to
track "what was this character's capacity before we touched it." This
keeps the new game-data snapshot logic in exactly one place (mentat's
existing enforcement-state table gets two more nullable columns,
`restore_max_item_count`/`restore_max_item_volume`, populated on first
constrain).

**Authorization:** `WRITE_ACTION_MIN_TIER["player.set-backpack-cap"]` set to
`"owner"` (matching the existing bar for `player.give-item`/
`clear-backpack` — the other actions that touch inventory contents
directly). The system actor is explicitly allowlisted to pass this check
regardless of the normal Discord-role-derived tier resolution: a single,
narrow, named constant (e.g. `ENFORCEMENT_SYSTEM_ACTOR_ID =
"enforcement-scheduler"`) checked before the normal
`discordActorTier()`/`requireDiscordCapability()` path, analogous to how
this codebase already special-cases `HEALTH`/`CATALOG` as bearer-token-only
routes needing no capability check. Every invocation is still HMAC
actor-signed and still flows through the same `audit()` call every other
write action uses — fully visible in the same audit trail, distinguishable
from a human action only by `actorId` being the fixed system identity.

## 5. Edge cases

- **Character exists but has no `dune.inventories` row yet** (e.g. brand
  new character, first login not yet processed by the game server): the
  write action should return a clear, distinguishable error rather than
  silently no-op or create a row with guessed defaults — mentat should
  retry on the next sweep rather than treating this as a real failure.
- **Un-linking:** per the existing 1:1 model, a player can `/dune player
  unlink`. Their character should immediately re-enter "never checked"
  status for the purposes of this system (no linked Discord account to
  check role membership against at all) — treated the same as
  never-linked, i.e., constrained. This needs an explicit hook wherever
  unlink already happens (`discordPlayerUnlink` in `duneDb.js`), not a
  passive consequence of the sweep alone, or a character could enjoy full
  capacity for up to 30 minutes after intentionally unlinking specifically
  to dodge enforcement.
- **Discord API/gateway outage vs. mentat process outage:** both are
  covered by the same softened fail-closed rule (section 3) — the
  distinction between "Discord is down" and "mentat is down" doesn't need
  separate handling, since both manifest identically as "a check could not
  complete."
- **Multiple guilds:** mentat is multi-tenant. This design assumes
  enforcement is configured per-guild (a guild opts in, names its
  "verified" roles) rather than hardcoded to Chronicles of Kanly's specific
  role IDs — the role *names* (Naib/Fedaykin/Crysknife-Bearer) are specific
  to this one guild's lore theme and must not be hardcoded into mentat's
  shared code.

## 6. Rollback

Turning this off entirely: stop the watcher/sweep, then run a one-time
pass restoring every currently-constrained character's
`restore_max_item_count`/`restore_max_item_volume` via the same write
action. Since Core never overwrites its own "original value" memory (that
lives only in mentat's SQLite), the rollback path depends on mentat's
database surviving — back it up before any risky change to this feature,
same as any other stateful mentat data.

## 7. Feasibility spike (run live, 2026-09-27, against `dune-dev`)

**What was tested:** `UPDATE dune.inventories SET max_item_count = 1,
max_item_volume = 10 WHERE id = <a real character's backpack row>`, on a
row holding 18 real items (stack-size sum 3909), then reverted.

**Confirmed safe:**
- No CHECK constraint or trigger on `dune.inventories` — the write
  succeeds even far below current usage.
- The value persists (re-queried 5+ seconds later, character offline the
  whole time) — nothing auto-reverts it while the game server has the
  character unloaded.
- No existing items were touched, deleted, or altered by the write itself.

**Not yet verified — the real remaining gate before implementation
begins:** what the live game engine does when this character *logs in*
while over its new, lower capacity. Possibilities range from "client just
prevents picking up new items" (fine) to "engine auto-drops overflow
items" (real item loss, unacceptable) to "client desyncs/crashes" (much
worse). This cannot be tested without an actual game client logging in —
nothing about this can be verified via direct database access alone.
**This must be tested with a real login on `dune-dev`, watched directly by
a human, before this design is implemented against real players.** Treat
this as a hard go/no-go gate on the "soft penalty" approach as scoped; if
it fails, the fallback approach (from the brainstorming options considered
and rejected in favor of this one) is repeated `player.clear-backpack`
calls as a blunter stand-in, or a hard kick/ban gate instead.

## 8. Explicitly out of scope for this design

- Any change to the linking/verification mechanism itself (it already
  works).
- Any UI/dashboard for operators to see enforcement status (could be a
  fast-follow; not required for a first version).
- Applying this to any guild other than Chronicles of Kanly's specific
  role names by default (see multi-tenant note in section 5) — the
  mechanism should be generic, but no other guild is in scope for actually
  turning it on.
- Enforcement against anything other than backpack capacity (e.g. base
  storage, vehicle cargo) — explicitly not requested, not designed here.

## 9. Rollout (sketch, not final)

1. File tracking issues (Core + mentat), cross-linked.
2. Run the required login spike (section 7) against `dune-dev`. Go/no-go
   gate.
3. Eight-Hats Layer 1 (design) audit against this document — required by
   Requirement 20 before an implementation plan is written. Not run yet.
4. Implementation (via `writing-plans`, once the above gates pass).
5. Announce the grace period publicly (exact duration: operator's call)
   before flipping enforcement on for existing players.
6. Layer 2 (implementation) and Layer 3 (integration) Eight-Hats audits
   per the normal process, before this ever reaches `dune-prod2`.
