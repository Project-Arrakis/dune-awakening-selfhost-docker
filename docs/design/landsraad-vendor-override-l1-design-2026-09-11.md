# Landsraad Special Vendor Override — L1 Design

**Date:** 2026-09-11 (revised same day to incorporate Layer 1 Eight-Hats audit findings — see §7)
**Tracking issue:** [Project-Arrakis/dune-awakening-selfhost-docker#907](https://github.com/Project-Arrakis/dune-awakening-selfhost-docker/issues/907)
**Status:** L1 design, drafted through a research/brainstorming dialogue with the operator (architectural path). A real, dispatched Eight-Hats audit (8 independent agent reviews, not a solo pass) has been run against the first draft of this document; every CRITICAL/HIGH finding has been resolved directly in the sections below, not deferred. See §7 for the full findings register, STRIDE table, and resolution status.
**Scope:** a new "Special Vendor Override" section inside the existing Core admin-console **Landsraad** tab (`console/web/src/features/landsraad/LandsraadPanel.tsx`) that lets an operator force one of the four Landsraad "Special Vendor" decrees active for the current term, independent of whether any house has organically won that term.
**Explicitly out of scope (v1):** forcing `winning_faction_id`/`reigning_faction_id` (see §2.1 for why this may limit v1's real-world effect, and the go/no-go gate that follows from it); anything about which specific *house* benefits; any change to Landsraad voting/decree-rotation mechanics; an upstream PR to Red-Blink (§6).

---

## 1. Problem statement

The Landsraad "Special Vendor" NPCs (Vehicles, Weapons, Armor, Utilities — sold at Harko Village / Arrakeen per community documentation) only become available once a house's elected decree for the current term becomes that term's *active* decree, which normally requires that house to win the term. Confirmed directly against live data on `dune-dev` (`docker exec dune-postgres psql -U dune -d dune`), independently re-confirmed by the Security Architect and DBA audit hats: **every** historical Landsraad term on this server (not just a recent sample) shows `active_decree_id`, `elected_decree_id`, `winning_faction_id`, and `reigning_faction_id` as `NULL`. No house has ever organically won a term on this server. Low-population self-hosted servers may never reach the participation threshold needed to win a term naturally, permanently locking out content that requires it.

## 2. Background — how this is actually gated (verified against live schema)

Connected directly to `dune-dev`'s live Postgres and inspected the real `dune` schema (not documented anywhere in this repo previously; re-verified independently by 3 of the 8 audit hats):

```
dune.landsraad_decrees:
  id=7  SpecialVendorActive            (disabled=true — legacy/superseded)
  id=8  SpecialVendorActive_Vehicles
  id=9  SpecialVendorActive_Weapons
  id=10 SpecialVendorActive_Armor
  id=11 SpecialVendorActive_Utilities

dune.landsraad_decree_term:
  term_id, start_time, end_time, test_term,
  reigning_faction_id  (FK -> factions, nullable, ON DELETE SET NULL)
  active_decree_id     (FK -> landsraad_decrees, nullable, ON DELETE SET NULL)
  winning_faction_id   (FK -> factions, nullable, ON DELETE SET NULL)
  elected_decree_id    (FK -> landsraad_decrees, nullable, ON DELETE SET NULL)
```

`active_decree_id` is the switch this design targets. It is a **single** bigint FK column on the current term row — not a join/list table — so only one decree, and therefore one vendor type, can be active per term. There is no way to have all four vendor types active simultaneously without writing a state combination that has never existed in any real term.

This is the same table family the console's already-shipped "Landsraad Milestone Preset" feature (`applyLandsraadMilestonePreset`, `console/api/src/duneDb.js:487`) already writes to safely in production — precedent that this *class* of write (a value the closed-source engine reads live out of Postgres) is safe. **This precedent is narrower than it first appears (Architect hat finding):** it's proven for `goal_amount`/`threshold` columns the engine has always read *and written* routinely. `active_decree_id`/`elected_decree_id` have **never once been written by anything other than the engine itself**, on this server or (as far as this design can establish) any server — there is no operational precedent for this console ever writing to these two specific columns. This is named explicitly, not assumed away (§6).

### 2.1 The blocking go/no-go question — resolve BEFORE any implementation

**Whether vendor access is gated per-player-by-house (player's house must equal `winning_faction_id`) or server-wide (any player, once `active_decree_id` matches) is not resolvable from schema alone, and the answer determines whether this design's v1 scope is viable at all — not just how well it works.**

This design deliberately excludes touching `winning_faction_id`/`reigning_faction_id` (§6). If it turns out vendor access requires a player's house to match `winning_faction_id`, and this design leaves that column permanently `NULL`, **the feature could be a complete no-op for every player of every house** — `active_decree_id` would be set, the admin panel would show "Active Decree: SpecialVendorActive_Vehicles," and no player of any house would actually see the vendor, because no house ever equals `NULL`. This is a materially different failure mode than "works, but only for the winning house" — it's "silently doesn't work at all," and it was not distinguished clearly enough in the original draft (UI/UX + Security Architect hats).

**Required spike, sequenced as step 0 — before writing any implementation code, not in parallel with it:**

1. On `dune-dev`, manually `UPDATE landsraad_decree_term SET active_decree_id=8, elected_decree_id=8 WHERE term_id=<current>` (current term only; this is exactly the write v1 will perform).
2. With two test characters of **different** houses, check the Vehicle Vendor at Harko Village and Arrakeen.
3. Three possible outcomes, each with a different consequence for this design:
   - **(a) Server-wide** — any house sees the vendor. v1 as scoped works as intended. Proceed.
   - **(b) Per-house, but gating checks something other than `winning_faction_id`** (e.g. the elected decree alone, per-house, independent of "winning") — investigate further before proceeding; may still work with adjustments, needs a second, narrower spike.
   - **(c) Per-house, gated on `winning_faction_id` specifically** — v1 as scoped **does not achieve the stated goal for any player**. This is not a "ship it with a caveat" outcome — return to brainstorming for a redesign (which would need to address `winning_faction_id`, explicitly out of scope here per §6's risk reasoning) before writing implementation code. Do not implement §3 below as-is if this is the outcome.

This spike is a hard precondition on starting implementation, not a parallel-track nice-to-have (QA/Test hat finding — the original draft called this "blocking" without actually making it block anything).

## 3. Proposed design

*(Written for outcome (a)/(b) above. If the spike returns outcome (c), this section needs a redesign, not an implementation.)*

### 3.1 Data layer — `console/api/src/duneDb.js`

New `applyLandsraadVendorOverride(db, { decreeIds, mode, lastAppliedDecreeId })`, structured on `applyLandsraadMilestonePreset` (duneDb.js:487-572), with several deviations from a literal mirror, per audit findings:

- Requires `dune.landsraad_decree_term` and `dune.landsraad_decrees` to exist (`requireCapability`).
- **Resolve target decree ids by `decree_name`, not hardcoded integers (Architect hat, HIGH).** The literal ids `{8,9,10,11}` were observed on exactly one database (`dune-dev`) and there is no confirmation `landsraad_decrees.id` values are stable game-content ids rather than install-specific sequence values. At apply time, query `SELECT id, decree_name FROM dune.landsraad_decrees WHERE decree_name = ANY($1)` for the four expected names (`SpecialVendorActive_Vehicles`, `_Weapons`, `_Armor`, `_Utilities`); if any expected name is missing, fail loudly via `requireCapability`-style error ("this install's Landsraad decree catalog does not match the expected vendor decrees — this feature is not supported on this install") rather than silently writing a wrong id. The UI's decree selector is populated from this live-resolved list, never from hardcoded constants.
- Guard: refuse to act on a row where `test_term = true` (a genuinely new guard being added, not one reused from the milestone preset — corrected framing per Architect LOW finding; the milestone preset itself has no such guard and gets its own small follow-up issue, see §7).
- **Refuse to act if the term is already resolved (Security Architect hat, HIGH).** Before writing, check whether `active_decree_id`, `elected_decree_id`, or `winning_faction_id` is already non-`NULL` on the locked term row. If so: the reconciler (unattended, "Apply Automatically Each Term") **never** overwrites — it no-ops with `{applied:false, reason:"term already resolved"}`, exactly the existing non-throwing convention. "Force Now" (an explicit, attended action) **may** override an already-resolved term, but only behind a distinct, stronger UI confirmation naming what it's about to overwrite (§3.4) — this is the only path where an admin can knowingly discard an organic win, never something a background process does silently.
- Validate every id in `decreeIds` against the live-resolved allow-list from the step above; **reject the whole request** (throw, matching `normalizeLandsraadThresholds`'s existing throw-on-invalid convention) if any id isn't in it or if `decreeIds` is empty — no silent filtering (Security Architect MEDIUM finding).
- `mode: "fixed"` → target is `decreeIds[0]`. `mode: "rotate"` → target is the next id after `lastAppliedDecreeId` in `decreeIds`, wrapping; if `lastAppliedDecreeId` is no longer present in `decreeIds` (edited between ticks), fall back to `decreeIds[0]` (Architect MEDIUM finding — explicit, not left to implementation-time improvisation).
- `FOR UPDATE`-locked read of the current term row, re-checking both the resolved-term guard and the race condition immediately before the write (reusing `applyLandsraadMilestonePreset`'s "term changed while applying" pattern — this guard genuinely is needed here too, since a stale `termId` fetched outside the transaction could otherwise write into a closed historical row).
- `UPDATE dune.landsraad_decree_term SET active_decree_id = $1, elected_decree_id = $1 WHERE term_id = $2 AND test_term = false RETURNING term_id`.
- **`lastAppliedDecreeId`/`lastAppliedTermId` for Rotate mode are read and written inside this same locked transaction, from a new small table (or existing preset-file pattern extended with a DB-backed lock) — not read from the JSON preset file outside the transaction (DBA hat, MEDIUM — real, uncovered race).** A concurrent reconciler tick and an admin's "Force Now" click could otherwise both read the same stale rotate-index from disk and both compute the same "next" target, silently skipping a vendor type in rotation or double-applying one. Resolving this inside the same `FOR UPDATE` transaction that performs the write closes this gap; the JSON preset file remains authoritative for `enabled`/`decreeIds`/`mode` (operator-editable config, not contended state), but the *rotation position* lives wherever it's actually read-modify-written atomically.
- Returns `{ ok: true, applied: true, termId, decreeId, decreeName }` or `{ ok: true, applied: false, reason }` (no current term, term is a test term, term already resolved), matching the existing milestone function's non-throwing "not applicable yet" convention.
- **Post-apply verification, not just a successful UPDATE (DBA hat, HIGH — writing a state combination that has never existed in any real term, with no way to confirm the engine actually honors it).** Immediately after commit, re-read the term row once more (outside the transaction) and confirm `active_decree_id` still matches what was written; surface this in the response. This cannot prove the *engine* accepted the value in any deeper sense (Core has no visibility into the closed-source process's internal state) — that residual risk is named explicitly as an accepted limitation in §6, not silently assumed away. What this step does catch: any immediate, detectable rejection (e.g., a trigger or constraint this design didn't anticate) rather than reporting bare SQL success as if it were confirmed game-state.

### 3.2 Service layer — new `console/api/src/services/landsraadVendorOverride.js`

Structured on `landsraadMilestones.js`:

- `readLandsraadVendorOverridePreset(config)` / `saveLandsraadVendorOverridePreset(config, input)` — preset shape `{ enabled: boolean, decreeIds: number[], mode: "fixed" | "rotate", lastAppliedTermId, lastAppliedAt, lastResult }` (rotation position itself lives DB-side per §3.1, not in this file), persisted to `runtime/generated/landsraad-vendor-override.json` (same atomic temp-file-then-rename write pattern, `0664`).
- `applySavedLandsraadVendorOverride(config, db)` — one-shot apply, used by both "Force Now" and the reconciler tick.
- `createLandsraadVendorOverrideReconciler(config, options)` — same `running`/`lastCheckedAt`/`intervalMs` guard shape as `createLandsraadMilestoneReconciler`, same ≥10s floor. Fires only when the current term's `term_id` differs from `lastAppliedTermId`, **and** only acts when the term is still unresolved (§3.1's guard makes this safe even if that check is ever bypassed at this layer — defense in depth, not the sole guard).
- **Concurrent-reconciler note (Architect hat, MEDIUM):** this reconciler and the existing milestone-preset reconciler both run in the same background-tick loop (`runBackgroundTick`, fire-and-forget, no cross-reconciler sequencing) and can both issue a `FOR UPDATE` lock against the *same* `landsraad_decree_term` row concurrently. This is not a deadlock (one transaction simply waits for the other to commit) but is a real, previously-undocumented serialization coupling between two independently-shipped features — noted here explicitly so a future session investigating an unexplained reconciler-tick latency spike doesn't have to rediscover it.

### 3.3 API layer — `console/api/src/server.js` + `actions.js` + `policy.js`

- `GET /api/admin/landsraad/vendor-override` → current preset + live-resolved decree catalog (`landsraad:read` — read-only, no elevated action needed).
- `POST /api/admin/landsraad/vendor-override` → save preset + apply now.
- **Dedicated RBAC action, not a reuse of `landsraad:write` (Security Architect hat, HIGH — direct precedent: `dune-awakening-selfhost-docker#859`, where reusing a broad admin-reachable action for an unusually consequential write let a non-owner admin escalate; `policy.js`'s own established remediation for this exact bug class is a dedicated, Deny-listable action, e.g. `server:restart`/`carepackage:grant-all`).** New action `landsraad:vendor-override:write`, explicitly Deny-listed at the `admin` tier (owner-only) in `policy.js`, following the existing precedent pattern rather than inheriting `landsraad:*`'s admin-tier wildcard reach. This write is categorically different from every existing `landsraad:write` use (tuning numeric reward values within the system already-live rules) — it fabricates the outcome of the term's win/decree process itself.
- Added to the existing `landsraadRoute(req, res, action)` dispatcher (server.js:3045) as a new `action` value.
- Reconciler wired into the existing `runBackgroundTick` loop (server.js:451), next to `landsraadMilestoneReconciler.tick()` (see §3.2's concurrency note).
- **`actions.js`'s `rbacParity.test.js` must be updated in the same change (QA/Test hat, MEDIUM)** — new routes are auto-discovered by that test and it will fail CI until the two new `ROUTE_ACTIONS` entries are added; named explicitly here so an implementer doesn't have to rediscover this from a CI failure.
- `audit(config, req, "admin.landsraad.vendor-override", { ...body, ok, decreeId, decreeName })` on every apply attempt (success and failure).

### 3.4 Frontend — `LandsraadPanel.tsx` + `console/web/src/api/admin.ts`

- New `LandsraadVendorOverride` type in `admin.ts`, new `adminApi.landsraadVendorOverride()` / `adminApi.saveLandsraadVendorOverride()` client methods.
- New section in `LandsraadPanel.tsx`, after "Milestone Preset," before the bulk-goal row, using the same `<section>`/heading/`InlineActionResult` pattern.
- Four checkboxes, one per live-resolved decree (labeled by in-game vendor name: Vehicle / Weapon / Armor / Utility Vendor, not the raw decree string), populated from the GET response's resolved catalog (§3.1), never hardcoded client-side.
- **"Force Now" is disabled (not just discouraged) when zero decrees are checked (UI/UX hat, CRITICAL — the original draft had no guard here at all; `mode:"fixed"` targeting `decreeIds[0]` on an empty array is a client-reachable dead end).** Server-side, `applyLandsraadVendorOverride` also rejects an empty `decreeIds` array (§3.1), so this is defense in depth, not a client-only check.
- Fixed/Rotate mode selector (disabled, defaulting to the single checked box, when only one is checked).
- "Apply Automatically Each Term" toggle (reconciler on/off).
- **"Force Now" confirm dialog copy is specified explicitly, not left as "a confirm dialog" (UI/UX hat, HIGH):**
  - Normal case (term unresolved): *"Force the {Vendor Name} Vendor active for the current Landsraad term? This bypasses the normal win requirement — the vendor becomes available regardless of whether any house has won this cycle."*
  - Term-already-resolved case (only reachable because §3.1 allows "Force Now," specifically, to override an already-resolved term): *"This term was already won by {winning house} with {active decree name} active. Forcing {Vendor Name} Vendor will overwrite that result. This cannot be undone within this term."*
- **"Revert" action added alongside "Force Now" (DBA hat, MEDIUM — the original draft was one-way "set to X" with no way back).** Sets `active_decree_id`/`elected_decree_id` back to `NULL` for the current term (same transaction/guard shape as the forward apply), behind its own `confirmAction`. This is the only way to undo a mistaken force within the same term.
- **Per-house dead-end messaging (UI/UX + Security Architect hats, HIGH, directly tied to §2.1's spike outcome):** if the §2.1 spike resolves to outcome (b) (per-house gating on something other than `winning_faction_id`), the section must surface a persistent note: *"Vendor visibility may depend on player house alignment; this override does not change which house currently 'reigns.' See {link to issue tracking outcome (b)'s follow-up} if players report the vendor isn't visible to them."* This is a placeholder pending the spike's actual result — **implementation must not proceed past this point until §2.1's spike has run and its outcome is known**, since the exact copy needed depends on which of outcomes (a)/(b) actually occurred.
- Applied-status display: reuses the existing read-only `overview.term.active_decree`/`elected_decree` fields already rendered above this section (LandsraadPanel.tsx:338-339); in Rotate mode, an additional small line states which vendor type was last applied and (if determinable client-side from `decreeIds`/`lastAppliedDecreeId`) which is next, addressing the DBA/UI/UX finding that Rotate mode otherwise gives no visibility into rotation position (MEDIUM).
- Failure path (no current term, race-guard fired, decree catalog doesn't resolve per §3.1): reuses the existing `run()`/`InlineActionResult` danger-tone convention uniformly used elsewhere in this panel — stated explicitly here per the UI/UX hat's LOW finding, rather than left implicit.

## 4. Data flow

1. Admin opens Landsraad tab → existing `load()` fetches `overview` → new fetch loads the vendor-override preset **and the live-resolved decree catalog** (§3.1) the same trip.
2. Admin checks one or more vendor types (button disabled until at least one is checked), picks Fixed/Rotate, clicks "Force Now" → confirm dialog (copy depends on whether the term is already resolved, §3.4) → `POST /api/admin/landsraad/vendor-override` → `applySavedLandsraadVendorOverride` → `applyLandsraadVendorOverride` transaction (decree-name resolution, resolved-term guard, allow-list validation, locked read, rotate-index read-modify-write, `UPDATE`, post-apply re-read) → response → `load()` re-fetches overview, new `active_decree`/`elected_decree` visible immediately.
3. "Revert" follows the same path with a `NULL`-setting variant, behind its own confirm.
4. If "Apply Automatically Each Term" is enabled: the reconciler tick detects a new, still-unresolved `term_id` and applies without operator action, advancing the DB-backed rotate position if in Rotate mode; it never overwrites an already-resolved term (§3.1).

## 5. Testing

**Test-harness clarification (QA/Test hat, HIGH — the original draft conflated two incompatible harnesses this codebase actually uses for different purposes):**
- `landsraadMilestones.test.js`'s existing reconciler tests work by injecting a **stub** `applyPreset` function — they validate the tick/term-change-detection *wrapper* logic in isolation, never real business logic. The new `landsraadVendorOverrideReconciler`'s equivalent tests (term-change detection, "already applied this term" skip, "term already resolved" skip) should mirror this stub-injection pattern — that's what it's actually good for.
- Core validation logic — decree-name resolution and its fail-loud path, allow-list rejection (including the empty-array case), rotate-index math and its wraparound/stale-id fallback, the resolved-term guard, the race guard — must be tested against the **real** `applyLandsraadVendorOverride` function using `db.test.js`'s raw fake-`{query, transaction}` harness, not a stub. Mirroring `landsraadMilestones.test.js`'s reconciler-test pattern for this logic instead would produce tests that can never catch a real regression (the exact tautology failure class this org's QA hat has repeatedly found).
- **The "term changed while applying" race-guard test this design's first draft claimed to mirror from the milestone preset does not currently exist anywhere in this codebase (QA/Test hat finding — confirmed by grep, zero matches).** This implementation should add that test for `applyLandsraadVendorOverride`; backfilling the equivalent, still-missing test for the existing `applyLandsraadMilestonePreset` is tracked as a separate small follow-up (§7), not silently folded into this feature's scope.
- `console/api/test/rbacParity.test.js` must gain explicit coverage for the two new routes and the new `landsraad:vendor-override:write` action (§3.3) — this is CI-enforced (the test auto-discovers routes), but named here so it isn't rediscovered via a red CI run.
- **Frontend test coverage is a stated commitment, not silent omission (QA/Test hat, MEDIUM — `LandsraadPanel.tsx` has no existing test file, unlike most comparably-complex panels in this codebase, e.g. `BasesPanel`, `PlayersPanel`, `GuildsPanel`).** Given this feature adds a destructive, confirm-gated, live-state-overwriting UI action, implementation adds `LandsraadVendorOverride`-focused component tests (empty-selection disables Force Now; both confirm-dialog copy variants render correctly; the per-house dead-end note per §3.4 renders when applicable) rather than inheriting the panel's pre-existing silence on frontend tests by default.
- **§2.1's spike is a literal precondition, not a parallel testing bullet (QA/Test hat, MEDIUM — the original draft called it "blocking" without stating any consequence).** Implementation work on §3 does not start until the spike has run and produced outcome (a) or (b) from §2.1. If (c), this document is not implementation-ready as written and returns to design.
- Manual dune-dev pass (via the real UI, not raw SQL), per Requirement 0: end-to-end apply, Revert, reconciler behavior across a term rollover (or a manually-inserted new term row for a faster cycle), Rotate mode advancing correctly across two consecutive applies, and the already-resolved-term override path (requires manually setting `winning_faction_id` on a test term first).

## 6. Requirement 0 / blast radius

Core is a public, multi-operator fork. This feature is additive and opt-in: a new panel section, two new routes, one new RBAC action, no change to any existing route, table, or default behavior — an operator who never opens this section, or never enables the toggle, sees zero difference from today.

**Named, accepted residual risks (not resolved by this design, stated explicitly rather than left implicit — GRC + DBA + Architect hat findings):**
- **Unprecedented engine state.** `active_decree_id`/`elected_decree_id` set to non-`NULL` while `winning_faction_id`/`reigning_faction_id` remain `NULL` is, as far as this design can establish, a combination the closed-source engine has never itself produced. §3.1's post-apply re-read confirms the *database* accepted the write; it cannot confirm the *engine* treats this combination the way an organically-resolved term would. This is the same category of "could this desync from something outside this codebase" question Requirement 0 exists to raise — raised here explicitly, not assumed safe by analogy to the milestone-preset precedent (which never touched these two columns).
- **Future game-patch drift.** If a future Funcom patch changes decree schema or vendor-gating logic, this feature would keep writing successfully (the UPDATE would still succeed) while its intended in-game effect could silently stop working, with no signal visible to Core. No monitoring for this is proposed in v1 — an operator's only signal would be a player report that the vendor stopped appearing.
- **§2.1's per-house-gating question** is the biggest of these and is treated as a hard implementation gate, not a residual risk to merely document (see §2.1, §3.4, §5).

**Deliberately excluded from this design, restated:**
- All four vendor types simultaneously active is not possible under the real schema (§2) — Rotate mode is the answer to "more than one vendor type," not a stacking mechanism.
- `winning_faction_id`/`reigning_faction_id` are out of scope. `dune.landsraad_house_rewards` (confirmed live: a separate table with an active Postgres `NOTIFY` trigger the engine listens on) strongly suggests "winning faction" has broader, currently-unmapped systemic effects beyond vendor access. Touching it without first mapping those effects would repeat the exact mistake Requirement 0 exists to prevent.
- **This decision needs a durable marker beyond this document (GRC hat, MEDIUM — an L1 design doc is easy to not re-read months later).** A code comment in `landsraadVendorOverride.js` states this explicitly, and issue #907 is labeled/annotated to flag "fork-only, not an upstream candidate — see design doc" so a future session evaluating Requirement 19's upstream-PR gates on pure technical merit doesn't miss this categorical decision.
- No upstream PR to Red-Blink is proposed. This is arguably an operator "cheat" (bypassing an intended win condition); that is a separate, later decision.

**Documentation and process commitments (GRC hat, HIGH — the original draft named none of these):**
- `docs/console/API-REFERENCE.md` gets an entry for the two new routes, matching its existing per-route documentation of every other Landsraad admin action.
- `docs/operator-guide.md` gets a note describing this feature and its tradeoff (bypasses the intended win condition; does not affect which house is credited with winning) — not just prose in this design doc an operator clicking through the console would never see.
- A `CHANGELOG.md` entry is required at merge time, naming the docs touched (this repo's own existing convention).
- Issue #907 gets labeled with a risk classification (Critical/High/Medium/Low + one-line blast-radius statement, per this org's DevSecOps "risk classification on every PR" practice) before implementation branches off it.

## 7. Layer 1 Eight-Hats audit

8 independent agent reviews were dispatched against the first draft of this document (not a solo pass), each scoped to one hat's mandate with an explicit STRIDE-mapping instruction. Full transcripts available on request; findings and resolutions are summarized here per Requirement 20.

### Findings register

| # | Hat | Severity | Finding | Resolution |
|---|---|---|---|---|
| 1 | UI/UX | CRITICAL | "Force Now" reachable with zero decrees selected — client-reachable dead end | §3.4: button disabled client-side; §3.1: server-side rejects empty `decreeIds` |
| 2 | Security Architect | HIGH | `landsraad:write` (admin-tier) reused for an unusually consequential write, no dedicated action (precedent: `#859`) | §3.3: dedicated `landsraad:vendor-override:write`, Deny-listed at `admin` |
| 3 | Security Architect | HIGH | No guard against silently overwriting an organically-resolved term | §3.1: reconciler never overwrites a resolved term; "Force Now" may, behind a distinct stronger confirm |
| 4 | GRC | HIGH | No commitment to update operator-facing docs at ship time | §6: `API-REFERENCE.md` + `operator-guide.md` commitments named explicitly |
| 5 | GRC | HIGH | No `CHANGELOG.md` commitment | §6: commitment added |
| 6 | Architect | HIGH | Hardcoded decree ids `{8,9,10,11}` assume unverified cross-install stability | §3.1: resolve by `decree_name` at apply time, fail loud if catalog mismatch |
| 7 | DBA | HIGH | Writes an unprecedented engine-state combination with no invariant verification | §3.1: post-apply re-read added; §6: named as accepted residual risk (can't be fully resolved from Core alone) |
| 8 | QA/Test | HIGH | Test plan conflates two incompatible harnesses — real risk of tautological tests | §5: harness usage clarified per test category |
| 9 | QA/Test | HIGH/MEDIUM | Cited "term changed while applying" test precedent doesn't actually exist | §5: acknowledged; new test added for this feature, backfill for milestone preset tracked separately |
| 10 | UI/UX | HIGH | "Force Now" consequence never specified in-UI | §3.4: exact confirm-dialog copy specified, including already-resolved-term variant |
| 11 | UI/UX + Security Architect | HIGH | Per-house dead-end unhandled; could mean v1 is a complete no-op for all players | §2.1: elevated to a blocking pre-implementation spike with 3 defined outcomes; §3.4: contingency messaging specified |
| 12 | DBA | MEDIUM | No revert/"unforce" path | §3.4: "Revert" action added |
| 13 | DBA | MEDIUM | Real race in JSON-file-based rotate index between reconciler and "Force Now" | §3.1: rotate position moved inside the locked DB transaction |
| 14 | Architect | MEDIUM | Concurrent reconciler lock contention with milestone preset, undocumented | §3.2: documented explicitly as a known, accepted coupling |
| 15 | Architect | MEDIUM | `elected_decree_id = active_decree_id` is an unverified semantic assumption | §2/§6: named as an accepted, unprecedented-precedent risk |
| 16 | Architect | MEDIUM | Rotate-mode behavior when `lastAppliedDecreeId` no longer in `decreeIds` unspecified | §3.1: explicit fallback to `decreeIds[0]` |
| 17 | QA/Test | MEDIUM | `rbacParity.test.js` update unmentioned | §3.3/§5: named explicitly |
| 18 | QA/Test | MEDIUM | Zero frontend test coverage unacknowledged | §5: explicit commitment added |
| 19 | QA/Test | MEDIUM | Spike's "blocking" framing had no defined consequence | §2.1/§5: sequenced as literal precondition with 3 defined outcomes |
| 20 | GRC | MEDIUM | Issue #907 unlabeled, no risk classification | §6: commitment to label before implementation branches |
| 21 | GRC | MEDIUM | "Not upstream" decision has no durable marker outside this doc | §6: code comment + issue label committed |
| 22 | GRC | MEDIUM | No named risk for future game-patch drift | §6: named explicitly as accepted residual risk |
| 23 | Security Architect | MEDIUM | Allow-list partial-validity semantics (e.g. one bad id in array) unspecified | §3.1: whole request rejected on any invalid id, no silent filtering |
| 24 | Architect | LOW | `test_term` guard misdescribed as "reused" from milestone preset (which has none) | §3.1: framing corrected; follow-up issue for milestone preset itself (§ below) |
| 25 | Architect | LOW | "Matching every other mutating action" overclaim re: `confirmAction` usage | §3.4 framing corrected to "matching other term-wide actions" |
| 26 | UI/UX | MEDIUM | No applied-status/rotation-position indicator | §3.4: rotation status line added |
| 27 | UI/UX | LOW | Failure-path UI convention not stated explicitly | §3.4: stated explicitly (reuses existing `InlineActionResult` danger tone) |
| 28 | QA/Test | LOW | Audit-log call has no test coverage | Pre-existing project-wide gap, not introduced by this design — filed per Requirement 20's "LOW findings still get filed" rule, not blocking |
| 29 | Security Architect | LOW/MEDIUM | `audit()` lacks authenticated-actor identity (IP only) | Pre-existing, project-wide gap predating this design — out of scope for this feature; worth its own future issue |
| 30 | Architect | LOW | Rotate-index math not isolated as a pure function like `normalizeLandsraadThresholds` | Implementation detail for the coding phase; noted for the implementer |
| — | Network | — | No findings — confirmed no new listener/port/outbound call; rides entirely on existing console API/DB connection | N/A |
| — | Cloud Security | — | No findings — confirmed no new credential/secret/cloud-provider config introduced | N/A |

**Follow-up issues to file separately (pre-existing gaps this design surfaced but does not itself need to fix):**
- Backfill the "term changed while applying" test for the existing, already-shipped `applyLandsraadMilestonePreset` (finding #9).
- Add a `test_term = true` guard to `applyLandsraadMilestonePreset` itself, matching the new guard this design adds (finding #24).
- `audit()`'s lack of authenticated-actor identity, project-wide (finding #29).

### STRIDE table

| Category | Findings | Severity | Status |
|---|---|---|---|
| Spoofing | None | — | — |
| Tampering | #3 (resolved-term overwrite), #13 (rotate-index race), #23 (allow-list partial validity), #7 (unprecedented state) | HIGH/MEDIUM | Resolved / named residual |
| Repudiation | #10 (unclear consent to consequential action), #29 (pre-existing audit-log gap) | HIGH / LOW (pre-existing) | Resolved / deferred (pre-existing) |
| Information Disclosure | None | — | — |
| Denial of Service | None (reconciler floor-guarded at ≥10s, inherited from existing pattern) | — | — |
| Elevation of Privilege | #2 (admin-tier reach for a win-fabricating write) | HIGH | Resolved |

All CRITICAL and HIGH findings (#1-11) are resolved directly in §§2-6 above. All MEDIUM findings (#12-23, #26) are resolved inline or explicitly named as accepted residual risk with rationale. All LOW findings (#24, #25, #27, #28, #29, #30) are either resolved, explicitly deferred to a named follow-up issue, or noted for the implementer — none silently dropped, per Requirement 20.
