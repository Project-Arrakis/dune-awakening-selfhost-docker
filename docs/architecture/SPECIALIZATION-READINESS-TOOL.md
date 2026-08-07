# Specialization Readiness Tool — Architecture & Design

**Status:** Design (not yet implemented)  
**Issue:** `yacketrj/dune-awakening-selfhost-docker#153`  
**Last updated:** 2026-08-07  
**Depends on:** Nothing (standalone feature — additive to existing Specialization tab)  
**Blocks:** None

---

## 1. Problem Statement

The existing Specialization tab (PR #98, bugfixed in PR #122) provides "Grant Max" and "Grant All Keystones" buttons that write directly to `dune.specialization_tracks` and `dune.purchased_specialization_keystones`. These writes succeed, and the DB rows exist, but a character who has not completed the **8-step unlock chain** required by the game engine will never see specializations in-game (the menu does not appear, the traits are not active, and the game may silently ignore or revert the writes on login).

This was known before the feature shipped (`docs/architecture/SPECIALIZATIONS.md` on branch `feature/specializations`, commit `abad522a`, never merged to `main`) but was not acted on — the shipped code has no readiness check, no warning, and no automated way to complete the prerequisite chain.

## 2. The Unlock Chain

Verified against four independent external sources (method.gg, IGN guides, awakening.wiki, dune.gaming.tools) and confirmed against the official Chapter 3 patch notes (`duneawakening.com`). Each step is annotated with its DB representation:

| Step | Description | DB Representation | Writable? |
|------|-------------|-------------------|-----------|
| 1 | Choose a faction (Atreides or Harkonnen) | `dune.player_faction` | Yes — `dune.change_player_faction(controllerId, factionId, 3, timestamp)` |
| 2 | Earn Faction Level 5 via faction quests | `dune.player_faction_reputation.reputation_amount` (no separate "level" column — level is derived client-side from reputation) | Yes — `dune.set_player_faction_reputation(controllerId, factionId, amount)` |
| 3 | Speak to House Representative (Thufir Hawat in Arrakeen / Piter de Vries in Harko Village) to receive **"House Operator" title** | Unknown. No DB representation found in codebase, journey-tags.json, or 13 distinct player_tags on live DB. Internal doc flags it as "dialog-triggered, not a DB flag." A `DialogueFlags.Factions.HouseOperator` tag *may* exist in the engine but cannot be confirmed without a reference character who has it. | **UNKNOWN** |
| 4 | Join a faction-aligned Guild | `dune.guilds.guild_faction` must match player's faction. `dune.guild_members` must contain the player. Guild membership cannot be forced — the character must join in-game. Faction alignment of an existing guild can be changed only by the guild leader via `dune.pledge_guild_allegiance`. | Partially — alignment only (leader), membership never |
| 5 | Complete faction journey chain (57 nodes under `DA_FQ_ClimbTheRanks`) ending with "The Art of Making Friends" (`DA_FQ_ClimbTheRanks.Rank5To20`) | `dune.journey_story_node` — raw `dune.save_journey_story_node()` SP is callable directly (used by live-refresh sync at `duneDb.js:1056`). The HTTP-facing `completeJourneyNode()` wrapper deliberately blocks story/contract/codex writes (`duneDb.js:4281`). | Yes — via raw SP, bypassing the HTTP wrapper |
| 6 | Receive Landsraad Contracts access tag | `dune.player_tags` — tag `Journey.LandsraadContractsUnlocked` (confirmed from `journey_node_tags` metadata) | Yes — `dune.update_player_tags(characterId, added[], removed[])` |
| 7 | → Landsraad Missions become accessible (L key) | Derived from journey + tags — no separate Landsraad-access DB column | Implicit from steps 5+6 |
| 8 | → Specializations menu accessible (K → G) | Derived from all prior steps — no separate Specialization-access DB column | Implicit from steps 1-7 |

**External confirmation (official patch notes):**
- Chapter 3 (Feb 3, 2026): "You must complete The Art of Making Friends journey as a step to unlock the Landsraad."
- 1.3.5.0 (Feb 17, 2026): "Fixed an issue where some players who reached Rank 5 with a faction were not aligned with it."
- 1.3.0.2 (Feb 5, 2026): "Fixed an issue where some players got demoted from faction rank 5 to rank 4 after the Chapter 3 update."

## 3. DB Schema Reference

All tables, columns, and functions with exact signatures and source line references. Functions marked with `*` are the ones this tool will call; others are for the Diagnose endpoint's read-only queries.

### 3.1 Tables

| Table | Columns (relevant) | Ref |
|-------|-------------------|-----|
| `dune.player_faction` | `actor_id` (bigint), `faction_id` (smallint) | `duneDb.js:1140-1200` (syncChangedPlayerFaction) |
| `dune.player_faction_reputation` | `actor_id` (bigint), `faction_id` (smallint), `reputation_amount` (integer) | `duneDb.js:957-971` (playerFactionReputation) |
| `dune.factions` | `id` (smallint), `name` (text) | `duneDb.js:2291-2310` (playerFactions) |
| `dune.journey_story_node` | `character_id` (bigint), `story_node_id` (text), `override_reward_block` (boolean), `has_pending_reward` (boolean), `complete_condition_state` (jsonb), `reveal_condition_state` (jsonb), `fail_condition_state` (jsonb), `metadata_state` (jsonb), `reset_group` (dune.JourneyStoryResetGroup) | `duneDb.js:1022-1049` (journeySnapshot), `duneDb.js:2127-2148` (journeyIdentitySchema) |
| `dune.player_tags` | `character_id` (bigint), `tag` (text) | `duneDb.js:2131-2138` (journeyIdentitySchema confirms column), verified live with 13 distinct tags |
| `dune.specialization_tracks` | `player_id` (bigint), `track_type` (dune.specializationtracktype), `xp_amount` (integer), `level` (real) | `duneDb.js:1206-1260` (specializationSnapshot) |
| `dune.purchased_specialization_keystones` | `player_id` (bigint), `keystone_id` (bigint) | `duneDb.js:2566-2582` (grantAllSpecializationKeystones) |
| `dune.specialization_keystones_map` | `id` (bigint), `name` (text) | `duneDb.js:2405-2440` (specializationKeystoneCounts) |
| `dune.guilds` | `guild_id` (bigint), `guild_faction` (smallint) | Verified via `information_schema.columns` on live DB (4 columns) |
| `dune.guild_members` | `player_id` (bigint), `guild_id` (bigint), `role_id` (integer) | `duneDb.js:1167-1194` (pledgeGuildAdminFactionIfNeeded) |
| `dune.player_state` | `player_controller_id` (bigint), `online_status` (text) | `duneDb.js:5976-5993` (requireOfflinePlayer, resolvePlayerMutationTarget) |

### 3.2 DB Functions (writable)

| Function | Signature | Source ref | Used by tool? |
|----------|-----------|------------|---------------|
| `dune.change_player_faction` | `(actor_id bigint, faction_id smallint, arg3 smallint, changed_at timestamp)` | `duneDb.js:1200` (syncChangedPlayerFaction calls it) | Yes — Grant |
| `dune.set_player_faction_reputation` | `(actor_id bigint, faction_id smallint, amount integer)` | `duneDb.js:971` (syncChangedPlayerFactionReputation calls it) | Yes — Grant |
| `dune.save_journey_story_node` | `(account_id bigint, story_node_id text, override_reward_block boolean, has_pending_reward boolean, complete_condition_state jsonb, reveal_condition_state jsonb, fail_condition_state jsonb, metadata_state jsonb, reset_group dune.JourneyStoryResetGroup)` | `duneDb.js:1056-1072` (syncChangedJourneyNodes calls it directly) | Yes — Grant |
| `dune.delete_journey_story_node` | `(account_id bigint, story_node_id text)` | `duneDb.js:1073-1075` (syncChangedJourneyNodes calls it) | No (only used for reset, out of scope) |
| `dune.update_player_tags` | `(account_id bigint, added_tags text[], removed_tags text[])` | `duneDb.js:1112` (syncChangedPlayerTags calls it) | Yes — Grant |
| `dune.pledge_guild_allegiance` | `(guild_id bigint, actor_id bigint, faction_id smallint)` | `duneDb.js:1189` (pledgeGuildAdminFactionIfNeeded calls it) | Yes — Grant (conditional on guild leader) |
| `dune.set_specialization_xp_and_level` | `(player_id bigint, track_type dune.specializationtracktype, xp integer, level real)` | `duneDb.js:1257` (syncChangedSpecializations calls it) | Yes — Grant (via grantMaxSpecialization wrapper) |

### 3.3 Existing Console Functions (reused)

| Function | Signature | Ref |
|----------|-----------|-----|
| `grantAllSpecializationKeystones` | `(db, id)` | `duneDb.js:2566` |
| `grantMaxSpecialization` | `(db, id, { trackType })` | `duneDb.js:2524` |
| `addSpecializationXp` | `(db, id, { trackType, amount })` | `duneDb.js:2489` |
| `resetSpecialization` | `(db, id, { trackType })` | `duneDb.js:2545` |
| `resolvePlayerMutationTarget` | `(tx, playerId)` | `duneDb.js:640` |
| `requireOfflinePlayer` | `(player, actionName)` | `duneDb.js:5976` — throws if player is online |
| `specializationTrackTypes` | `(db)` → `Promise<string[]>` | `duneDb.js:1213` — returns `["Combat","Crafting","Exploration","Gathering","Sabotage"]` |
| `playerJourney` | `(db, id, journeyTagsData)` → journey rows grouped by category | `duneDb.js:3664` |
| `playerFactions` | `(db, id)` → `[{faction_id, faction_name, reputation_amount}]` | `duneDb.js:2291` |

### 3.4 Existing HTTP Route Pattern

All specialization mutations follow the same pattern in `server.js:563-567`:

```js
if (path.match(/^\/api\/players\/[^/]+\/specializations\/...$/) && req.method === "POST")
  return playerDbMutation(req, res, path, "audit.key", "ACTION LABEL",
    (playerId, body) => duneDb.someFunction(db, playerId, body));
```

`playerDbMutation` handles JSON parsing, offline-player enforcement, error framing, and audit logging. The new routes should use the same pattern.

## 4. Journey Dependency Tree

The full `DA_FQ_ClimbTheRanks` tree (57 nodes) is defined in `runtime/data/journey-tags.json` under `journey_children`. Key milestones:

```
DA_FQ_ClimbTheRanks (root)
├── JoinAHouse → StrikeADeal → (TalkToARecruiter, GetSpyMission, FindTheSpy)
│             → ProveYourself → (Rank1Contracts, ChooseASide)
├── ATestOfLoyalty → GetMaximToBackOff → FindSemuta
├── ATestOfTreachery → GetAntonToBackOff → FindCounterfeitEvidence
├── ClimbTheRanksR2 → ContributeToWarEffort_Atreides → CompleteContractsR2
├── InvestigateKytheria_Atreides → InvestigateWreck_Atreides → (Complete Track Down Skorda Contract, MeetAndreaGanan)
├── InvestigateKytheria_Harkonnen → InvestigateWreck_Harkonnen → (Complete Track Down Skorda Contract, MeetSimoneVonKonig)
├── GatheringIntelligence → TrackDownContainer → (InvestigateSandflies, TrackDownPilot, TrackDownRedScorpion, FindCanister)
├── PoisonedSpice_Atreides → PutFindingsToTest → (SpeakWithGanan, MeetThufir, ReturnToGanan)
│                       → PunishTraitor → (FindBusinessman, ChoosePoisonOrSpare, CompleteWarProfiteerContract, TalkToThufirAgain)
├── PoisonedSpice_Harkonnen → LeverageYourFindings → (SpeakWithVonKonig, MeetPiter, ReturnToVonKonig, DeliverResults)
│                          → TakeALeap → (PoisonOrWarnPiter, TalkToPiterAgain)
├── HuntingSkorda → FindSkorda → (SkordaInArrakeen, SkordaInMysaTarrill, SkordaInOodham)
├── InvestigateDelphis_Atreides → DeviseAPlan_Atreides → TellThufirAboutDelphis
│                              → SecureLastContainer_Atreides → RecoverSheolContainer_Atreides
│                              → PledgeAllegiance_Atreides → PledgeAllegiance_Atreides_Sub
├── InvestigateDelphis_Harkonnen → DeviseAPlan_Harkonnen → TellPiterAboutEuporia
│                               → SecureLastContainer_Harkonnen → RecoverSheolContainer_Harkonnen
│                               → PledgeAllegiance_Harkonnen → PledgeAllegiance_Harkonnen_Sub
├── TransitionToCh3_Hark → TheCall → AnswerTheCall   [TAG: DialogueFlags.Factions.CannotBetray]
├── TransitionToCh3_Atre → TheCall → AnswerTheCall   [TAG: DialogueFlags.Factions.CannotBetray]
├── Rank5To20 → MeetSponsor → TalkToSponsor           [TAG: DialogueFlags.Factions.CannotBetray]
│            → StartLandsraadOnboarding → ReportToMasterOfAssassins  [TAG: Journey.LandsraadContractsUnlocked]
│            → CompleteLandsraadMission → CompleteOnboardingJourney1
│            → CraftAugmentation → CompleteOnboardingJourney2
│            → ReachRank20 → GrindRanks               [TAG: DialogueFlags.Factions.CannotBetray]
├── Rank20_Mission_Harkonnen → Ch3Mission → (GetCallForMission, GetMission, CompleteMission)
├── Rank20_Mission_Atreides → Ch3Mission → (GetCallForMission, GetMission, CompleteMission)
├── BetrayTheAtreides → Complete The Betrayal → Complete The Contract
└── BetrayTheHarkonnen → Complete The Betrayal → Complete The Contract
```

The grant endpoint must complete ALL nodes in dependency order (leaf nodes first, then parents), because the game engine may validate parent completion when a child node is written. The complete ordered list (57 nodes) is derived by a topological sort of the `journey_children` map — the implementation prompt includes the exact algorithm and JSON data source.

For each node, the `save_journey_story_node` call uses these parameters:

```js
dune.save_journey_story_node(
  characterId,           // bigint
  nodeId,                // text — full dotted path, e.g. "DA_FQ_ClimbTheRanks.JoinAHouse.StrikeADeal.FindTheSpy"
  false,                 // override_reward_block — boolean
  false,                 // has_pending_reward — boolean
  'true',                // complete_condition_state — jsonb (as 'true'::jsonb, i.e. the JSON boolean true)
  'true',                // reveal_condition_state — jsonb
  '{}',                  // fail_condition_state — jsonb
  '{}',                  // metadata_state — jsonb
  'None'                 // reset_group — dune.JourneyStoryResetGroup enum
)
```

**Important:** The `complete_condition_state` must be the JSON value `true` (not the string `"true"`). In SQL: `'true'::jsonb`. In pg driver parameterized queries, pass the JavaScript boolean `true` and let the driver serialize it. The journey tracking code compares `complete_condition_state = 'true'::jsonb` (confirmed at `duneDb.js:1022-1049`, `playerJourney` at `duneDb.js:3677-3736`).

### 4.1 Player Tags to Add

From `journey_node_tags` metadata and verified live DB values:

| Tag | Purpose | When to add |
|-----|---------|-------------|
| `Journey.LandsraadContractsUnlocked` | Unlocks Landsraad mission access | Added when `Rank5To20.StartLandsraadOnboarding.ReportToMasterOfAssassins` is completed |
| `Journey.RewardsUnblocked` | Unblocks journey reward claiming | Added after all Rank5To20 sub-nodes are complete |
| `DialogueFlags.Factions.SeenAnvilCinematic` | Marks the Anvil cutscene as watched | Added when `JoinAHouse.StrikeADeal.TalkToARecruiter` is written |
| `BigMoments.Base.Complete` | Base construction completed | Added after chapter transition nodes are complete |
| `DialogueFlags.Factions.CannotBetray` | Prevents faction betrayal (locks the choice) | Already set as metadata tags on specific nodes; the game engine may set this automatically when those nodes complete. Not explicitly written by the tool — added only if observed missing on a real reference character. |

**Note:** The full set of tags the game engine expects for each milestone is unknown. The tags above are the minimum set derived from `journey_node_tags` metadata and live DB observation. The test character validation (Section 8) will reveal any missing tags — iterate and add them based on empirical results.

## 5. Endpoint Design

### 5.1 `GET /api/players/:id/specializations/readiness`

**Route:** `GET /api/players/:id/specializations/readiness`

**Purpose:** Read-only. Returns a checklist of every prerequisite step and whether the character meets it. Never writes.

**Response shape:**

```json
{
  "ok": true,
  "player": {
    "playerId": "123",
    "playerName": "...",
    "isOnline": false
  },
  "checklist": {
    "faction_assigned": {
      "status": "met",
      "detail": "Atreides (faction_id=1)"
    },
    "faction_level_5": {
      "status": "not_met",
      "detail": "reputation=0, needs >=5000 (estimated threshold)"
    },
    "house_operator": {
      "status": "unknown",
      "detail": "No DB representation found for the House Operator title — must be earned in-game by speaking to Thufir Hawat (Atreides) or Piter de Vries (Harkonnen)"
    },
    "guild_aligned": {
      "status": "not_met",
      "detail": "No guild membership found"
    },
    "journey_completion": {
      "status": "partial",
      "completed_nodes": 0,
      "total_nodes": 57,
      "detail": "0 of 57 DA_FQ_ClimbTheRanks journey nodes complete"
    },
    "tags_present": {
      "missing": ["Journey.LandsraadContractsUnlocked"],
      "detail": "1 required tag(s) not found in player_tags"
    },
    "specializations_accessible": {
      "status": "not_met",
      "detail": "Journey chain + Landsraad access not complete"
    }
  },
  "overall": "not_ready"
}
```

**Implementation notes:**
- Query `player_faction` to check faction assignment
- Query `player_faction_reputation` to check reputation amount
- Query `journey_story_node` filtered to `DA_FQ_ClimbTheRanks%` — count `complete_condition_state = 'true'::jsonb`
- Query `player_tags` for known required tags
- Query `guild_members` + `guilds.guild_faction` for guild alignment
- The `specializations_accessible` field is a derived summary — true ONLY if all prior steps are met (or unknown)
- `overall` is `"ready"`, `"not_ready"`, or `"unknown"` (when one or more steps have status `"unknown"`)

### 5.2 `POST /api/players/:id/specializations/grant-prerequisites`

**Route:** `POST /api/players/:id/specializations/grant-prerequisites`

**Purpose:** One-call grant of ALL writable prerequisites + specialization keystones + maxed tracks. Runs in a single DB transaction — all succeed or all roll back.

**Request body:**

```json
{
  "faction": "Atreides"
}
```

Valid values: `"Atreides"` (→ faction_id = 1) or `"Harkonnen"` (→ faction_id = 2).

**Transaction steps (in order):**

```
1. Validate player exists and is OFFLINE (requireOfflinePlayer)
2. Resolve faction choice → faction_id (1 or 2)
3. Change player faction: dune.change_player_faction(controllerId, factionId, 3, now())
4. Set faction reputation: dune.set_player_faction_reputation(controllerId, factionId, 5000)
5. For each of the 57 journey nodes in topological order:
   dune.save_journey_story_node(characterId, nodeId, false, false, true, true, {}, {}, 'None')
6. Update player tags: dune.update_player_tags(characterId, [requiredTags], [])
7. If player is guild leader of a guild whose guild_faction ≠ player faction:
   dune.pledge_guild_allegiance(guildId, actorId, factionId)
8. Grant all specialization keystones: grantAllSpecializationKeystones(tx, playerId)
9. For each of the 5 tracks (Combat, Crafting, Exploration, Gathering, Sabotage):
   grantMaxSpecialization(tx, playerId, { trackType })
10. Return response
```

If ANY step fails, the entire transaction rolls back.

**Faction reputation threshold:** 5000 is used as the default. This was chosen because:
- No character on the live server has any faction reputation (confirmed via `SELECT * FROM dune.player_faction_reputation WHERE reputation_amount > 0` → 0 rows), so the actual "Level 5" threshold cannot be measured from live data
- Faction ranks go 1–20 (Chapter 3 patch notes), so Level 5 is ~25% of the maximum, suggesting a moderate reputation value
- 5000 is high enough to be "definitely Level 5" on any reasonable scale while not being implausibly high for a private-server admin tool
- The value should be configurable via an optional `reputation` field in the request body

**Response shape:**

```json
{
  "ok": true,
  "player": {
    "playerId": "123",
    "playerName": "...",
    "faction": "Atreides"
  },
  "done": {
    "faction_assigned": true,
    "faction_reputation_set": 5000,
    "journey_nodes_completed": 57,
    "tags_added": ["Journey.LandsraadContractsUnlocked", "Journey.RewardsUnblocked", "DialogueFlags.Factions.SeenAnvilCinematic"],
    "specialization_keystones_granted": true,
    "specialization_tracks_maxed": 5,
    "guild_aligned": false
  },
  "requires_manual": {
    "house_operator_title": "Speak to Thufir Hawat in Arrakeen (Atreides) or Piter de Vries in Harko Village (Harkonnen) to receive the 'House Operator' title — required for Landsraad access",
    "guild_membership": "Join a faction-aligned guild in-game — guild membership cannot be forced via the console"
  },
  "message": "All writable prerequisites granted. The player must relog to see changes. 2 manual steps remain."
}
```

## 6. Risk Analysis (Eight Hats)

### Principal Software Architect
- **Risk:** Transaction spans 57 journey-node writes + faction writes + specialization writes — large single transaction.
- **Mitigation:** Each step is idempotent (ON CONFLICT DO NOTHING, REPLACE, or INSERT-then-safe-update). Rollback safety: if step 55 fails, steps 1-54 roll back, leaving the character in their original state.
- **Blast radius:** One character. No server-wide state. Only affects the specific player ID requested.
- **Pattern fit:** Uses the existing `playerDbMutation` pattern exactly. No new architectural concepts.

### Principal Security Architect
- **Threat model:** A console operator deliberately writing faction/journey state to a character. This is an admin action — the threat is misuse, not external attack.
- **Gating:** Console web UI only (requires admin login session). Not exposed via Discord adapter.
- **Audit trail:** `playerDbMutation` logs every action with player ID, action name, and result to the audit log.
- **Secret handling:** None. No new credentials, tokens, or API keys.

### Principal GRC
- **Documentation currency:** This document is the evidence bundle. Must be committed before the PR merges.
- **Risk classification:** HIGH — touches faction and journey tables flagged as EXTREME RISK by prior internal research.
- **Required evidence before merge:**
  1. This design document committed to `main`
  2. Unit tests passing (db.test.js additions)
  3. Integration test: Diagnose + Grant executed against a real throwaway character on this host
  4. In-game verification: log in with the test character, confirm Landsraad (L) and Specializations (K→G) are accessible
  5. CI green on the PR

### Principal Network Engineer
- No new network bindings, no new ports, no new outbound calls.
- All writes are local DB operations within the existing console → Postgres connection.

### Principal Cloud Security Engineer
- No cloud changes. No IAM, API tokens, or external service calls.
- The tool operates entirely within the existing console ↔ Postgres trust boundary.

### Principal UI Design/Architect
- New UI surface: one "Check Readiness" button + readiness panel in SpecializationTab; one "Grant All Prerequisites" button with confirmation dialog.
- Must follow existing SpecializationTab patterns: same button styling, same offline-required notice, same error/success messaging.
- Must be honest about what was automated vs requires manual steps — the response's `requires_manual` fields must be rendered clearly to the operator.

### Principal DBA
- No schema changes. All writes use existing tables and columns.
- Reuses existing DB functions — no new stored procedures or migrations.
- `save_journey_story_node` uses ON CONFLICT semantics (confirmed by the live-refresh sync code which calls it idempotently at `duneDb.js:1056`).
- `update_player_tags` handles add/remove atomically — no risk of partial tag state.

### Principal QA/Test
- **Unit tests:** `console/api/test/db.test.js` — mock DB, verify readiness response shape, verify grant transaction calls.
- **Integration test:** Separate test file or extended db.test.js — test the full Diagnose + Grant flow with a mock player and journey data.
- **Empirical validation:** The ONLY way to verify this works end-to-end is against a real character on this host. The closed-source game server's behavior can't be mocked. See Section 8.
- **CI gate:** Tests must pass. CI must be green on the PR.

## 7. Honest Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| House Operator title has no known DB representation | Character may still not unlock Landsraad if the engine checks for this state | Report as `requires_manual` in the grant response. Iterate if a reference character reveals the real DB flag. |
| Guild membership cannot be forced | Non-guilded characters must join a guild in-game | Report as `requires_manual` in the grant response |
| Faction reputation threshold is estimated (5000) | May be too low to reach Level 5, or unnecessarily high | Configurable via request body. Adjust after empirical testing. |
| Engine-side state unknown | The game server may check flags, caches, or FLS data not visible in our DB | The test-character validation (Section 8) is the only way to detect this. Leave the tool honest about what it can't verify. |
| Journey node `save_journey_story_node` may trigger server-side logic that reverts or ignores DB-only writes | The internal doc warned: "even if we write to specialization_tracks, the game engine validates journey state on login" | Test empirically. If writes are reverted on login, the tool is not viable without game-server cooperation. |

## 8. Test Plan (Empirical Validation)

### 8.1 Unit Tests (in repo)

- `console/api/test/db.test.js` additions:
  - `readiness` endpoint: mock player with no faction/journey/keystones → all checklist items `not_met`
  - `readiness` endpoint: mock player with full chain → all checklist items `met`, `overall: "ready"`
  - `grant-prerequisites` endpoint: mock player offline → transaction succeeds, all writes called in order
  - `grant-prerequisites` endpoint: mock player online → error thrown before any writes
  - `grant-prerequisites` endpoint: mock DB failure at step 5 → transaction rolls back, no partial state
  - `grant-prerequisites` endpoint: mock guild leader → guild_aligned = true in response

### 8.2 Integration Test (on this host, before merge)

**Prerequisite:** A throwaway character on this server (controlled via the console — this is a private server with full admin access).

**Procedure:**

1. Create or identify a fresh character (no faction, no journey progress, no specialization data).
2. Call `GET /api/players/{id}/specializations/readiness` — confirm all fields show `not_met`, `overall: "not_ready"`.
3. Call `POST /api/players/{id}/specializations/grant-prerequisites` with `{"faction": "Atreides"}` — confirm response shows all writes succeeded, 2 manual items.
4. Call `GET /api/players/{id}/specializations/readiness` again — confirm `faction_assigned: met`, `faction_level_5: met`, `journey_completion: {completed_nodes: 57, status: "met"}`, `tags_present: {missing: []}`, `specializations_accessible: "met"`.
5. Log in to the game with the test character.
6. Verify the Specializations menu is accessible (press K, check for Specializations button bottom-left, press G).
7. Verify the Landsraad menu is accessible (press L).
8. If step 6 or 7 fails: diagnose which step failed, add the missing tag/state, iterate from step 2.

**This step is a merge blocker.** Do not merge the PR until one real character on this host has been verified end-to-end. The closed-source game engine is the ultimate arbiter — no amount of code review can substitute for this.

## 9. Appendix — Implementation Prompt

The following is a self-contained implementation prompt for a coding LLM. It includes all context, exact function signatures, file paths, line numbers, and test shapes required to produce working code without guessing.

---

### IMPLEMENTATION PROMPT START

```
You are implementing a Specialization Readiness Tool for a Dune Awakening
self-hosted server console. This tool adds two endpoints and a small UI
panel to the existing Specialization tab.

## Context

The console at ~/projects/dune/dune-awakening-selfhost-docker already has
a Specialization tab (console/web/src/features/players/SpecializationTab.tsx,
444 lines) with buttons to grant keystones and max XP. But granting
specializations to a character who hasn't completed the faction journey
chain (57 journey nodes under DA_FQ_ClimbTheRanks in
dune.journey_story_node) silently fails — the specializations never
become usable in-game because the engine checks journey state on login.

The full design is in docs/architecture/SPECIALIZATION-READINESS-TOOL.md.
Read that first if available.

## What to Build

### 1. New duneDb function: readSpecializationReadiness(db, playerId)
Read-only. Returns a readiness object (same shape as the GET response below).

### 2. New duneDb function: grantSpecializationPrerequisites(db, playerId, { faction })
One transaction that:
  a. Validates player is offline (requireOfflinePlayer)
  b. Resolves faction string → faction_id (Atreides=1, Harkonnen=2)
  c. Changes player faction via dune.change_player_faction(controllerId, factionId, 3, now()::timestamp)
  d. Sets faction reputation via dune.set_player_faction_reputation(controllerId, factionId, 5000)
  e. Completes all 57 DA_FQ_ClimbTheRanks journey nodes via dune.save_journey_story_node
  f. Adds required player tags via dune.update_player_tags
  g. If player is guild leader and guild_faction != player faction: pledges allegiance
  h. Grants all specialization keystones via grantAllSpecializationKeystones
  i. Grants max specialization on all 5 tracks via grantMaxSpecialization
  j. Returns what was done + what requires manual intervention

### 3. Server route: GET /api/players/:id/specializations/readiness
Exact response shape from the design doc Section 5.1.
Uses existing playerDbMutation or a new read-only route helper.

### 4. Server route: POST /api/players/:id/specializations/grant-prerequisites
Exact response shape from the design doc Section 5.2.
Uses the existing playerDbMutation pattern (line 563-567 in server.js).

### 5. UI: Readiness button + panel in SpecializationTab.tsx
Add a "Check Readiness" button below the existing "Grant All Keystones"
button. Clicking it calls GET readiness and renders the checklist below
the specialization table. Show status badges (met/not_met/unknown) for
each step.

Add a "Grant All Prerequisites + Specializations" button. Clicking it
shows a confirmation dialog listing what will be automated and what
requires manual intervention. On confirm, calls POST grant-prerequisites.
Shows the result (InfluxActionResult component is already imported).

### 6. UI: playersApi additions
Add two functions to console/web/src/api/players.ts:
  - fetchSpecializationReadiness(playerId) → Promise<ReadinessResponse>
  - grantSpecializationPrerequisites(playerId, faction) → Promise<GrantResponse>

### 7. Tests
Add to console/api/test/db.test.js (or a new test file):
  - Readiness: mock player with nothing → all fields not_met
  - Readiness: mock player with full chain → all fields met, overall ready
  - Grant: mock offline player → all writes called in order, response correct
  - Grant: mock online player → error thrown before any writes
  - Grant: mock DB failure mid-transaction → rollback, no partial state
  - Grant: mock guild leader → guild_aligned = true in response

## Exact DB Function Signatures

dune.change_player_faction(bigint, smallint, smallint, timestamp)
  → (actor_id, faction_id, 3, changed_at)
  Called at: duneDb.js:1200

dune.set_player_faction_reputation(bigint, smallint, integer)
  → (actor_id, faction_id, amount)
  Called at: duneDb.js:971

dune.save_journey_story_node(bigint, text, boolean, boolean,
  jsonb, jsonb, jsonb, jsonb, dune.JourneyStoryResetGroup)
  → (account_id, story_node_id, override_reward_block,
     has_pending_reward, complete_condition_state,
     reveal_condition_state, fail_condition_state,
     metadata_state, reset_group)
  Called at: duneDb.js:1056-1072

dune.update_player_tags(bigint, text[], text[])
  → (account_id, added_tags, removed_tags)
  Called at: duneDb.js:1112

dune.pledge_guild_allegiance(bigint, bigint, smallint)
  → (guild_id, actor_id, faction_id)
  Called at: duneDb.js:1189

## Journey Node Completion Parameters

For EACH of the 57 nodes, call:

db.query(
  `select dune.save_journey_story_node($1::bigint, $2::text,
    $3::boolean, $4::boolean, $5::jsonb, $6::jsonb, $7::jsonb,
    $8::jsonb, $9::dune.JourneyStoryResetGroup)`,
  [characterId, nodeId, false, false, true, true, {}, {}, 'None']
)

Where:
  - characterId comes from resolvePlayerMutationTarget → player.characterId
    (or the identity column detected by journeyIdentitySchema)
  - nodeId is the full dotted path, e.g. "DA_FQ_ClimbTheRanks.JoinAHouse.StrikeADeal.FindTheSpy"
  - true for complete_condition_state/reveal_condition_state means the
    JSON boolean true ('true'::jsonb), NOT the string "true"
  - {} for fail_condition_state/metadata_state means empty JSON objects
  - 'None' is the dune.JourneyStoryResetGroup enum value

## Complete Node List (57 nodes in topological order)

Process leaf nodes first, then parents. The exact ordered list comes from
a topological sort of runtime/data/journey-tags.json's journey_children
map. Your code should read that JSON file and compute the order, not
hardcode the list. Reference implementation:

```js
function orderedJourneyNodes() {
  const data = JSON.parse(readFileSync(resolve(repoRoot, "runtime/data/journey-tags.json"), "utf8"));
  const children = data.journey_children || {};
  const root = "DA_FQ_ClimbTheRanks";
  // BFS/DFS to collect all nodes, then reverse for leaf-first order
  const all = new Set();
  function walk(node) {
    all.add(node);
    (children[node] || []).forEach(walk);
  }
  walk(root);
  // Topological: leaves first. Sort by depth (deepest first).
  function depth(node, d = 0) {
    const kids = children[node] || [];
    return kids.length === 0 ? d : Math.max(...kids.map(k => depth(k, d + 1)));
  }
  return [...all].sort((a, b) => depth(b) - depth(a));
}
```

## Player Tags to Add

Required tag set:
  ['Journey.LandsraadContractsUnlocked',
   'Journey.RewardsUnblocked',
   'DialogueFlags.Factions.SeenAnvilCinematic']

Add via: db.query("select dune.update_player_tags($1::bigint, $2::text[], $3::text[])",
  [characterId, requiredTags, []])

Note: the exact identity column name (character_id vs account_id) is
auto-detected by journeyIdentitySchema(). The player object from
resolvePlayerMutationTarget has both .playerStateId (character_id)
and .accountId. Use the one that matches journeyIdentitySchema's
detected column.

## Speculation Track Types

The 5 valid tracks (from specializationTrackTypes, duneDb.js:1213):
  ['Combat', 'Crafting', 'Exploration', 'Gathering', 'Sabotage']

For grantMaxSpecialization, call once per track:
  grantMaxSpecialization(tx, playerId, { trackType: track })

## Guild Alignment Logic

Check if player is a guild leader:
  SELECT gm.guild_id, coalesce(g.guild_faction, 3)::int as guild_faction
  FROM dune.guild_members gm
  JOIN dune.guilds g ON g.guild_id = gm.guild_id
  WHERE gm.player_id = $1 AND gm.role_id = <GUILD_LEADER_ROLE_ID>

GUILD_LEADER_ROLE_ID is a constant already defined in duneDb.js
(used by pledgeGuildAdminFactionIfNeeded at line 1178). Reuse that
constant — do not redefine it.

If a guild row is found AND guild_faction != player's factionId:
  SELECT dune.pledge_guild_allegiance($1::bigint, $2::bigint, $3::smallint)
  (guild_id, actor_id, faction_id)

## Offline-Only Gate

Use requireOfflinePlayer(player, "Specialization prerequisite grants")
— this is the same function used by grantAllSpecializationKeystones at
duneDb.js:2570. The player object comes from resolvePlayerMutationTarget.

## Server Route Pattern

Add routes in server.js adjacent to the existing specialization routes
(at line 566-567). The existing routes match this pattern:

/matches: /api/players/<id>/specializations/keystones/grant-all
/matches: /api/players/<id>/specializations/grant-max
/matches: /api/players/<id>/specializations/add-xp

Add:

/matches: /api/players/<id>/specializations/readiness
  (GET — read-only, use dbPlayerRoute or a custom handler)
/matches: /api/players/<id>/specializations/grant-prerequisites
  (POST — use playerDbMutation pattern)

The grant-prerequisites route label should be:
  audit key: "players.specializations.grant-prerequisites"
  action label: "GRANT SPECIALIZATION PREREQUISITES"

The readiness route can use the simpler dbPlayerRoute pattern used for
GET routes, e.g. line 582: /api/players/<id>/specializations matches
  GET → dbPlayerRoute(res, path, (db, playerId) => duneDb.readSpecializationReadiness(db, playerId))

## UI Changes in SpecializationTab.tsx

1. Add a new state variable: const [readiness, setReadiness] = useState(null)
2. Add "Check Readiness" button after the keystone action buttons
3. On click: fetch readiness, store in state
4. Render a readiness panel below the specialization table when readiness !== null
   - Show each checklist item with a status badge
   - Show overall status prominently
5. Add "Grant All Prerequisites + Specializations" button
   - Disabled if readiness shows player is online
   - On click: confirmation dialog listing what will be automated vs manual
   - On confirm: call grantSpecializationPrerequisites, show result
6. Use existing components: InfluxActionResult for feedback, existing button styles

## playersApi Additions (console/web/src/api/players.ts)

Add TypeScript types and API functions:

```ts
export type ReadinessChecklistItem = {
  status: "met" | "not_met" | "unknown" | "partial";
  detail: string;
  completed_nodes?: number;
  total_nodes?: number;
  missing?: string[];
};

export type ReadinessResponse = {
  ok: boolean;
  player: { playerId: string; playerName: string; isOnline: boolean };
  checklist: Record<string, ReadinessChecklistItem>;
  overall: "ready" | "not_ready" | "unknown";
};

export function fetchSpecializationReadiness(playerId: string): Promise<ReadinessResponse> {
  return apiGet(`/api/players/${encodeURIComponent(playerId)}/specializations/readiness`);
}

export type GrantPrerequisitesRequest = { faction: "Atreides" | "Harkonnen" };

export type GrantPrerequisitesResponse = {
  ok: boolean;
  player: { playerId: string; playerName: string; faction: string };
  done: Record<string, unknown>;
  requires_manual: Record<string, string>;
  message: string;
};

export function grantSpecializationPrerequisites(
  playerId: string,
  body: GrantPrerequisitesRequest
): Promise<GrantPrerequisitesResponse> {
  return apiPost(`/api/players/${encodeURIComponent(playerId)}/specializations/grant-prerequisites`, body);
}
```

Use the existing apiGet/apiPost helpers from the same file
(already used by fetchSpecializations and other functions in players.ts).

## Constraints — What NOT to Change

1. Do NOT modify the existing completeJourneyNode / resetJourneyNode
   functions at duneDb.js:4281-4287 — they deliberately block
   story/contract/codex progression for good reason. The new function
   calls dune.save_journey_story_node directly, which is the same
   path the live-refresh sync uses.

2. Do NOT change the existing grantAllSpecializationKeystones,
   grantMaxSpecialization, addSpecializationXp, or resetSpecialization
   functions. The new tool calls them as-is.

3. Do NOT modify the Discord adapter OPS routes (#152 is a separate
   issue). No changes to opsProvider.js, adapterClient.js, or the
   stats pipeline.

4. Do NOT touch sietches/battlegroups fields or the live-stats
   aggregation pipeline (#95 is a separate issue).

5. Do NOT change the journey-tags.json file.

6. Do NOT add a new npm dependency.

7. The readiness endpoint is read-only. It must NEVER write to the DB.

8. All new code must follow the existing code conventions:
   - duneDb functions: async, parameterized queries, requireCapability
     for schema feature checks
   - Server routes: path.match() regex pattern, playerDbMutation for
     mutations, dbPlayerRoute for reads
   - UI: React functional components, useState hooks, existing component
     library

## File List (files you should create or modify)

MODIFY:
  console/api/src/duneDb.js — add readSpecializationReadiness,
    grantSpecializationPrerequisites
  console/api/src/server.js — add two routes
  console/web/src/api/players.ts — add API functions and types
  console/web/src/features/players/SpecializationTab.tsx — add
    readiness panel and grant button

CREATE (if not adding to existing test file):
  console/api/test/specialization-readiness.test.js — unit tests

DO NOT MODIFY any other files.

## Implementation Order

1. duneDb.js: readSpecializationReadiness (read-only, no risk)
2. duneDb.js: grantSpecializationPrerequisites (writable, in transaction)
3. server.js: readiness GET route
4. server.js: grant-prerequisites POST route
5. players.ts: API functions + types
6. SpecializationTab.tsx: UI
7. Tests

After implementation, run:
  npm test -- --testPathPattern="specialization"
  npx tsc --noEmit (in console/web/ for TypeScript)
```

### IMPLEMENTATION PROMPT END

---

## 9.1 Additional Implementation Notes (Not Part of the LLM Prompt)

The prompt above is self-contained and can be handed to a coding LLM. However, a human implementer should also be aware of:

- The `resolvePlayerMutationTarget` function returns a player object with `.playerStateId` (maps to `character_id`) and `.accountId`. Journey functions use the column detected by `journeyIdentitySchema()` — auto-detect this at runtime rather than hardcoding `character_id`.

- The live-refresh framework (`withKnownLiveRefresh`) wraps writes that need to sync live state — specialization writes use it, journey writes in `syncChangedJourneyNodes` do NOT (they're batch-sync). For a one-off admin tool, calling `save_journey_story_node` directly without the live-refresh wrapper is correct — the player is offline and there's nothing to live-sync.

- `grantMaxSpecialization` already enforces offline-only and uses live-refresh. When called inside our transaction, it will work correctly because the transaction context (`tx`) is passed through.

- The `journey-tags.json` file is ~32KB. Reading it synchronously at module load time (like `journeyTagsData` is already loaded at `server.js:78`) is acceptable — it's loaded once, not per-request.

- Test fixtures for `db.test.js` must mock the `journey_story_node` table, `player_tags`, `player_faction`, `player_faction_reputation`, `guilds`, and `guild_members` — the existing test infrastructure at `console/api/test/db.test.js` already has a mock DB setup for similar tables (see test at line 1609 which mocks `tableExists` for `specialization_tracks`, `player_faction`, etc.).
