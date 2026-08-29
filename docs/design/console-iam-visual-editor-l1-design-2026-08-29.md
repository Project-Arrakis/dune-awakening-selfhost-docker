# Console Access Control: AWS-IAM-Visual-Editor-style Permissions Tab — L1 Design

**Date:** 2026-08-29
**Status:** L1 design, revision 1, submitted for Eight Hats Layer 1 audit before implementation.
**Tracking issue:** `dune-awakening-selfhost-docker#634`.
**Originated from:** live-testing feedback during PROMPT 2 validation of the layered-auth upstream PRs (#577/#201 Tier 3, #578/#202 Tier 1) — see the Access Control UX findings and the crown-jewel-Deny hardening (commit `245aba25` on `tier1-upstream`) recorded on tracking issue #575. This document is a distinct, separate feature built on top of that hardening, not a continuation of the layered-auth PRs themselves.

---

## 1. Why

Live operator testing of the existing Access Control (IAM policy) editor surfaced a consistent pattern: individual action labels are frequently opaque jargon (`Mutate`, `Vehicles Read`) with no indication of what they grant or why a checkbox won't respond, and the flat, always-expanded, ungrouped-by-severity layout of ~150 actions across ~20 namespaces makes it hard to scan "what's safe to grant vs. what's dangerous" at a glance. The operator specifically referenced AWS IAM's Visual Editor (the create-policy UI: a collapsible list of AWS services, each expandable into actions grouped by access level — List / Read / Write / Permissions management / Tagging — with a header checkbox to grant an entire service or level at once) as the interaction model to mirror.

This is a real, validated usability gap, not a hypothetical one: three separate rounds of live-testing feedback in this same session (the "Mutate" label, the "Vehicles Read"/"Skill Catalog" namespace collision, and the admin-vs-moderator Deny asymmetry question) all trace back to the same root cause — the current grid exposes the raw policy-engine vocabulary directly to the operator with minimal translation.

## 2. Verified current state (2026-08-29, checked against `main`@`c4b248ad`)

- **`console/web/src/features/settings/IamPolicyEditor.tsx` (327 lines)** renders one flat, always-expanded card per namespace (`groupedActions`, keyed by a hardcoded `namespaceOrder` array), each card listing every action in that namespace as an individually-clickable checkbox row with a mechanically-derived label (`actionLabel()`: title-case the raw action's suffix). There is no group-level "select all," no collapse/expand, and no access-level sub-grouping.
- **The crown-jewel Deny hardening (`ACTION_DESCRIPTIONS`, `ACTION_LABEL_OVERRIDES`, and `setPolicies()`'s crown-jewel save guard) exists only on `tier1-upstream`@`245aba25` (internal PR #578), not yet on `main`.** This design assumes that hardening lands on `main` before or alongside this feature's implementation (it will, once #577/#578 clear PROMPT 2 and are reconciled back per this project's stacking model) — this document does not re-specify it, and this feature's crown-jewel-exclusion behavior (§4.1) depends on `CROWN_JEWEL_DENY_ACTIONS` and the save-time guard already existing in `policy.js`.
- **`console/api/src/actions.js` (516 lines)** has three tables that are the actual source of truth for what actions exist and how they're reached: `ROUTE_ACTIONS` (literal `"METHOD /path"` → action), `REGEX_ACTIONS` (method-agnostic path-prefix → action), `REGEX_ACTIONS_BY_METHOD` (method + regex → action). Every one of these is keyed or valued by an HTTP method, which is what §4.2's derived access-level classification reads.
- **`test/rbacParity.test.js`** already statically parses `server.js`'s route dispatcher and fails CI if any route has no action assigned in the tables above ("parity: every non-adapter route in handleApi has an IAM action") — the existing completeness-gate precedent this feature's own access-level completeness test (§4.2) follows.
- **The catalog endpoint (`GET /api/settings/iam/policies`)** already returns `actions`, `actionMap`, `allActions`, and `namespaces` computed from the same three tables — the grid's action list is already fully auto-detected with zero separate registration step; this feature does not change that.

## 3. Scope

**In scope:**
1. Rework the Permissions tab's rendering into a two-level accordion: namespace groups (collapsed by default) → access-level sub-groups (Read / Write / Permissions Management) → individual action rows.
2. A tri-state "select all" checkbox at both the namespace level and each access-level sub-group level.
3. Derived access-level classification (§4.2) — no hand-maintained per-action map.
4. Search auto-expands any group/sub-group containing a match, and auto-collapses back when the query is cleared.

**Explicitly out of scope:**
- **The JSON tab and Test tab.** Both are unchanged — this is a Permissions-tab-only rework. An operator who prefers raw JSON editing loses nothing.
- **AWS's "Resources" (ARN pattern) and "Conditions" dimensions.** This console's actions are tier-wide, not scoped to individual objects (a documented, existing follow-up in `policy.js`'s own comments: "ownership-based access... tracked separately"), and there is no request-context concept (time of day, source IP, tags) equivalent to AWS's Conditions. Both dimensions are dropped rather than stubbed with a UI that does nothing.
- **AWS's "List" and "Tagging" access levels.** Neither maps to anything in this catalog (no list-vs-get distinction; no tagging concept at all) — shipping either as an always-empty category would be worse than not having it.
- **Multi-statement policy documents (AWS lets one policy have several independent statement blocks).** Each tier's policy document here is small enough (one Allow, one Deny) that multiple independent visual "statements" would add UI complexity with no real benefit; the existing Allow/Deny-pair model is unchanged.

## 4. Design

### 4.1 Interaction model and save semantics

Each namespace card becomes a collapsible section (default collapsed) with a header row: `[tri-state checkbox] Namespace Name (N/M allowed) [chevron]`. Expanding it reveals up to three access-level sub-sections (only levels with at least one action in that namespace render at all), each with its own tri-state header checkbox, expanding further into the existing individual action rows (label, lock icon, tooltip — unchanged from the current grid).

**Tri-state semantics** (unchecked / indeterminate / checked), computed the same way at both levels: unchecked if zero actions in the group are granted, checked if all are, indeterminate otherwise. This requires no new state — it's a pure function of the existing `allowedActions` set already computed by `actionGrantedByStatements`.

**Checking a group-header box grants every ungranted, grantable action in that group as an individual, literal Allow entry** (decision, not a namespace/level wildcard) — every row stays individually toggleable afterward, exactly matching how a single-action checkbox behaves today. This was chosen over a wildcard (`namespace:*`) specifically because a wildcard-granted row shows as 🔒 locked under the grid's existing `lockReason()` logic ("granted by a wildcard rule — edit in the JSON tab"), which would defeat the "drill in for fine-grained control" purpose immediately after using select-all.

**Crown-jewel exclusion.** If a group contains a crown-jewel action (per `CROWN_JEWEL_DENY_ACTIONS`) for a non-owner tier, "select all" silently excludes it from the literal grant and shows a small inline note ("owner-only: give-items/currency, N more") rather than either (a) granting it and having `setPolicies()`'s save guard reject the whole save, or (b) failing "select all" outright with no explanation. The individual action row remains visible and 🔒-locked underneath, same as today.

**Unchecking a group-header box revokes every currently-granted literal action in that group.** An action granted by a wildcard or Deny-blocked (already locked today) is left untouched and still shows its existing lock hint — group-level toggling only ever touches the same "exact Allow literal" actions an individual checkbox can already cleanly toggle.

### 4.2 Access-level classification (derived)

A new pure function in `iamPolicy.ts` (shared, testable in isolation, mirroring how `actionGrantedByStatements`/`iamActionAllowed` are already shared between the grid and its tests):

```ts
function accessLevelForAction(action: string, routeMethods: Set<string>): "read" | "write" | "permissions" {
  const ns = action.split(":")[0];
  if (CROWN_JEWEL_DENY_ACTIONS.includes(action) || ns === "settings" || ns === "setup") return "permissions";
  const mutatingMethods = ["POST", "PUT", "PATCH", "DELETE"];
  if (mutatingMethods.some(m => routeMethods.has(m))) return "write";
  return "read";
}
```

`routeMethods` is a new field the catalog endpoint adds per action — the set of HTTP methods across `ROUTE_ACTIONS`/`REGEX_ACTIONS`/`REGEX_ACTIONS_BY_METHOD` that reach it (computed once, server-side, from tables that already exist; not a new source of truth). A parameterized action with no literal route entry (there are a handful — see `distinctActions()`'s `allActions` fallback) defaults to `read` unless it matches an existing `-write`/`:write`/`-mutate` naming convention, consistent with how `actionLabel()` already treats action-name conventions as meaningful.

**New completeness test**, alongside the existing `rbacParity.test.js` precedent: every action returned by the catalog resolves to exactly one of the three levels, with none falling through to an "unclassified" bucket. This is mechanical and self-updating — a future action is classified automatically from its own route method, with zero maintenance burden, the same property `rbacParity.test.js` already guarantees for action-assignment-at-all.

### 4.3 Search

The existing search box (filters by action string or label substring) is extended to auto-expand any namespace card and access-level sub-section containing at least one match, and restore the prior collapse state when the query is cleared (a small piece of local component state: `expandedBeforeSearch`, snapshotted on first keystroke, restored on clear). This is required, not optional — a collapsed-by-default grid with no search-expand would make an existing match invisible.

### 4.4 Testing plan

- Unit tests for `accessLevelForAction()` covering all three levels plus the parameterized-action fallback, in the same file/pattern as `IamPolicyEditor.grouping.test.ts`.
- The new access-level completeness test (§4.2), run against the real catalog the same way `rbacParity.test.js` runs against the real route table.
- Contract/render tests (extending `IamPolicyEditor.contract.test.tsx`'s existing pattern) for: tri-state checkbox states at both levels; select-all writing literal actions, not a wildcard; crown-jewel exclusion-with-note on select-all for a non-owner tier; search auto-expand and restore-on-clear.
- No changes to `policy.js`'s evaluation semantics are needed — this is purely an editor-UI feature over the existing Allow/Deny model, so no new API contract tests beyond the catalog endpoint's new `routeMethods` field are required.

## 5. Open questions for Layer 1 review

1. Is deriving access level from HTTP method actually a reliable-enough signal, or are there real actions where "the route happens to be a POST" doesn't match "this is meaningfully more dangerous than a read" (e.g., a POST that only triggers a cache refresh)? If so, does that need an explicit override list for just those exceptions, or is the 3-level model too coarse to be trustworthy?
2. Does silently excluding a crown-jewel action from "select all" (rather than failing loudly) risk an operator not noticing a permission they expected wasn't actually granted? Is the inline note sufficient, or does this need a stronger confirmation step?
3. Is there any real user (not just this session's operator) for whom the collapsed-by-default change makes the *common* case (checking one specific, already-known permission) slower, not faster?
