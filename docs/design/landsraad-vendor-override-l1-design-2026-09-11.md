# Landsraad Special Vendor Override — L1 Design

**Date:** 2026-09-11
**Tracking issue:** [Project-Arrakis/dune-awakening-selfhost-docker#907](https://github.com/Project-Arrakis/dune-awakening-selfhost-docker/issues/907)
**Status:** Draft (pre-audit). A Layer 1 Eight-Hats audit (8 independent dispatched agent reviews, per this org's Requirement 20) is being run against this draft; findings and resolutions will be recorded in §7 before this is considered ready for implementation.
**Scope:** a new "Special Vendor Override" section inside the existing Core admin-console **Landsraad** tab (`console/web/src/features/landsraad/LandsraadPanel.tsx`) that lets an operator force one of the four Landsraad "Special Vendor" decrees active for the current term, independent of whether any house has organically won that term.
**Explicitly out of scope (v1):** forcing `winning_faction_id`/`reigning_faction_id`; anything about which specific *house* benefits from the override (see §2's open question and §6); any change to the Landsraad voting/decree-rotation mechanics themselves; an upstream PR to Red-Blink (a separate, later decision — see §6).

---

## 1. Problem statement

The Landsraad "Special Vendor" NPCs (Vehicles, Weapons, Armor, Utilities — sold at Harko Village / Arrakeen per community documentation) only become available once a house's elected decree for the current term becomes that term's *active* decree, which normally requires that house to win the term. Confirmed directly against live data on `dune-dev` (`docker exec dune-postgres psql -U dune -d dune`): the server's last 5 Landsraad terms (back to 2026-08-11) all show `active_decree_id`, `elected_decree_id`, and `winning_faction_id` as `NULL` — no house has ever organically won a term on this server. This is real evidence, not a hypothetical: low-population self-hosted servers may never reach the participation threshold (guild votes, task contributions) needed to win a term naturally, permanently locking out content that requires it.

Operators want a way to make these vendors available without depending on natural Landsraad-win participation.

## 2. Background — how this is actually gated (verified against live schema, not assumed)

Connected directly to `dune-dev`'s live Postgres and inspected the real `dune` schema (not documented anywhere in this repo previously):

```
dune.landsraad_decrees:
  id=7  SpecialVendorActive            (disabled=true — legacy/superseded)
  id=8  SpecialVendorActive_Vehicles
  id=9  SpecialVendorActive_Weapons
  id=10 SpecialVendorActive_Armor
  id=11 SpecialVendorActive_Utilities

dune.landsraad_decree_term:
  term_id, start_time, end_time, test_term,
  reigning_faction_id  (FK -> factions, nullable)
  active_decree_id     (FK -> landsraad_decrees, nullable)
  winning_faction_id   (FK -> factions, nullable)
  elected_decree_id    (FK -> landsraad_decrees, nullable)
```

`active_decree_id` is the switch this design targets. Importantly, it is a **single** bigint FK column on the current term row — not a join/list table — so **only one decree, and therefore one vendor type, can be active per term** under the real data model. There is no way to have all four vendor types active simultaneously without writing a state combination that has never existed in any real term (see §6).

This is the same table family the console's existing, already-shipped "Landsraad Milestone Preset" feature (`applyLandsraadMilestonePreset`, `console/api/src/duneDb.js:487`) already writes to safely in production today — an established precedent that this class of write (a value the closed-source game engine reads live out of Postgres, the way `landsraad_task_rewards`/`landsraad_tasks` already are) is safe, unlike e.g. the command-auth-token incident, where the value being changed was validated independently *inside* the closed-source binary rather than read live from the database.

**Open question, not yet resolved from schema alone:** whether vendor access, once `active_decree_id` matches, is gated **per-player-by-house** (only players whose house equals `winning_faction_id` can use the vendor) or **server-wide** (any player can use it once the decree is active, regardless of house). The wiki's "your aligned house must have won" phrasing suggests per-house, but that describes the *organic win* path, not necessarily what the engine checks once `active_decree_id` is already set by other means. **This must be resolved with a live behavioral spike on `dune-dev` before implementation is considered complete** (see §5) — it is the single biggest open unknown in this design and determines whether the v1 scope above is sufficient.

## 3. Proposed design

### 3.1 Data layer — `console/api/src/duneDb.js`

New `applyLandsraadVendorOverride(db, { decreeIds, mode, lastAppliedDecreeId })`, structured directly on the existing `applyLandsraadMilestonePreset` (duneDb.js:487-572):

- Requires `dune.landsraad_decree_term` and `dune.landsraad_decrees` to exist (`requireCapability`, matching existing convention).
- `db.transaction`, `FOR UPDATE`-locked read of the current term row (reusing the exact "term changed while applying" guard already present in `applyLandsraadMilestonePreset`).
- Guard: refuse to act on a row where `test_term = true`.
- Validate every id in `decreeIds` is one of `{8, 9, 10, 11}` (a server-side hardcoded allow-list, **not** derived from the `landsraad_decrees` table by name-pattern match at request time — see §7 for why this was tightened).
- `mode: "fixed"` → target is `decreeIds[0]`. `mode: "rotate"` → target is the next id after `lastAppliedDecreeId` in `decreeIds` (wrapping), so repeated ticks visit each selected vendor type in turn.
- `UPDATE dune.landsraad_decree_term SET active_decree_id = $1, elected_decree_id = $1 WHERE term_id = $2 AND test_term = false RETURNING term_id`.
- Returns `{ ok: true, applied: true, termId, decreeId, decreeName }` or `{ ok: true, applied: false, reason }` (no current term, term is a test term, id not in allow-list), matching the existing milestone function's non-throwing "not applicable yet" convention.

### 3.2 Service layer — new `console/api/src/services/landsraadVendorOverride.js`

Structured directly on `landsraadMilestones.js`:

- `readLandsraadVendorOverridePreset(config)` / `saveLandsraadVendorOverridePreset(config, input)` — preset shape `{ enabled: boolean, decreeIds: number[], mode: "fixed" | "rotate", lastAppliedTermId, lastAppliedDecreeId, lastAppliedAt, lastResult }`, persisted to `runtime/generated/landsraad-vendor-override.json` (same atomic temp-file-then-rename write pattern, `0664`).
- `applySavedLandsraadVendorOverride(config, db)` — one-shot apply, used by both the "Force Now" button and the reconciler tick.
- `createLandsraadVendorOverrideReconciler(config, options)` — same `running`/`lastCheckedAt`/`intervalMs` guard shape as `createLandsraadMilestoneReconciler`. Fires only when the current term's `term_id` differs from `lastAppliedTermId` (i.e. once per new term, at whatever point after term rollover the reconciler's poll interval next ticks — not synchronously at the rollover instant), so a mid-cycle admin toggle of the preset doesn't cause it to reapply until the *next* term boundary. "Force Now" bypasses this and applies immediately to the current term regardless of `lastAppliedTermId`.

### 3.3 API layer — `console/api/src/server.js` + `actions.js`

- `GET /api/admin/landsraad/vendor-override` → current preset (`landsraad:read`).
- `POST /api/admin/landsraad/vendor-override` → save preset + apply now (`landsraad:write`).
- Added to the existing `landsraadRoute(req, res, action)` dispatcher (server.js:3045) as a new `action` value, alongside `milestone-preset` — no new route-matching scaffolding.
- Reuses the existing `landsraad:read`/`landsraad:write` RBAC actions already defined in `actions.js`/`policy.js` — **no `policy.js` changes**.
- Reconciler wired into the existing `runBackgroundTick` loop (server.js:451), next to `landsraadMilestoneReconciler.tick()`.
- `audit(config, req, "admin.landsraad.vendor-override", { ...body, ok, decreeId, decreeName })` on every apply attempt (success and failure), matching the existing `landsraadRoute` audit convention.

### 3.4 Frontend — `LandsraadPanel.tsx` + `console/web/src/api/admin.ts`

- New `LandsraadVendorOverride` type in `admin.ts`, new `adminApi.landsraadVendorOverride()` / `adminApi.saveLandsraadVendorOverride()` client methods, mirroring the existing milestone-preset client methods exactly.
- New section in `LandsraadPanel.tsx`, positioned directly after the "Milestone Preset" section (§`landsraad-milestone-preset`) and before the bulk-goal row, using the same `<section>`/heading/`InlineActionResult` pattern:
  - Four checkboxes, one per real decree (`SpecialVendorActive_Vehicles` / `_Weapons` / `_Armor` / `_Utilities`), labeled by their in-game vendor name (Vehicle / Weapon / Armor / Utility Vendor), not the raw decree string.
  - A `Fixed` / `Rotate` mode selector (disabled, defaulting to the single checked box, when only one is checked).
  - "Apply Automatically Each Term" toggle (reconciler on/off), matching the milestone preset's existing toggle pattern.
  - "Force Now" button, behind `confirmAction(...)` (matching every other mutating action in this panel), since it immediately overwrites the current term's live decree state.
  - The already-fetched, already-rendered read-only `overview.term.active_decree` / `elected_decree` fields (LandsraadPanel.tsx:338-339) are left as-is directly above this new section, so the admin can see current live state without the new section needing to duplicate that display.

## 4. Data flow

1. Admin opens Landsraad tab → existing `load()` already fetches `overview` (including `term.active_decree`/`elected_decree`) → new `useEffect` fetches the vendor-override preset the same way milestone preset does.
2. Admin checks one or more vendor types, picks Fixed/Rotate, clicks "Force Now" → confirm dialog → `POST /api/admin/landsraad/vendor-override` → `applySavedLandsraadVendorOverride` → `applyLandsraadVendorOverride` transaction → `UPDATE landsraad_decree_term` → response → `load()` re-fetches overview, new `active_decree`/`elected_decree` values visible immediately in the existing read-only display.
3. If "Apply Automatically Each Term" is enabled: the reconciler tick (same background-task cadence as milestone preset) detects a new `term_id` at whatever point after rollover it next polls, and applies without operator action, advancing the rotate index if in Rotate mode.

## 5. Testing

- `console/api/test/landsraadVendorOverride.test.js`, mirroring `landsraadMilestones.test.js`: preset read/save/atomic-write, reconciler term-change detection (fires once per new `term_id`, not repeatedly), rotate-index wraparound math, decree-id allow-list rejection of any id outside `{8,9,10,11}`, `test_term` row skip.
- `duneDb.test.js`-adjacent: the transaction's "term changed while applying" race guard, mirroring the existing milestone-preset test for the same race in `applyLandsraadMilestonePreset`.
- **Cannot be unit-tested, and is a blocking precondition for calling this design implementation-ready, not deferred polish:** whether the resulting vendor-menu visibility is per-house or server-wide (§2's open question). Required live spike on `dune-dev`: manually `UPDATE landsraad_decree_term SET active_decree_id=8 WHERE term_id=<current>`, then have two test characters of *different* houses check the Vehicle Vendor at Harko Village/Arrakeen. The result gates whether v1 scope (decree-only) is sufficient or whether `winning_faction_id`/`reigning_faction_id` must also be addressed (out of scope for this design either way — see §6 — but the spike result determines whether this feature, as scoped, actually satisfies the operator's goal for every house or only for whichever house happens to already hold `winning_faction_id`, which is a real product-completeness question, not just a technical one).
- Manual dune-dev pass, per Requirement 0: apply via the new UI (not raw SQL) end-to-end, confirm reconciler behavior across an actual term rollover (or a manually-inserted new term row for a faster test cycle), confirm Rotate mode advances correctly across two consecutive applies.

## 6. Requirement 0 / blast radius

Core is a public, multi-operator fork. This feature is purely additive and opt-in: a new panel section, a new route, no change to any existing route, table, or default behavior — an operator who never opens this section, or never enables the toggle, sees zero difference from today.

The write itself (`UPDATE landsraad_decree_term SET active_decree_id, elected_decree_id`) is the same class of already-proven-safe write the shipped Milestone Preset feature performs. The genuinely new risk surface is narrower than it might look: it touches exactly two columns on one row, both already nullable and already written by the game engine itself during normal play — this design does not add a new table, new column, or new schema shape.

**Deliberately excluded from this design, stated explicitly rather than left implicit:**
- Forcing all four vendor types active simultaneously is **not possible** under the real schema (§2) and is not attempted — Rotate mode is the answer to "I want access to more than one vendor type," not a stacking mechanism.
- Forcing `winning_faction_id`/`reigning_faction_id` is out of scope. Those columns plausibly gate systems well beyond vendor access — `dune.landsraad_house_rewards` (a separate table, keyed by `player_id`/`house_name`, with a live Postgres `NOTIFY` trigger the engine actively listens on) strongly suggests "winning faction" has broader, currently-unmapped systemic effects. Touching it without first mapping those effects would repeat the exact mistake Requirement 0 exists to prevent (a fix riskier than the problem it solves, changing a value another process depends on in ways this codebase can't fully see or test). If the §5 spike shows vendor access *is* gated per-house and operators want it available regardless of house, that is a separate, later design with its own dedicated risk review — not silently folded into this one.
- No upstream PR to Red-Blink is proposed as part of this issue. This is arguably an operator "cheat" (bypassing an intended win condition) that upstream may not want at all; that is an explicit, separate decision for a later issue, not assumed here.

## 7. Layer 1 Eight-Hats audit

*(To be completed: 8 independent dispatched reviews, findings register, STRIDE table, resolution status for every CRITICAL/HIGH finding.)*
