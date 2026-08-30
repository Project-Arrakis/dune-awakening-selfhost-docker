# UAT: Access Control visual policy editor (#634)

**Purpose.** A manual, end-user test plan for the AWS-IAM-style visual Access
Control editor, to be executed by a person in a real browser against a
deployed build. Automated tests (`console/api/test/accessLevel.test.js`,
`crownJewelActions.test.js`, `IamPolicyEditor.contract.test.tsx`,
`iamPolicyGroups.test.ts`) cover the classification/grouping logic in
isolation; this covers what a human sees, whether the grid behaves correctly
under real interaction, and whether the server-side crown-jewel guard
actually holds when an operator tries to break it.

**Who.** One QA engineer (any operator can run it) with Owner access.
Budget about 60 minutes.

**Result rule.** A case passes only if *every* expected line is observed. A
UI state that "looks about right" but doesn't match the exact expected
behavior (e.g. a checkbox that shows checked when it should show
indeterminate) is a finding, not a pass.

---

## Environment (fill in before starting)

| Item | Value |
|---|---|
| Console URL | `https://________________` |
| Build under test | commit `________` |
| Discord OAuth | must already be configured with at least one Admin-role and one Moderator-role mapping (Access Control is hidden entirely otherwise — see T01) |
| Owner session | password login (Discord login also works — Access Control has no role concept difference between the two for Owner) |
| A second Discord account mapped to Admin, and one mapped to Moderator | for T10 (live effect verification) |

**Before starting, back up the current policy file** on the host:
```bash
cp -p runtime/generated/iam-policies.json ~/qa-iam-backup.json 2>/dev/null || echo "no custom policy file yet -- defaults in use"
```
Restore with `cp ~/qa-iam-backup.json runtime/generated/iam-policies.json && dune console restart` if a test case leaves the policy in a bad state.

---

## Part 1 — Visibility and entry

### T01 · Access Control is hidden without Discord OAuth configured
1. On a build with Discord OAuth **not** configured, sign in with the admin password, open the sidebar.

**Expected:** No "Access Control" item anywhere in the sidebar. "Settings" is still visible (it's where Discord OAuth gets configured).

### T02 · Access Control appears once Discord OAuth is configured
1. Configure Discord OAuth (Settings → Discord OAuth, or the pre-login wizard) and finish setup.
2. Reload, sign in as Owner.

**Expected:** "Access Control" appears in the sidebar. Opening it shows the accordion of namespaces (Server, Players, Settings, Database, Updates, Backups, Addons, Care Package, Exchange, Vehicles, Admin/Transfer, Setup — the full action catalog).

---

## Part 2 — Grid structure and tri-state behavior

### T03 · Namespace accordion expand/collapse
1. Click a namespace header (e.g. "Players").

**Expected:** Expands to show its access-level subgroups (Read / Write / Permissions — only the subgroups that actually have actions in that namespace appear). Clicking again collapses it. The chevron icon is clearly visible and legibly sized, not a tiny glyph next to a much larger checkbox.

### T04 · Checkbox rendering
1. Expand any namespace.

**Expected:** Every checkbox (namespace header, access-level header, individual action row) renders as a normal, correctly-sized checkbox — not a full-width bordered box (this was a real, fixed bug: a global `input{width:100%}` CSS reset needed an explicit per-context override).

### T05 · Tri-state (indeterminate) header checkboxes
1. Expand a namespace/access-level group where the current tier (start with Admin) has SOME but not all actions granted (the shipped defaults should have at least one such group — e.g. Players).

**Expected:** The group's own header checkbox renders **indeterminate** (a dash, not checked or unchecked) when some but not all of its child actions are granted to that tier. It renders fully checked only when every child action is granted, and fully unchecked only when none are.

### T06 · Select-all at namespace/access-level header
1. Click an unchecked or indeterminate namespace-level header checkbox for Moderator.

**Expected:** Every action in that namespace becomes granted to Moderator — **except** any crown-jewel action that happens to live in that namespace (e.g. anything under Settings' "Permissions" group), which stays unchanged. Click the same header again (now checked) — every non-crown-jewel action in that namespace is revoked.

### T07 · Individual action toggle does not affect siblings
1. In any expanded group with 2+ actions, toggle one specific action's checkbox for Player.

**Expected:** Only that exact action's grant state changes. No sibling action in the same group changes state (this was a real, live-tested bug — a stale-closure issue that made every click only ever add a permission, never remove one, and affected the wrong row).

---

## Part 3 — Crown-jewel protection (the security-critical path)

### T08 · Crown-jewel actions are visibly excluded from select-all
1. Expand "Settings" (or any namespace containing a crown-jewel action, e.g. `settings:write`, `database:export`, `setup:write`).
2. Click that group's header checkbox to select all.

**Expected:** The crown-jewel action's own row checkbox stays unchecked and stays disabled/visually distinguished (not silently grantable) even though the header selected everything else in the group.

### T09 · The server refuses a crown-jewel grant even if the UI is bypassed
1. Using the browser's dev tools or a raw API client with a valid Owner session and CSRF token, `POST /api/settings/iam/policies` with a policy document that grants `admin` the literal action `settings:write` directly (no wildcard).

**Expected:** `400` with an error naming `settings:write` as a crown-jewel action reserved for owner. The save does **not** silently succeed (this exact bypass — a bare literal action slipping past a guard that only checked wildcard patterns — was a real, live CRITICAL finding, fixed and mutation-tested; this step re-verifies it holds on the actual deployed build, not just in the test suite).

### T10 · A saved policy change takes real effect
1. Grant Moderator a specific, currently-Denied action (pick something low-risk, e.g. a read-only action) via the grid, save.
2. Have the Moderator-mapped Discord test account sign out and back in (or wait for their session to naturally re-check), then attempt the action that maps to what you just granted.

**Expected:** The action succeeds where it previously would have been refused. Revert the grant afterward and re-verify it's refused again.

---

## Part 4 — Search and discoverability (if shipped in this build)

### T11 · Search filters and auto-expands
1. Type a partial action name or keyword into the search box (e.g. "restart").

**Expected:** Only matching namespace/access-level groups remain visible, auto-expanded so the matching action is immediately visible without a manual click. Clearing the search restores the full accordion, and any group you had manually expanded before searching is still expanded after clearing (search-driven expansion doesn't clobber manual state).

---

## Part 5 — Labels and jargon

### T12 · Ambiguous actions have plain-language descriptions
1. Find an action with a jargon-heavy internal name (e.g. anything under `admin:transfer-settings:*` or `carepackage:*`).

**Expected:** The row shows a plain-language description or label override, not just the bare `namespace:action` string with no context for what it actually does.

---

## Results

| Case | Pass/Fail/Blocked | Evidence |
|---|---|---|
| T01 | | |
| T02 | | |
| T03 | | |
| T04 | | |
| T05 | | |
| T06 | | |
| T07 | | |
| T08 | | |
| T09 | | |
| T10 | | |
| T11 | | |
| T12 | | |
