# Console IAM: AWS-Mirrored Policy/Role Editing & Maintenance — L1 Design

**Date:** 2026-08-17 (revision 2 — pivoted from "add custom tier names" to
"mirror AWS's policy/role editing and maintenance model," per explicit
operator direction after revision 1 was drafted but before any audit or
commit)
**Status:** L1 design, revision 2. Not yet audited — Layer 1 eight-hats
dispatch is the next step, per Requirement 20. Revision 1 (single-document-
per-tier, name-allowlist-only) is superseded in place; no separate document
was kept, since revision 1 was never committed or audited (nothing to point
back to that carries independent value).
**Tracking issue:** to be filed alongside this document, same commit.

---

## 1. What changed from revision 1, and why

Revision 1 solved a narrower problem: it let an owner invent a new *tier
name* by removing a hardcoded allowlist, but kept the existing **1 tier = 1
embedded policy document** model untouched. The operator's actual request —
"the WebUI IAM should mirror how AWS handles editing/maintaining IAM" — is
broader than that, and revision 1's model does not mirror AWS in a structural
sense: AWS separates **policies** (independent, named, reusable, versioned
documents) from **principals** (roles/users/groups, which *attach* zero or
more policies each). This console's current model — and revision 1's model —
conflates the two: a tier's policy has no independent identity, can't be
reused by a second tier, and has no version history.

This revision adopts AWS's real model, with three decisions locked in by the
operator before drafting (recorded here for the audit trail, not left
implicit):

1. **Full many-to-many.** Named, reusable policy documents exist
   independently of any tier; a tier attaches one or more of them (plus,
   optionally, one inline policy of its own — matching AWS's actual
   role model, which supports both attached managed policies *and* an
   inline policy on the same role).
2. **Built-in tiers stay owner-editable.** AWS's own built-in
   ("AWS managed") policies are read-only to customers — but making this
   console's 5 built-in tiers (`owner`/`admin`/`moderator`/`player`/
   `observer`) read-only would remove an existing, actively-used capability
   (owners already edit these today) and would itself be a Strict
   Requirement 0 upgrade-path break with no operator benefit. Decision:
   `managed` vs `customer-managed` becomes a **label distinguishing
   system-provided defaults from owner-created named policies**, not an
   enforcement difference — every policy, managed or not, remains editable
   by the owner tier, exactly as today.
3. **Real version history + rollback for named (attachable) policies.**
   AWS retains up to 5 versions per managed policy, exactly one "default"
   (active) version, and lets you roll back to any retained version. This
   design adopts the same 5-version cap and default/rollback mechanics.
   Consistent with real AWS behavior (not an inconsistency this design
   introduces): **inline policies are not versioned** in AWS either — only
   named/attachable policies get version history. This console's 5 built-in
   tiers keep their existing single-document-in-place editing behavior
   (as an inline policy) unless an owner chooses to also attach named
   policies to them.

---

## 2. Model comparison (verified against real AWS IAM behavior, not assumed)

