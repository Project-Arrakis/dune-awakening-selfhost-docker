# Spice Fields (Custom Settings) — UAT

**Status:** In Design | **For:** [PR #228](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pull/228)

This is a manual test plan for verifying the new `Maps -> Interactive
Modifiers -> Custom Settings -> Spice Fields` section against a real, live
server — the one gate this PR is still in draft for (see the PR's "Known
open item"). It isn't end-user documentation; once this PR is out of draft,
a normal operator-facing doc can be added separately if the maintainer wants
one.

## Prerequisites

- A running Dune Docker Console with at least one Battlegroup/map server up.
- Admin access to the Console.
- Shell access to the host (to inspect `UserGame.ini` directly, to confirm
  what the UI claims actually landed in the file).

## Setup

1. Open the Console, go to **Maps -> Interactive Modifiers**.
2. Click **Custom Settings**.
3. Locate the **Spice Fields** section, below the existing per-target Custom
   Settings grid.

## 1. Section is visible and usable without selecting a Target

- [ ] With **no** Target selected in the "Target" dropdown above, confirm
      the Spice Fields section is still visible and its 9 fields are
      populated with real values (not blank/loading forever).
- [ ] Confirm the section's explanatory paragraph is present and states
      these settings apply server-wide, independent of the Target selector.
- [ ] Confirm the **Filter Custom Settings** search box is enabled (not
      greyed out) even with no Target selected, and typing into it filters
      the Spice Fields grid.
- [ ] Confirm the existing (unrelated) per-target Custom Settings grid above
      is empty/prompting for a Target, as before — this section's own
      behavior shouldn't change.

## 2. All 9 fields are present, correctly labeled, and correctly typed

Confirm each of the following renders as a **toggle** (not a text/number
input):

- [ ] Spice Spawning Active (default: on)
- [ ] Spice Player Must Witness Bloom (default: off)
- [ ] Spice Bloom Long Range Replication (default: on)
- [ ] Spice Field Long Range Replication (default: on)

Confirm each of the following renders as a **number input**:

- [ ] Spice Prime Rate Seconds (default: 30)
- [ ] Spice Manager Tick Rate Seconds (default: 5)
- [ ] Spice Manager Refresh Rate Seconds (default: 90)
- [ ] Spice Global Manager Refresh Rate Seconds (default: 120)
- [ ] Spice Node Value To Resource Ratio (default: 10)

- [ ] Hover/read each field's description. Confirm the Node Value To
      Resource Ratio field's description makes clear it's a **yield**
      multiplier, not a spawn-count or field-size control (this is the
      single most likely field to be misread — verify the copy actually
      prevents that misunderstanding for a first-time reader, not just that
      the words are technically present).

## 3. Save actually writes to `UserGame.ini`, at Global scope

1. Change **Spice Manager Tick Rate Seconds** from its current value to a
   distinct test value (e.g. `7`).
2. Click **Save Spice Fields**.
3. Confirm a save-in-progress/success indicator appears (matching this
   Console's existing save UX for other settings tabs).
4. On the host, inspect the Global `UserGame.ini` file (or use the existing
   **UserGame** tab's own **Advanced** raw-editor view) and confirm
   `m_ManagerTickRateInSeconds=7.000000` appears under the
   `[/Script/DuneSandbox.SpiceHarvestingSystem]` section.
5. Reload the Console page (or navigate away from Custom Settings and back).
   Confirm the field still shows `7` (proves the value round-trips through
   a real reload, not just optimistic UI state).
6. Restore the value to its default (`5`) via step 6 below before
   continuing, so later checks start from a known state.

## 4. Discard Changes reverts to the last-loaded value (not the schema default)

1. Change **Spice Prime Rate Seconds** to a new value (e.g. `45`) but do
   **not** save.
2. Click **Discard Spice Field Changes**.
3. Confirm the field reverts to whatever it was *before* your edit in this
   session (the last-loaded/saved value) — not necessarily the schema
   default of `30`, if the live server's actual current value differs from
   default.

## 5. Restore Defaults sets every field to its schema default (draft only, until Saved)

1. Change 2–3 fields to non-default values (don't save).
2. Click **Restore Spice Field Defaults**.
3. Confirm all 9 fields now show their schema defaults (see the table in
   section 2 above) — including fields you didn't touch, if they weren't
   already at default.
4. Confirm nothing is written to disk yet (check `UserGame.ini` — should
   still show the pre-existing values) until you click **Save Spice
   Fields**.
5. Click **Discard Spice Field Changes** afterward instead of Save, to
   avoid actually resetting your live server's spice settings to default as
   a side effect of this test.

## 6. The two Custom Settings action rows don't interfere with each other

1. Select a real Target (map or partition) so the existing per-target
   Custom Settings grid also becomes usable.
2. Make a pending (unsaved) change in **both** the per-target grid and the
   Spice Fields section at the same time.
3. Confirm the two action rows are independently labeled ("Save Custom
   Settings" vs. "Save Spice Fields", etc.) and clicking one only affects
   its own section's pending changes — the other section's pending edit
   should remain untouched and still pending afterward.

## 7. Interaction with the existing Target/range-validation feature is unaffected

(This isn't new behavior from this PR — it's an existing Custom Settings
feature; verifying it still works correctly alongside the new section.)

1. With a Target selected, enter an out-of-range value into an existing
   Custom Settings field that has documented min/max bounds (e.g.
   `Gathering Amount`).
2. Confirm the existing "Enter a supported value within the displayed
   range before saving" message still appears, and **Save Custom
   Settings** (not **Save Spice Fields**) is disabled — confirming the two
   sections' Save buttons are genuinely independent, not just visually.

## 8. Restart/apply behavior matches every other Global `UserGame.ini` save

- [ ] Confirm saving triggers the same restart-confirmation flow (immediate
      / deferred / cancel) as saving the existing **UserGame** tab's own
      Global-scope fields — this PR reuses that exact mechanism and should
      not behave differently.

## Sign-off

| Section | Result | Notes |
|---|---|---|
| 1. Visible without Target | ☐ Pass ☐ Fail | |
| 2. All 9 fields, correct types | ☐ Pass ☐ Fail | |
| 3. Save writes to UserGame.ini | ☐ Pass ☐ Fail | |
| 4. Discard reverts correctly | ☐ Pass ☐ Fail | |
| 5. Restore Defaults (draft only) | ☐ Pass ☐ Fail | |
| 6. Two action rows independent | ☐ Pass ☐ Fail | |
| 7. Range validation unaffected | ☐ Pass ☐ Fail | |
| 8. Restart flow matches UserGame tab | ☐ Pass ☐ Fail | |

**Tested against:** commit ___________ | **Server:** ___________ | **Date:** ___________