| AWS concept | Before (current shipped code + revision 1) | After (this revision) |
|---|---|---|
| **Policy** — independent, named, versioned document | Doesn't exist — a "policy" is just the value at `policies[tier]`, no identity, no history | New: named `Policy` objects, own ID, up to 5 versions, one default/active version |
| **Role/principal** — attaches 0+ policies | A tier *is* its one embedded document (1:1) | A tier has an optional inline policy (unchanged shape) **plus** an ordered set of attached named-policy IDs (many-to-many) |
| **Managed vs customer-managed** | No such distinction | Label only (§1.2) — every named policy is owner-editable; `managed: true` marks the 5 system-provided defaults for UI clarity, no enforcement difference |
| **Inline policy** | This is what every tier has today, exclusively | Preserved exactly, byte-for-byte, as the tier's optional inline policy — this is the backward-compatibility anchor (§6) |
| **Version history / rollback** | None | New: named policies only (matches real AWS — inline policies aren't versioned there either) |
| **Policy Simulator** | Broken (test-tab contract bug, §4.5) | Fixed, and extended: simulate an arbitrary draft statement set, or simulate a tier's full *current* composition (inline + all attached policies) |
| **Groups** | N/A | **Explicitly out of scope** (§3) — not requested, and this console has no concept of individual IAM users to group in the first place (sessions carry a tier directly) |

---

## 3. Scope

**In scope:**
1. New, independent, named `Policy` object type: create, edit (→ new
   version), list, get, delete (only when unattached), version history,
   set-default (rollback) (§4.1–§4.2).
2. Tiers (roles) gain an **attach/detach** relationship to named policies,
   in addition to keeping their existing single inline document (§4.3).
3. New tier creation ("Add Role"), replacing revision 1's narrower version
   of the same idea — a new tier starts with an empty inline policy and
   zero attached policies; the owner then attaches existing named policies,
   creates new ones, and/or edits the tier's own inline policy (§4.3).
4. Migration of the existing on-disk format (flat `tier -> document` map)
   to the new schema, transparent to every existing install (§4.4, §6).
5. Fix the pre-existing Test-tab contract bug (found during revision 1's
   research, still real, still in the same files this design touches),
   reframed as a proper **Policy Simulator** consistent with AWS's own
   naming and behavior: test a draft statement set, or test a tier's full
   current composition (§4.5).
6. Reconcile the fourth hardcoded tier-name copy in `handoff.js` (found
   during revision 1's research, §2 of that revision) so a Discord handoff
   can hand off a session into a custom tier once one exists (§4.6).
7. Frontend: two-pane editor — a **Policies** view (list/create/edit/
   version-history/rollback, independent of any tier) and a **Roles** view
   (per-tier inline editor, unchanged in spirit from today, plus an
   attach/detach picker listing all named policies) (§4.7).
8. Fine-grained control: already exists (unchanged from revision 1's §1
   finding) — this design's contribution is entirely about the
   editing/maintenance *model* (how policies are authored, reused,
   versioned, and attached), not the permission granularity itself.

**Explicitly out of scope:**
- **IAM Groups.** Not requested, and structurally awkward to add value
  here: this console has no independent "user" identity to group — a
  session carries exactly one `tier` string, and a tier already *is* the
  unit that attaches policies. A group would only make sense if multiple
  tiers needed to share a set of attached policies as a bundle beyond what
  attaching the same policy to each tier already accomplishes; no such
  need has been identified. If one emerges, it's a small, additive
  follow-up (a `Group` is just another thing with an attached-policy list),
  not a reason to block this design.
- **AWS-provided ("managed") policy presets beyond the existing 5 tiers'
  current statements.** The 5 built-in tiers' existing statements are
  preserved as-is (§4.4 migration) and labeled `managed: true` for
  informational purposes only (§1.2) — this design does not invent new
  preset policies (e.g. an AWS-style `ReadOnlyAccess` policy usable by any
  tier) beyond what already exists. A natural, separately-scoped follow-up.
- **Assigning people to a tier.** Unchanged from revision 1 — already
  solvable via the existing Discord role-mapping/handoff mechanism.
- **Renaming or deleting a built-in tier**, and **deleting a tier that is
  the sole remaining attachment point for the owner's `settings:write`
  access** — same owner-lockout class of concern as today, addressed by
  keeping `setPolicies()`'s existing lockout check as the authority (§4.3).
- **The Discord-adapter's own, separate RBAC system**
  (`console/api/src/integrations/discord/policy.js`). Confirmed
  structurally distinct in revision 1's research; unchanged here.

---

## 4. Design

### 4.1 New data model

```js
// runtime/generated/iam-policies.json -- new shape (schema v2)
{
  "schemaVersion": 2,
  "tiers": {
    "owner":     { "inline": { "statements": [ ... ] }, "attached": [] },
    "admin":     { "inline": { "statements": [ ... ] }, "attached": [] },
    "moderator": { "inline": { "statements": [ ... ] }, "attached": [] },
    "player":    { "inline": { "statements": [ ... ] }, "attached": [] },
    "observer":  { "inline": { "statements": [ ... ] }, "attached": [] },
    "event-mod": { "inline": null, "attached": ["3f29a1e4-7c2b-4d91-9a6e-5b0c8e21f4aa"] }
  },
  "policies": {
    "3f29a1e4-7c2b-4d91-9a6e-5b0c8e21f4aa": {
      "name": "read-only-metrics",
      "managed": false,
      "defaultVersionId": "v2",
      "versions": {
        "v1": { "statements": [ ... ], "createdAt": "2026-08-17T...Z", "createdBy": "owner" },
        "v2": { "statements": [ ... ], "createdAt": "2026-08-18T...Z", "createdBy": "owner" }
      }
    }
  }
}
```

- **Policy IDs are server-generated via `randomUUID()`** (`node:crypto`) —
  confirmed as this codebase's actual, existing convention for generated
  IDs (`tasks.js:39`, `carePackage.js:343,752,759`,
  `services/publicDirectory.js:806` all use `randomUUID()`; no
  short-ID/prefix scheme exists anywhere in `console/api/src` to match
  instead — checked directly rather than assumed, correcting an earlier
  draft of this line that speculated a `pol_`-prefixed short-ID scheme
  with no basis in the real codebase). IDs are never owner-supplied — the
  owner-supplied `name` field is the human-facing
  identity; the ID is stable across renames (a rename is just an edit to
  the `name` field, not a new policy — a real, small usability win over
  revision 1's tier-name-is-the-only-identity model, where renaming was
  explicitly deferred as unsafe; a *named policy's* name is safe to change
  freely since nothing references it by name, only by ID).
- **A tier's `inline` field is nullable.** The 5 built-in tiers always have
  one (their current single document, migrated as-is, §4.4). A brand-new
  custom tier starts with `inline: null` — an owner may add one later via
  the same "edit this tier's own policy" UI action that exists today, or
  rely entirely on attached named policies.
- **Evaluation aggregates all of a tier's statements** — the tier's inline
  statements (if any) plus every attached policy's *default version's*
  statements, concatenated before the existing Deny > Allow > default-Deny
  loop runs (`policy.js`'s `evaluate()`, unchanged algorithm — this is a
  gather-then-evaluate change, not an evaluation-order change). This
  matches real AWS behavior: an explicit `Deny` in *any* attached policy
  or the inline policy wins regardless of attachment order, so **no
  attachment ordering guarantee is needed or implied** — worth stating
  explicitly since it's a common AWS misconception this design should not
  accidentally reintroduce confusion about.

### 4.2 Named policy lifecycle (create / version / rollback / delete)

New routes, all owner-only (matching the existing settings-panel
owner-only convention):

```
POST   /api/settings/iam/policies                        create (name, statements) -> {policyId, defaultVersionId}
GET    /api/settings/iam/policies/{policyId}              get (all versions + default marker)
PUT    /api/settings/iam/policies/{policyId}               edit -> creates a NEW version, sets it default
POST   /api/settings/iam/policies/{policyId}/rollback      body {versionId} -> sets an existing version as default (no new version created)
DELETE /api/settings/iam/policies/{policyId}/versions/{versionId}   delete a specific non-default version
DELETE /api/settings/iam/policies/{policyId}               delete the whole policy (only if zero tiers currently attach it)
```

- **Version cap: 5, matching AWS exactly.** A 6th `PUT` (edit) on a policy
  already at 5 versions is rejected with a clear error naming the oldest
  non-default version and instructing the owner to delete it first —
  mirroring AWS's own real UX for this exact limit, rather than silently
  evicting the oldest version (silent eviction would be a surprising,
  hard-to-audit data loss; AWS's explicit-rejection behavior is the safer,
  more auditable choice and is also just what "mirror AWS" means literally
  here).
- **The default version cannot be deleted directly** — must `rollback` to
  a different version first, then delete the now-non-default one. Matches
  AWS's real constraint for the same reason: a policy must always resolve
  to exactly one active version whenever it's attached somewhere.
- **A policy cannot be deleted while attached to any tier** — the delete
  route checks `tiers` for any `attached` array containing this
  `policyId` and rejects with the list of attaching tiers if found. This
  mirrors AWS's real "detach from all entities first" constraint and
  avoids a tier silently losing statements it was relying on.
- **`createdBy` is the session's tier at creation/edit time** (`"owner"` in
  practice, since only the owner tier reaches these routes) — a minimal,
  already-available piece of audit context, not a new identity system.

### 4.3 Tiers (roles): inline policy + attach/detach

```
POST   /api/settings/iam/tiers                     create ({tier: "event-mod"}) -> {inline: null, attached: []}
PUT    /api/settings/iam/tiers/{tier}/inline        set/replace this tier's OWN inline policy (statements) -- this is the direct successor of today's PUT /api/settings/iam/policy for a single tier
PUT    /api/settings/iam/tiers/{tier}/attach        body {policyId} -> adds to attached[] (idempotent if already attached)
PUT    /api/settings/iam/tiers/{tier}/detach        body {policyId} -> removes from attached[]
```

- **`resolveSessionTier()`'s check becomes**: a session's tier is valid iff
  `tiers[tier]` exists in the store (an object with `inline`/`attached`
  keys, possibly both empty) — the direct successor of revision 1's
  `getAllPolicies()[tier]` truthy check, adjusted for the new shape.
- **New tier names still require `RESERVED_TIER_NAME_PATTERN`**
  (`^[a-z][a-z0-9_-]{1,31}$`, unchanged from revision 1, §8 item 1 there
  still open re: exact charset — carried into this revision's own §8).
- **The owner-lockout guard is unchanged in spirit, reapplied to the new
  shape**: before accepting any write that changes `tiers.owner` (its
  inline policy, or its attached-policy list), re-run the existing check —
  does the *resulting, fully-aggregated* owner policy (inline + every
  attached policy's default version, §4.1) still grant `settings:write`?
  This is a strictly more correct version of today's check (today only
  looks at the one embedded document; this looks at the full aggregate,
  which is the actual thing that matters once attachment exists) — not a
  new guard, an extension of the existing one to cover the new
  aggregation path.
- **Deleting a tier**: still explicitly deferred (§3, unchanged from
  revision 1) — same reasoning (what happens to a session or Discord
  mapping pointing at a deleted tier).

### 4.4 Migration: old flat-document format → new schema v2

```js
// policy.js -- loadPolicies(), extended:
function migrateIfLegacyShape(parsed) {
  // Legacy shape: { tierName: { version, tier, statements }, ... } -- no
  // top-level "schemaVersion"/"tiers"/"policies" keys at all.
  if (parsed && parsed.schemaVersion === 2) return parsed; // already current
  if (!parsed || typeof parsed !== "object") return null;

  const tiers = {};
  for (const [tierName, doc] of Object.entries(parsed)) {
    if (!doc || doc.tier !== tierName || !Array.isArray(doc.statements)) return null;
    tiers[tierName] = { inline: { statements: doc.statements }, attached: [] };
  }
  return { schemaVersion: 2, tiers, policies: {} };
}
```

- **Runs transparently on every load**, not as a one-time offline script —
  an operator who never touches IAM again after updating never notices
  anything changed; the file is rewritten to schema v2 the next time
  `setPolicies()`-equivalent write happens, and read correctly either way
  in the meantime via this in-memory migration.
- **Byte-identical evaluation for every existing install**: a migrated
  tier has `attached: []`, so `evaluate()`'s aggregation step (§4.1)
  degenerates to exactly the old single-document behavior — the
  before/after decision for every existing action/tier combination is
  provably identical, not just expected to be (§6 restates this as the
  Strict Requirement 0 upgrade-path evidence).
- **`validPolicyStore()`'s replacement** validates the new
  `{schemaVersion, tiers, policies}` shape directly; the migration
  function above is the only code path that ever produces the new shape
  from old input, and it runs before validation, not instead of it.

### 4.5 Policy Simulator (fixes the pre-existing Test-tab bug, extends it)

The contract bug found during revision 1's research is unchanged and still
real: `IamPolicyEditor.tsx` POSTs `{statements}`, the current route expects
`{action, tier}`. Fixed the same way revision 1 proposed, **plus** a second
mode matching what "mirror AWS's simulator" actually implies — AWS's Policy
Simulator lets you test either an unsaved draft policy, or a real
principal's *actual, currently-attached* full set:

```
POST /api/settings/iam/policy/test
  { "mode": "draft", "statements": [ ... ] }                        -- test a draft statement set in isolation
  { "mode": "tier",  "tier": "moderator" }                          -- test a tier's REAL current aggregate (inline + all attached policies' default versions)
  -> { "results": { "players:read": true, "settings:write": false, ... } }
```

- **`mode: "tier"` is the new capability this revision adds** over
  revision 1's draft-only fix — it directly answers "what can this role
  actually do right now, in total," which only became a non-trivial
  question once a tier's effective permissions can come from multiple
  attached policies plus an inline one; testing only the inline document
  (as today's broken UI implicitly assumed) would give an incomplete
  answer the moment any policy is attached.
- **`allKnownActions()` export, `mockPolicies` construction**: unchanged
  from revision 1's §4.4 approach, adapted to build from `tiers`/`policies`
  in `mode: "tier"` rather than a single injected document.

### 4.6 Reconciling `handoff.js`'s fourth hardcoded tier-name copy

Unchanged from revision 1 (§4.2 there) — `handoff.js`'s `VALID_TIERS`
becomes a shape check (`RESERVED_TIER_NAME_PATTERN`) rather than membership
in its own separate hardcoded list. Not affected by the policy/role model
change in this revision — `handoff.js` only ever cares about the tier
*name* string, never the policy document behind it.

### 4.7 Frontend: Policies view + Roles view

Replaces revision 1's single-editor-with-a-dynamic-tier-list plan with two
linked views, matching the AWS console's own IAM section structure (a
"Policies" list separate from a "Roles" list, cross-linked):

- **Roles view** (default landing tab): per-tier picker (dynamically
  derived from `Object.keys(catalog.tiers)`, closing the same
  `TIERS`-array drift bug revision 1 identified, §1 there) showing:
  - the tier's own inline policy (Permissions checkbox grid + JSON tab,
    unchanged behavior from today for the 5 built-in tiers — a tier with
    `inline: null` shows an empty grid with an "add an inline policy"
    affordance instead of pre-filled statements),
  - an **attached policies** list with an "Attach policy" picker (searches
    existing named policies by name) and a "Detach" action per attached
    row,
  - a read-only **effective permissions** summary combining both (reuses
    §4.5's `mode: "tier"` simulator call).
  - "New Role" button (owner-only): the direct successor of revision 1's
    same-named action, now creating a tier with empty inline + empty
    attached rather than a single empty document.
- **Policies view** (new): list of named policies (name, `managed`
  badge if system-provided, "attached to: owner, admin" style summary),
  each opening an editor with:
  - Permissions/JSON tabs (reusing the exact same checkbox-grid component
    revision 1 already confirmed is tier-name-agnostic — it's equally
    policy-identity-agnostic, since it only ever operates on a statement
    array),
  - a **version history** list (version ID, created-at, created-by,
    "this is the default" marker, "Set as default" button for any
    non-default version, "Delete" for any non-default version),
  - "Create new policy" action (owner-only).
- **Both views share the fixed Policy Simulator (§4.5)** as a common
  "Test" tab — testing a policy's draft edit before saving uses
  `mode: "draft"`; testing a role's real current effective permissions
  uses `mode: "tier"`.

---

## 5. Data/persistence

- **Schema bump, in place, same file.** `runtime/generated/iam-policies.json`
  moves from the flat legacy shape to `{schemaVersion: 2, tiers, policies}`
  (§4.1, §4.4). No new file — this is a genuine schema change to an
  existing file, migrated transparently on load, not a parallel or
  additional store.
- **`_allowedActions` cache**: still tier-name-keyed, still cleared
  wholesale on any write — unaffected by the aggregation change (§4.1),
  since the cache key is still just the tier name; what changes is only
  how `resolveAllowedActions()`'s underlying `evaluate()` gathers
  statements before checking each action, which the cache doesn't need to
  know about.
- **Backup/restore**: restoring a backup taken *before* this migration
  shipped restores the legacy flat shape, which `loadPolicies()`'s
  migration step (§4.4) reads correctly on the next start — no special
  restore procedure is needed, and this is worth stating explicitly in
  `docs/console-iam.md` since an operator restoring an old backup might
  otherwise reasonably worry a schema mismatch will break their console.
  Restoring a backup taken *after* migration but referencing a named
  policy ID that a later action deleted is not a real concern, since a
  policy can't be deleted while attached (§4.2) — a backup's attached-list
  and policies-map are always mutually consistent at the moment they were
  written.

---

## 6. Strict Requirement 0 — upgrade path

- **Existing installs with only the original 5 tier names, and no attached
  policies (true for every install today, since attachment doesn't exist
  yet), are provably unaffected.** The migration (§4.4) is deterministic
  and produces `attached: []` for every tier; `evaluate()`'s aggregation
  step (§4.1) with an empty `attached` array is exactly the old
  single-document evaluation, statement-for-statement.
- **No new required config, no new env var.** The migration runs
  automatically on load; no operator action is required to keep an
  existing console working exactly as before.
- **`handoff.js`'s change (§4.6) is unchanged from revision 1's own
  upgrade-path analysis** — still byte-identical in effect for the 5
  existing tier names.
- **The Policy Simulator fix (§4.5) has no upgrade-path concern** —
  fixing a feature that doesn't currently work has no prior behavior to
  preserve.
- **A rollback of this change itself** (an operator downgrading the
  console version after this ships, having since created named policies
  or custom tiers) is a real, if narrow, edge case worth naming rather
  than ignoring: an older console version's `validPolicyStore()` would not
  understand `schemaVersion: 2` and would fall back to `DEFAULT_POLICIES`
  (today's existing fallback-on-invalid behavior, unchanged) — meaning a
  downgrade silently reverts to the 5 built-in tiers' hardcoded defaults,
  losing any custom tiers/named policies created in the meantime (their
  *file* isn't deleted, just unreadable by the older code, so re-upgrading
  restores them). This should be called out in the changelog entry for
  this change as a known, accepted downgrade behavior, not left
  undocumented.

---

## 7. Testing strategy

- **`policy.test.js`**: 
  - migration: a legacy-shape fixture loads correctly and produces
    identical `evaluate()` results to the same fixture expressed directly
    in schema v2 with empty `attached` arrays (the direct proof for §6's
    upgrade-path claim).
  - aggregation: a tier with `inline: null` and one attached policy
    evaluates correctly; a tier with both an inline policy and an attached
    policy correctly combines both (including a Deny in the attached
    policy overriding an Allow in the inline one, and vice versa —
    proving attachment order doesn't matter, §4.1).
  - version lifecycle: create → edit (v2 becomes default) → rollback to
    v1 (v1 becomes default again, no new version created) → attempt to
    delete v1 while it's the default (rejected) → rollback to v2 → delete
    v1 (succeeds).
  - version cap: creating a 6th version is rejected with the existing 5
    intact.
  - delete-while-attached: rejected, with the attaching tier named in the
    error.
  - owner-lockout: extended to the aggregate case — attaching a policy to
    `owner` that doesn't itself grant `settings:write` is fine (the
    inline policy still does); *removing* the inline policy from `owner`
    while no attached policy grants `settings:write` is rejected, matching
    the extended guard in §4.3.
- **`handoff.test.js`**: unchanged from revision 1's plan (§4.6 is
  identical to revision 1's §4.2).
- **New `console/web` tests**: Roles view renders attach/detach
  correctly against a mock catalog; Policies view's version history
  renders and "Set as default"/"Delete" call the right routes; Simulator
  tab correctly distinguishes `mode: "draft"` vs `mode: "tier"` requests.
- **`rbacParity.test.js`**: unaffected, same reasoning as revision 1.

---

## 8. Open items for the Layer 1 eight-hats review

1. Carried from revision 1, still open: is
   `RESERVED_TIER_NAME_PATTERN`'s exact shape
   (`^[a-z][a-z0-9_-]{1,31}$`) right, or should it match `actions.js`'s
   own prevailing namespace convention more precisely?
2. Should there be a maximum number of named policies and/or custom tiers
   (a sanity/DoS-adjacent bound), given both are now owner-creatable
   without limit in this design as drafted?
3. Confirm with the Security hat: does the many-to-many attach model
   introduce any new privilege-escalation path beyond what direct
   owner/admin-tier editing already allows today — specifically, can an
   owner ever end up in a state where `tiers.owner`'s *aggregate*
   permissions silently lose `settings:write` through a sequence of
   individually-valid attach/detach/version-rollback operations that the
   extended lockout guard (§4.3) doesn't actually catch because it only
   checks the state *after* one operation at a time? (e.g., does a
   rollback on an *attached* policy correctly re-trigger the owner-lockout
   check, or only a direct edit/attach/detach on the tier itself?)
4. Confirm with the DBA/Architect hats: is an in-place schema migration on
   every `loadPolicies()` call (§4.4) the right place for this, or should
   migration run once at startup and persist the migrated shape
   immediately (avoiding repeated migration work on every read, though
   the current code already re-reads the file fresh only at startup, not
   per-request, so this may be a non-issue — verify against the actual
   call sites before deciding).
5. Role deletion and renaming remain deferred (§3, unchanged from
   revision 1) — same question as before: should this document's tracking
   issue also file those as named follow-ups now?
6. Does `docs/console-iam.md` need a full rewrite to describe the new
   Policies/Roles split, or an additive section alongside the existing
   description? (Documentation-currency requirement, §14 of the account
   README — this is a merge blocker, not a follow-up, once implementation
   lands.)
7. UI hat: is a two-view (Policies / Roles) split, versus a single unified
   view with an "attached policies" section inline in the Roles view and
   policies only ever created *from* that context (no standalone Policies
   list), the better match for how AWS's own console actually flows for a
   user who's never used multi-policy IAM before? AWS's own IAM console
   does support both a standalone Policies list and creating on to attach
   in one dialog — worth deciding whether both entry points are worth
   building in v1 or whether the standalone Policies list alone is
   sufficient for v1, with the attach-and-create shortcut deferred.
</content>
