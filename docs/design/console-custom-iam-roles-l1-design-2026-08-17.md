# Console IAM: AWS-Mirrored Policy/Role Editing & Maintenance — L1 Design

**Date:** 2026-08-17 (revision 2 — pivoted from "add custom tier names" to
"mirror AWS's policy/role editing and maintenance model," per explicit
operator direction after revision 1 was drafted but before any audit or
commit)
**Status:** L1 design, revision 3. Layer 1 eight-hats audit complete — all
8 hats dispatched independently per Requirement 20, all CRITICAL/HIGH
findings resolved in-document (see §9 for the full findings register).
L1-H1 (concurrency control), the one finding deferred to L2 at the time
of the audit, has since been resolved during L2 implementation — not by
adding a lock, but by discovering and then deliberately preserving a
structural property (full synchronicity of the mutation path) that
already made the feared race impossible; verified by a 200-iteration
adversarial stress test, not assumed (§9's L1-H1 row has the full
evidence and the durable invariant this now depends on). Revision 1
(single-document-per-tier, name-allowlist-only) is superseded in place;
no separate document was kept, since revision 1 was never committed or
audited (nothing to point back to that carries independent value).
**Tracking issue:** [#335](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues/335).
**PR:** [#336](https://github.com/yacketrj/dune-awakening-selfhost-docker/pull/336) (draft, pending L2 planning).

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
- **Aggregation failure semantics are fail-closed, not fail-open — this is
  a required, non-optional property, added after Layer 1 audit (Finding
  L1-C2/C3, §9).** If any `attached[]` entry's `policyId` does not resolve
  to a real entry in `policies`, or a policy's `defaultVersionId` does not
  resolve to a real entry in that policy's `versions`, the aggregation step
  MUST treat this as if that attached policy's statements are exactly one
  `{Effect: "Deny", Action: "*"}` statement for the purposes of this
  evaluation — i.e., a dangling/unresolvable reference denies everything
  it would have covered, it never silently vanishes from the aggregate.
  This is the opposite of the naive "just skip it" implementation the
  Layer 1 audit's Architect hat traced through the unchanged `evaluate()`
  loop and found fails **open** (silently dropping a Deny re-grants
  whatever it was blocking) — the naive approach is explicitly rejected
  by this design, not left to implementer discretion. This must ship with
  a corresponding test (§7) asserting exactly this behavior, since it is
  the single most security-critical property this revision introduces.
- **This aggregation-failure guard is also the backstop for referential
  integrity**, but is not a substitute for preventing dangling references
  in the first place — see §4.4's extended `validPolicyStore()` check.

### 4.2 Named policy lifecycle (create / version / rollback / delete)

New routes, all gated on the `settings:write` action per the existing
capability model (see the precision note below), matching the existing
settings-panel convention:

**Precision required after Layer 1 audit (Security hat, Finding
L1-H-precision, §9): "owner-only" is not an identity check anywhere in
this codebase — there is no `requireOwner()` gate in `server.js`/`auth.js`.
It is an emergent property of which tier(s) the aggregate policy store
currently grants `settings:write` to (by default, only `owner`, since
`admin`'s default policy explicitly `Deny`s `settings:*`). This is a safe
default and not a defect, but the design must state it precisely: every
route below needs an explicit `ROUTE_ACTIONS` entry mapping it to
`settings:write` (or another named action, decided at L2) in `actions.js`
— an unmapped route fails closed to 403 for everyone including the real
owner, which is safe but must not be left to implementer discretion
whether to add the mapping at all.**

**Dispatch mechanics required after Layer 1 audit (Architect hat, Finding
L1-H2, §9): every parameterized route below (`{policyId}`, `{versionId}`,
`{tier}`) requires real regex-based dispatch in `server.js`, following
the exact precedent already established for `/api/database/*` and
`/api/bases/*`'s `REGEX_ACTIONS_BY_METHOD_PATTERN` table (`actions.js`) —
plain `path === "literal"` matching (used by today's single IAM route)
does not work for these. Critically, `rbacParity.test.js`'s static route
extractor (`extractRoutes()`) was found to have no parsing branch for
`.match(/regex/)`-declared routes — only literal/template/`startsWith`
forms. Every new parameterized route in §4.2/§4.3 must be added to
`REGEX_ACTIONS_BY_METHOD_PATTERN` (matching the existing precedent) AND
`rbacParity.test.js`'s extractor must be confirmed (or extended, if
needed) to actually see these routes before this design's L2 test
coverage claims can be trusted — this is a mechanical verification step,
not optional, and must happen before/alongside implementation, not
discovered after CI passes green on a false sense of coverage.**

```
POST   /api/settings/iam/policies                        create (name, statements) -> {policyId, defaultVersionId}
                                                           -- rejected once 50 named policies already exist (§8 item 2, resolved)
GET    /api/settings/iam/policies/{policyId}              get (all versions + default marker) -- the ONLY route that
                                                           returns full version history; GET .../policies (list, §4.7)
                                                           returns each policy's default version only, per §8 item 2
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
                                                    -- rejected once 20 custom tiers already exist, not counting
                                                       the 5 built-in tiers (§8 item 2, resolved)
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
- **The owner-lockout guard is re-architected as a single choke point,
  not distributed per-route — required change after Layer 1 audit
  (Finding L1-C1, §9, independently identified by 3 of 8 hats).** The
  original plan ("re-run the existing check on any write that changes
  `tiers.owner`") was traced by the audit against the actual proposed
  routes and found to have a real, unmitigated bypass: `PUT
  /policies/{id}` (edit → new version) and `POST /policies/{id}/rollback`
  (§4.2) mutate the **policy**, never `tiers.owner` directly — so if
  `owner`'s only source of `settings:write` is an attached named policy,
  editing or rolling back that policy silently strips owner's access with
  the guard never firing at all, since the guard's trigger condition
  literally never matches those two routes.

  **Fix: every one of the 7 mutating operations in §4.2/§4.3 (create
  policy, edit policy, rollback policy, delete policy version, delete
  policy, tier inline-set, tier attach, tier detach) must funnel through
  one shared internal function** — analogous to today's single
  `setPolicies()` choke point, which is exactly *why* today's guard is
  trustworthy (there is nowhere else to write). This shared function:
  1. Applies the requested mutation to an in-memory copy of the full
     store.
  2. Re-validates the new shape (§4.4's extended `validPolicyStore()`).
  3. **Re-evaluates `settings:write` against the resulting owner
     aggregate** (inline + every currently-attached policy's default
     version, §4.1) — regardless of which of the 7 operation types
     triggered the call, and regardless of whether the mutation
     "looks like" it touched `tiers.owner` on its face. A policy-edit or
     rollback that would drop `settings:write` from *any* tier currently
     attaching it, including `owner`, is rejected by this same check —
     not by a special case, but because the check always runs against
     the resulting full store, not against the specific field that was
     written.
  4. Only then commits the in-memory copy and writes the file
     (`writeJsonAtomic(..., 0o600)` — explicit per Layer 1 audit Finding
     L1-M2, §9).
  5. Clears `_allowedActions` unconditionally (per Layer 1 audit Finding
     L1-M1, §9 — today only `setPolicies()` does this; every one of the 7
     new operations must too, or stale cached permissions persist for the
     life of the process).

  This preserves the single-writer invariant that makes today's guard
  correct, rather than trusting 7 independently-implemented handlers to
  each remember to re-derive it — matching the Layer 1 audit's Security
  and Architect hats' explicit recommendation.
- **Deleting a tier**: still explicitly deferred (§3, unchanged from
  revision 1) — same reasoning (what happens to a session or Discord
  mapping pointing at a deleted tier).

### 4.4 Migration: old flat-document format → new schema v2

```js
// policy.js -- loadPolicies(), extended. Revised after Layer 1 audit
// (Finding L1-H5, §9): the original draft returned null (whole-file
// reject, fall back to 100% stock DEFAULT_POLICIES) the instant ANY
// single tier entry failed to validate, even if every other tier in
// the file was perfectly valid. Traced by the DBA hat via direct
// execution against a 5-valid+1-malformed fixture: this silently
// reverts an operator's entire, possibly heavily-customized
// authorization policy to stock defaults on a load-time glitch in one
// unrelated tier, with no operator action, confirmation, or visible
// error beyond a generic log line. For a security-relevant file, this
// is a worse failure than salvaging what validates cleanly.
function migrateIfLegacyShape(parsed) {
  // Legacy shape: { tierName: { version, tier, statements }, ... } -- no
  // top-level "schemaVersion"/"tiers"/"policies" keys at all.
  if (parsed && parsed.schemaVersion === 2) return parsed; // already current

  // Whole-file rejection is reserved for genuinely unparseable/structurally
  // alien input, where there is no partial signal worth salvaging --
  // NOT for "one entry among several is malformed" (see below).
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const tiers = {};
  const failedTiers = [];
  for (const [tierName, doc] of Object.entries(parsed)) {
    if (!doc || doc.tier !== tierName || !Array.isArray(doc.statements)) {
      failedTiers.push(tierName);
      continue; // salvage every other tier; do not abort the whole migration
    }
    tiers[tierName] = { inline: { statements: doc.statements }, attached: [] };
  }

  if (failedTiers.length) {
    // Log explicitly which tier(s) failed and why -- an operator restarting
    // their console must be able to find out what happened, not just notice
    // permissions silently changed. One of the 5 built-in tiers failing
    // falls back to that tier's own DEFAULT_POLICIES entry (never invents a
    // default for an unrecognized custom tier name -- an unsalvageable
    // custom tier is dropped, not guessed at).
    logMigrationWarning(failedTiers); // implementation detail, exact logger TBD at L2
    for (const tierName of failedTiers) {
      if (DEFAULT_POLICIES[tierName]) {
        tiers[tierName] = { inline: { statements: DEFAULT_POLICIES[tierName].statements }, attached: [] };
      }
      // else: unrecognized custom tier name with malformed data -- dropped,
      // not defaulted. A session claiming this tier will fail to resolve,
      // matching this design's existing "no policy for this tier" behavior.
    }
  }

  if (!tiers.owner) return null; // owner must always exist post-migration -- if even the
                                   // fallback couldn't produce one, this IS the alien-input
                                   // case; fall through to the full-file DEFAULT_POLICIES path.
  return { schemaVersion: 2, tiers, policies: {} };
}
```

- **Runs transparently on every load**, not as a one-time offline script —
  an operator who never touches IAM again after updating never notices
  anything changed; the file is rewritten to schema v2 the next time
  `setPolicies()`-equivalent write happens, and read correctly either way
  in the meantime via this in-memory migration. **Verified by Layer 1
  audit (Architect hat) to run at process start only** (`server.js`'s
  single `loadPolicies()` call site) — not per-request, so this closes
  §8 Open Item #4 (revision 1/2) with no design change needed: there is
  no repeated migration cost and no race with concurrent writes via this
  call path specifically.
- **Byte-identical evaluation for every existing install**: a migrated
  tier has `attached: []`, so `evaluate()`'s aggregation step (§4.1)
  degenerates to exactly the old single-document behavior — the
  before/after decision for every existing action/tier combination is
  provably identical, not just expected to be (§6 restates this as the
  Strict Requirement 0 upgrade-path evidence).
- **`validPolicyStore()`'s replacement** validates the new
  `{schemaVersion, tiers, policies}` shape directly, **and — required
  after Layer 1 audit (Finding L1-C3, §9) — additionally verifies
  referential integrity in both directions**: every `attached[]` entry
  in every tier resolves to a real key in `policies`, and every policy's
  `defaultVersionId` resolves to a real key in that policy's `versions`.
  A store failing either check is rejected exactly like any other
  invalid shape (whole-file reject, per the genuinely-alien-input
  reasoning above — a dangling reference at *validation* time, as
  opposed to a *resolution-time* gap covered by §4.1's fail-closed
  aggregation guard, indicates file corruption, not a normal runtime
  state, and should not be silently patched over). The migration
  function above is the only code path that ever produces the new shape
  from old input, and it runs before this validation, not instead of it.

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

### 4.6 Reconciling `handoff.js`'s hardcoded tier-name copy

Unchanged from revision 1 (§4.2 there) in mechanism — `handoff.js`'s
`VALID_TIERS` becomes a shape check (`RESERVED_TIER_NAME_PATTERN`) rather
than membership in its own separate hardcoded list. Not affected by the
policy/role model change in this revision — `handoff.js` only ever cares
about the tier *name* string, never the policy document behind it.

**Correction after Layer 1 audit (Finding L1-C4, §9): this change breaks
a real, currently-green test, and the design must say so explicitly rather
than asserting "unchanged" implies "safe."** `handoff.test.js` (existing,
current) has a test — `"validatePayload rejects an invalid tier"` — that
asserts `tier: "superuser"` is rejected as `invalid_tier`. Verified by
direct regex execution: `RESERVED_TIER_NAME_PATTERN.test("superuser")` is
`true` — the proposed shape check does **not** reject this value, because
it's shaped exactly like a valid tier name, it just happens not to be one
of the 5 built-ins (which, correctly, is no longer disqualifying once
custom tiers exist). This specific test must be rewritten at L2 to use a
value that's actually malformed by shape (e.g. `"Superuser!"` or a
33+-character string) rather than merely "not one of the five" — the old
test encoded Set-membership semantics this design deliberately removes,
and the L2 implementation PR must update it in the same commit, not
discover it as a surprise CI failure.

**Scoping note, added after Layer 1 audit (GRC hat's inventory check):**
`console/api/src/services/discordAdapter.js`'s `ROLE_TIERS` (`public:0,
observer:1, admin:2`) was flagged during audit as a possible fifth
hardcoded tier-name structure. Verified: it is a structurally distinct,
3-value ordinal capability check gating the Discord bot's own
token-authenticated adapter routes (health/status/readiness), unrelated
to the console's 5-tier IAM system this design modifies. Confirmed
out-of-scope for the same reason `integrations/discord/policy.js`'s
`DISCORD_ROLE_TIERS` is already scoped out (§3) — named explicitly here
so a future reader doesn't have to re-derive this.

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
- **Policies view** (new): list of named policies fetched from the
  catalog-list route, which per §8 item 2's resolution returns each
  policy's **default version's statements only** — not full version
  history — keeping the common-case list payload small regardless of
  how many versions any individual policy has accumulated (name,
  `managed` badge if system-provided, "attached to: owner, admin" style
  summary, and a permission count derived from the default version).
  Opening a specific policy calls `GET .../policies/{policyId}` (§4.2) to
  lazily fetch its full version history only when actually needed, then
  shows an editor with:
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
- **Error surfacing — required after Layer 1 audit (UI hat, Finding
  L1-H7, §9): the backend's rejection detail must actually reach the
  owner, not be discarded.** The only existing error-handling precedent
  in this component (`catch { setJsonError("Failed to save policy"); }`)
  discards whatever detail the server sent. This is not acceptable for
  the new routes, because §4.2 deliberately designs *specific, actionable*
  rejection detail — the version-cap error names the oldest non-default
  version to delete; the delete-while-attached error names every
  attaching tier — and a generic "failed" string would make that design
  effort invisible to the only actor who can act on it. Every new
  attach/detach/rollback/delete/create call must surface the server's
  actual `error` field (and, for delete-while-attached, the specific
  list of attaching tiers) directly in the UI, not a generic failure
  message.
- **Whole-policy deletion has no UI control specified — gap, not a
  decision, per Layer 1 audit (UI hat, Finding L1-H7, §9).** §4.2 defines
  `DELETE /api/settings/iam/policies/{policyId}` (whole-policy delete),
  but no bullet above gives it a UI affordance — only per-*version*
  deletion is mentioned. Resolved for this revision: the Policies view's
  per-policy editor gains an explicit "Delete policy" action (disabled,
  with the attaching-tier list shown per the point above, when the
  policy is currently attached anywhere), with a confirmation step before
  the call fires — this is also the first genuinely irreversible action
  in this component's history (today's `savePolicy` only overwrites in
  place), so a bare, unconfirmed delete button is not acceptable UX
  regardless of the missing-affordance gap above.
- **Version-cap proactive disclosure**: the version-history list shows a
  simple "N/5 versions used" indicator at all times, not only an error
  message after the 6th attempt is already rejected (avoids an owner
  composing a real edit only to discover the cap after the fact).

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

Revised after Layer 1 audit (QA hat, Finding L1-H6, §9): the original
version of this section named only HTTP routes (§4.2/§4.3), never the
underlying `policy.js`-level function contracts, making the tests below
unwritable directly from this document as originally worded. §4.3 now
names the single shared internal mutation function these tests exercise
(the "one choke point" from the owner-lockout fix, §4.3) — tests below
are written against that function, not the routes directly, matching
`policy.test.js`'s existing style of testing `policy.js` exports rather
than going through `server.js`'s HTTP layer.

- **`policy.test.js`**:
  - migration — **expanded from a single fixture to a real matrix**, per
    Layer 1 audit (QA hat, Finding L1-H5-test, §9): a single happy-path
    fixture does not prove §6's universal upgrade-path claim. Minimum
    matrix: (a) all 5 real `DEFAULT_POLICIES` tiers migrated together,
    evaluated against a representative action set including at least one
    Deny-triggering action (`database:mutate` for admin) and the
    wildcard-only owner tier (`Action: "*"`, a string not an array —
    confirming `matchAction()`'s string/array handling survives
    migration), comparing legacy-direct `evaluate()` output to
    migrated-schema-v2 `evaluate()` output action-by-action; (b) a
    fixture with 5 valid tiers + 1 malformed tier, asserting the 5 valid
    tiers are salvaged and only the malformed one falls back to its
    `DEFAULT_POLICIES` entry (or is dropped, if unrecognized) — the
    direct regression test for the H5 migration fix above; (c)
    genuinely alien input (not an object, or an object with no tiers at
    all) still triggers full fallback to `DEFAULT_POLICIES`; (d)
    idempotency — migrating an already-`schemaVersion:2` document is a
    no-op.
  - referential integrity (**new, required per Finding L1-C3, §9**): a
    store containing a tier's `attached[]` entry with no corresponding
    `policies` key is rejected by `validPolicyStore()`; a policy whose
    `defaultVersionId` has no corresponding `versions` key is rejected
    likewise. Both are load-time rejections (whole-file, per §4.4), not
    resolution-time — proving these are caught before evaluation is ever
    attempted.
  - aggregation fail-closed behavior (**new, required per Finding
    L1-C2, §9 — the single most security-critical test this revision
    adds**): given a tier with an `attached[]` entry pointing at a
    `policyId` that does NOT exist in `policies` (simulating a dangling
    reference that somehow bypassed the referential-integrity check
    above, e.g. via direct file corruption), `evaluate()` denies the
    action the dangling policy would have covered — proving the
    fail-closed guard in §4.1 actually behaves as specified, not the
    naive fail-open "just skip it" behavior the Architect hat traced
    through the unchanged loop.
  - aggregation (general): a tier with `inline: null` and one attached
    policy evaluates correctly; a tier with both an inline policy and an
    attached policy correctly combines both (including a Deny in the
    attached policy overriding an Allow in the inline one, and vice
    versa — proving attachment order doesn't matter, §4.1).
  - version lifecycle: create → edit (v2 becomes default) → rollback to
    v1 (v1 becomes default again, no new version created) → attempt to
    delete v1 while it's the default (rejected) → rollback to v2 → delete
    v1 (succeeds).
  - version cap: creating a 6th version is rejected AND the error payload
    identifies a specific version ID to delete (**expanded per Finding
    L1-H4, §9** — the original draft checked only the boolean rejection,
    not the claimed error content); a second sub-case covers
    rollback-then-hit-cap, to pin down "oldest non-default" unambiguously
    when the default version is not the newest one.
  - delete-while-attached: rejected, with every attaching tier named in
    the error (not just one).
  - owner-lockout, full state-transition surface (**expanded from 1 to 5
    covered operation types per Finding L1-C1, §9 — this is the direct
    regression test for the redesigned single-choke-point guard, §4.3**):
    for EACH of — (i) direct inline edit removing `settings:write` from
    owner with no attached policy covering it, (ii) detaching owner's
    only `settings:write`-granting attached policy, (iii) **editing** an
    attached policy (creating a new version) that drops `settings:write`
    while it's attached to owner and owner has no other source of it,
    (iv) **rolling back** an attached policy to an older version that
    lacks `settings:write` under the same condition, (v) attaching a
    policy that does NOT grant `settings:write` to owner when owner's
    inline policy already does (must succeed — proves the guard doesn't
    over-reject safe operations) — assert (i)-(iv) are rejected and (v)
    succeeds, all via the single shared mutation function from §4.3, not
    per-route.
- **`handoff.test.js`**: **the existing `"validatePayload rejects an
  invalid tier"` test using `tier: "superuser"` must be rewritten**
  (Finding L1-C4, §9 — verified via direct regex execution that
  `RESERVED_TIER_NAME_PATTERN` accepts `"superuser"`, so this exact test
  would fail once §4.6 ships). Replace with a value that fails the shape
  check itself (e.g. `"Superuser!"` or a 33+-character string). Add a new
  case: a well-formed custom tier name (matching the pattern, not one of
  the 5 built-ins) is no longer rejected by `validatePayload()`'s shape
  check — proving the intended new capability actually works, not just
  that the old test was updated to stop failing.
- **New `console/web` tests**: Roles view renders attach/detach
  correctly against a mock catalog; Policies view's version history
  renders and "Set as default"/"Delete" call the right routes and
  surface the server's actual error detail on failure (per §4.7's
  error-surfacing requirement); Simulator tab correctly distinguishes
  `mode: "draft"` vs `mode: "tier"` requests; whole-policy delete is
  disabled with the attaching-tier list shown when a policy is attached
  anywhere, and requires confirmation when unattached.
- **`rbacParity.test.js`**: **not unaffected — requires a mechanical
  verification step per Finding L1-H2, §9.** Before relying on this
  suite for IAM-action coverage of the new routes, confirm its
  `extractRoutes()` parser actually recognizes the new
  regex-parameterized route declarations (`{policyId}`, `{versionId}`,
  `{tier}`) — its current implementation has no parsing branch for
  `.match(/regex/)`-declared routes, only literal/template/`startsWith`
  forms. If it doesn't, either extend the parser or add explicit,
  hand-written parity assertions for the new routes; either way, this
  must be confirmed working (not assumed) before this design's test
  coverage claims are trusted.

---

## 8. Open items — status after Layer 1 eight-hats review

Items below are the original revision-2 open questions, each now marked
with its resolution status per the completed Layer 1 audit (§9 has the
full findings register). Items resolved below are closed; items still
genuinely open carry into L2/implementation planning.

1. **Resolved (operator decision, pre-L2).** `RESERVED_TIER_NAME_PATTERN`
   stays `^[a-z][a-z0-9_-]{1,31}$` (hyphens/underscores allowed).
   Reasoning: a tier/role name is a different kind of identifier than an
   `actions.js` namespace — it's closer to a slug (like this project's
   own branch-naming or addon-naming conventions, which also allow
   hyphens) than to a fixed, small, hand-curated namespace enum. No hat
   raised a security or consistency objection to the original pattern;
   only a stylistic question was open, now closed by decision.
2. **Resolved (operator decision, pre-L2).** Hard cap + lazy version
   loading, both parts of the Network hat's recommendation adopted:
   (a) server-side hard caps enforced at creation — **50 named policies,
   20 custom tiers** (in addition to the 5 built-in tiers, which are not
   counted against this cap and can never be deleted) — chosen as
   generous-for-real-usage-but-bounded numbers for an owner-only,
   human-paced feature; exceeding either cap is rejected with a clear
   error, not silently truncated. (b) `GET /api/settings/iam/policies`
   returns each policy's `defaultVersionId` and its **default version's
   statements only** (not the full `versions` map) — full version
   history is fetched lazily per-policy via `GET
   /api/settings/iam/policies/{policyId}` (§4.2), which already existed
   in this design as the only place `versions` needs to be enumerable in
   full. This shrinks the common-case catalog payload independent of the
   cap and follows the same instinct already used in this codebase for
   grabbing summaries vs. detail on demand.
3. **Resolved — real gap confirmed, fixed in §4.1/§4.3/§7 above.** Both
   halves independently verified by the Security hat: custom tier names
   alone introduce no new privilege-escalation class (owner already holds
   unconditional `Allow:"*"` and can already assign any permission set to
   any of the 5 existing tiers today — extending the valid tier-key space
   doesn't raise that ceiling). But the second half — does a rollback or
   edit on an attached policy correctly re-trigger the owner-lockout
   guard — was confirmed **broken as originally specified** by 3
   independent hats (Security, DBA, QA). Fixed by re-architecting the
   guard as a single choke point (§4.3) rather than a per-route
   responsibility.
4. **Resolved, no design change needed.** The Architect hat traced the
   actual call graph and confirmed `loadPolicies()` has exactly one call
   site (`server.js`, at process start), never per-request — migration
   cost and the hypothesized race are both non-issues via this path.
   §4.4's wording above has been tightened to state this as verified
   fact rather than an open question.
5. **Still open.** Role deletion and renaming remain deferred (§3,
   unchanged from revision 1). No hat argued for pulling either into this
   revision's scope; recommend filing both as named follow-up issues
   once this design's tracking issue is updated with audit results.
6. **Narrowed, ownership gap flagged by GRC.** The content
   decision (full rewrite vs. additive section for `docs/console-iam.md`)
   is legitimately deferrable until implementation scope is final — but
   GRC's audit found this deferral, as originally worded, named no owner
   and no checkpoint, which Requirement 14 requires even for a legitimate
   deferral. Resolution: this document's tracking issue (#335) must carry
   an explicit checklist item for this doc update, owned by whoever picks
   up L2 implementation, closed only when `docs/console-iam.md` is
   updated in the same PR that ships the schema/API changes.
7. **Resolved — keep the two-view split.** Both the UI hat and the
   Architect hat independently recommended keeping Policies/Roles as
   separate views (not folding policy management entirely into the Roles
   view), for converging but distinct reasons: UI hat — a unified view
   would need to cram version-history/create/edit UI for a
   multiply-attached object into a single-tier-focused page, actively
   obscuring that a policy is shared, reusable state; Architect hat — a
   policy already has independent identity/versioning per this design's
   own §1 decisions, and building a real Policies list is unavoidable
   the first time an owner wants to inspect a policy's version history
   regardless of entry point, so a unified-only approach doesn't actually
   avoid building it. The "create-and-attach" shortcut from inside the
   Roles view's attach picker (UI hat's recommendation) is kept as
   additive sugar on top of the two-view structure, not a v1 requirement.

---

## 9. Layer 1 eight-hats audit — findings register (Requirement 20 traceability)

Added after Layer 1 audit completion, per GRC hat finding (this
document's own audit, Finding L1-H4): this project has already lost a
findings register once to an issue-comment-only closure (issue #327,
referenced in the account README) and established the fix — an
in-document traceability table — in a sibling document
(`console-layered-auth-l1-design-2026-08-17.md`, §7) the same day this
document's revision 1 was drafted. This section applies the same fix
here rather than repeating that mistake.

All 8 hats were dispatched independently (per the account README's
mandate that Layer 1 review be run as 8 actual dispatched workers, not a
solo pass) against this document's revision 2. Full per-hat reports are
preserved in the dispatching session's transcript; this table is the
durable, committed summary.

| # | Hat | Finding | Severity | Disposition |
|---|-----|---------|----------|--------------|
| L1-C1 | Security, DBA, QA (independent convergence) | Owner-lockout guard bypassed by policy edit/rollback routes, which never touch `tiers.owner` directly | CRITICAL | **Fixed** — guard re-architected as single choke point, §4.3 |
| L1-C2 | Architect | Aggregation-step failure semantics unspecified; naive implementation fails open (silently drops a Deny) | CRITICAL | **Fixed** — explicit fail-closed requirement added, §4.1 |
| L1-C3 | DBA | No referential-integrity check that `attached[]` IDs resolve to real `policies` keys (dangling-reference risk, feeds L1-C2) | CRITICAL | **Fixed** — bidirectional integrity check added to `validPolicyStore()`, §4.4 |
| L1-C4 | QA | `handoff.test.js`'s existing `"superuser"` rejection test breaks under the proposed shape-check regex (verified by direct execution) | CRITICAL | **Fixed** — test rewrite specified, §4.6 and §7 |
| L1-H1 | Architect, DBA (independent convergence) | No concurrency control on 7 new mutating routes against one unlocked in-memory store; codebase's only comparable many-to-many precedent (`discord_account_links`) uses real transactions/row-locks this design has no equivalent for | HIGH | **Resolved during L2 implementation, verified not assumed.** The L2 implementation of `applyMutation()` (§4.3's single choke point) turned out to have zero `await`/async calls anywhere in its own body or any function it calls, including `persist()` (which uses `writeFileSync`/`renameSync`, the synchronous fs API, matching the pre-existing `setPolicies()`'s own choice). This is a real structural guarantee, not a probabilistic mitigation: Node's single-threaded, run-to-completion semantics mean no second call into this choke point can execute until a first one fully returns, for as long as this synchronicity holds. Verified with a 100-iteration adversarial stress test (two "concurrent" requests racing to roll back the same policy to different versions, one of which would strip owner's `settings:write`) — zero interleaving/lost-update anomalies, committed as a permanent regression test in `policy.test.js`. **This is now a documented, enforced invariant** (see the `CONCURRENCY INVARIANT` comment directly above `applyMutation()` in `policy.js`), not an incidental property: if a future change ever needs to make any part of this path asynchronous, a real mutex (this codebase's own `Promise.resolve()`-chain pattern, already used in `addonItemGrants.js`) becomes required at that point, and the comment says so explicitly. No lock was added because none was needed for the code as actually implemented — the original L1 finding correctly identified a real risk *for a naive implementation*, and that risk was closed by verified design, not by assumption that it wouldn't matter. |
| L1-H2 | Architect | `rbacParity.test.js`'s route extractor has no parsing branch for regex-declared routes — may not see the new parameterized routes at all | HIGH | **Fixed** — explicit verification step required before/alongside implementation, §4.2 intro and §7 |
| L1-H3 | GRC | Requirement 26 (schema migration) only partially satisfied — no tested downgrade procedure, no test against production-shaped data | HIGH | **Fixed** — migration test matrix expanded (§7) to include a production-representative fixture (all 5 real `DEFAULT_POLICIES` tiers, Deny + wildcard cases); downgrade behavior remains documented-not-tested (§6) since it exercises an *older* binary's code, which cannot be unit-tested from this codebase — flagged as an accepted, explicitly-stated limitation rather than a silent gap |
| L1-H4 | GRC | No structured findings register for this audit, despite an established in-document fix pattern from a sibling document the same day | HIGH | **Fixed** — this section |
| L1-H5 | DBA | Migration's whole-file-reject-on-one-malformed-tier silently discards every valid tier's customizations | HIGH | **Fixed** — per-tier salvage logic added, §4.4 |
| L1-H6 | QA | §7's original test plan named only HTTP routes, no `policy.js`-level function contracts — tests unwritable as specified | HIGH | **Fixed** — §4.3 now names the single shared mutation function tests are written against; §7 rewritten accordingly |
| L1-H7 | UI | Backend's rejection detail (version-cap, delete-while-attached) has no specified frontend surfacing; whole-policy delete has no UI control at all | HIGH | **Fixed** — explicit error-surfacing and delete-control requirements added, §4.7 |
| L1-M1 | Architect | New mutation routes must each clear `_allowedActions` cache; only `setPolicies()` does today | MEDIUM | **Fixed** — folded into the single-choke-point function's responsibilities, §4.3 |
| L1-M2 | Cloud Security | File-permission (`0o600`) commitment never explicitly stated for new write paths | MEDIUM | **Fixed** — explicit in §4.3's choke-point function description |
| L1-M3 | Network | `GET /api/settings/iam/policies` unbounded response growth | MEDIUM | **Merged into Open Item #2** (§8) — resolution deferred to L2 alongside the policy-count-cap question, same underlying tradeoff |
| L1-M4 | Cloud Security | Concurrent-design coordination risk: both this design and `rfc-console-auth.md` touch `handoff.js`'s `VALID_TIERS`/tier-resolution logic | MEDIUM | **Accepted, tracked** — noted in this document's own tracking issue (#335); whichever implementation lands second must re-verify the other's fail-closed guarantees survive on top of its own change |
| L1-M5 | GRC | PR body's blast-radius language ("every operator's console auth") conflates authorization with authentication | MEDIUM | **Fixed** — PR body corrected in the same update that adds this section |
| L1-M6 | GRC | §8 Item 6 deferral had no named owner/checkpoint | MEDIUM | **Fixed** — Open Item #6 above now specifies the checklist-item mechanism |
| L1-M7 | Architect | `validPolicyStore()`'s hardcoded 5-tier array not explicitly named for removal alongside `resolveSessionTier()`'s equivalent | MEDIUM | **Fixed** — §4.4 now explicitly covers both |
| L1-M8 | UI | Version cap only enforced reactively; no proactive "N/5 used" indicator | MEDIUM | **Fixed** — §4.7 |
| L1-M9 | QA | Migration-parity test described as single fixture, not a matrix proving the universal upgrade-path claim | MEDIUM | **Fixed** — folded into L1-H3's resolution, §7 |
| L1-L1 | Cloud Security, GRC | Owner-pasted JSON (Action strings, policy names) has no content-based validation against accidental secret embedding — pre-existing, not introduced by this design | LOW | **Accepted, not fixed** — identical exposure exists in shipped code today; out of scope for this design to close, noted for awareness |
| L1-L2 | UI, GRC | `IamPolicyEditor.tsx`'s `TIERS` array already excludes `observer` today, independent of this design | LOW | **Confirmed, informational** — already fixed as a side effect of this design's dynamic tier derivation, §4.7 |
| L1-L3 | Security | `matchAction()`'s unescaped regex construction on owner-authored Action strings (pre-existing) has its blast radius amplified by making policies shareable/reusable across tiers | LOW-MEDIUM | **Accepted for L2 tracking, not L1 blocking** — pre-existing weakness, not introduced by this design, but this design's own reuse model increases its stakes; recommend filing as a follow-up issue to validate Action strings against an allowed charset before passing to `RegExp`, tracked separately from this design's own scope |

**CRITICAL and HIGH findings: all resolved.** All 4 CRITICAL and all 7
HIGH findings, including L1-H1 (resolved during L2 implementation with
verified, tested evidence — see its row above), have a concrete
fix committed to code, a passing regression test, or an explicit,
justified acceptance. No CRITICAL or HIGH finding was left unaddressed
or silently dropped.

---

## 10. Layer 2 eight-hats audit — findings register (Requirement 20 traceability)

Added per GRC hat finding GRC-M1 (found auditing this same PR at L2):
§9's structure was scoped explicitly to Layer 1 only, with no
established location for Layer 2 (implementation-phase) findings.
Mirroring §9's exact table structure for the same reason §9 itself
exists — a findings register living only in a dispatching session's
transcript is exactly the "lost to an issue-comment-only closure"
failure mode this project has already learned from once (issue #327).

All 8 hats were dispatched independently against the actual committed
implementation code (backend: `policy.js`, `server.js`, `actions.js`,
`handoff.js`; frontend: `IamPolicyEditor.tsx`, `IamRolesView.tsx`,
`IamPoliciesView.tsx`, `IamPermissionGrid.tsx`, `IamPolicySimulator.tsx`,
`iamTypes.ts`) — not the design document. This is the layer that found
real bugs the L1 design audit could not have caught, because a design
audit reviews a design, not code.

| # | Hat | Finding | Severity | Disposition |
|---|-----|---------|----------|--------------|
| L2-C1 | Architect | `IamPermissionGrid.tsx`'s checkbox grid completely non-functional: `groupActionsByNamespace()` grouped over `Object.values(actionMap)` (IAM action strings) instead of `Object.keys(actionMap)` (HTTP-route strings), which `nsFromAction()`/`humanLabel()` require — every checkbox appeared unchecked regardless of actual grants, every namespace fell into "Other", and every click only ever appended a permission (never removed one) | CRITICAL | **Fixed** — `groupActionsByNamespace()` corrected to iterate `Object.keys()`; verified with a real component render+toggle test before committing. Dedicated `IamPermissionGrid.test.tsx` added (previously zero coverage, isolated or indirect) |
| L2-C2 | UI (independently, Architect) | Delete-confirmation state (`confirmingDeletePolicy`/`confirmingDeleteVersion` in `IamPoliciesView.tsx`) not scoped to `selectedPolicyId` — arming a delete for policy A, then switching to policy B without clicking Cancel, left the confirm UI armed and pointed at B; same for per-version delete confirmation | CRITICAL | **Fixed** — both flags now reset in the same `useEffect` that fires on `selectedPolicyId` change, alongside clearing stale `detail` content (closes L2-H2 in the same change). Regression test added reproducing the exact cross-selection leak |
| L2-C3 | Security | `Object.prototype` pollution: every mutation function (`setTierInline`, `attachPolicy`, `detachPolicy`, `editPolicy`, `rollbackPolicy`, `deletePolicyVersion`, `deletePolicy`) took a caller-supplied `tierName`/`policyId` and used it as a bracket-access key with no shape/reserved-word validation. `PUT /api/settings/iam/tiers/__proto__/inline` (reachable by any `settings:write`-holding session, owner by default) could set `Object.prototype.inline`, corrupting every plain object in the process silently and invisibly (JSON.stringify never enumerates inherited properties) | CRITICAL | **Fixed** — explicit `isDangerousKey()`/`rejectDangerousIdentifier()` rejection (`"__proto__"`/`"constructor"`/`"prototype"`, case-insensitive) added at every mutation entry point, plus `hasOwnKey()` (`Object.hasOwn()`-based) guards replacing every bare truthy bracket-access check throughout `policy.js`, including `validPolicyStore()`'s load-time validation and `migrateIfLegacyShape()`'s per-tier salvage loop. Regression-tested across all 9 mutation exports × 6 case-variant dangerous keys, asserting `Object.getOwnPropertyNames(Object.prototype)` is byte-identical before/after |
| L2-C4 | GRC (independently, QA) | The L1-H1 "100-iteration concurrency stress test" (added to resolve the original L1-H1 finding) was a tautology: both racing `rollbackPolicy()` calls were independently, unconditionally rejected/accepted by the owner-lockout guard regardless of interleaving, so the test would pass 100/100 even with a real `await` reintroduced into `applyMutation()` — verified by both hats independently reproducing this exact false-negative in an isolated worktree | CRITICAL | **Fixed** — added a direct structural-invariant test asserting `fn.constructor.name === "Function"` (not `"AsyncFunction"`) for every one of the 10 mutation exports, plus a non-thenable-return-value check. This fails deterministically, with no dependence on timing/iteration count/scenario construction, if the synchronicity invariant is ever broken. The original 100-iteration test is kept (it does still prove the owner-lockout guard's own idempotency correctly) but is no longer the sole evidence for the concurrency claim |
| L2-H1 | DBA | `deepCopyStore()`/`getAllPolicies()` only shallow-copied nested statement objects and their `Action` arrays — a caller mutating a returned snapshot's nested array (or a future code path retaining a reference to a parsed request body) could silently corrupt live internal `_policies` state with zero validation, zero error, zero audit trail | HIGH | **Fixed** — new `deepCopyStatements()` helper genuinely deep-copies each statement object and its `Action` array; applied inside `deepCopyStore()` and at every ingest point (`createPolicy`, `editPolicy`, `setTierInline`, `migrateIfLegacyShape`) that previously stored a caller-supplied array by reference. `getAllPolicies()` (previously its own, separately-shallow `{...spread}` implementation) now delegates to `deepCopyStore()`. Regression-tested for reference INEQUALITY (not just value equality) across separate snapshots, and for post-call mutation of the caller's original array having zero effect on the stored policy |
| L2-H2 | UI | Delete-while-attached error handling: (a) no retry affordance on a per-policy detail-load failure, and re-clicking the same already-selected policy did not re-fire the fetch at all since the `useEffect` dependency hadn't changed; (b) the detail pane rendered the PREVIOUS policy's content while the next selection's fetch was still in flight, with no loading indicator | HIGH | **Fixed** — added a `fetchToken` state incremented by an explicit Retry button, included in the effect's dependency array so re-fetching no longer requires navigating away and back; `detail` is now cleared synchronously the instant `selectedPolicyId` changes (in the same effect-entry fix as L2-C2), so the loading state is shown immediately rather than stale content. Regression-tested with a deliberately-delayed mock fetch, asserting the previous policy's heading is gone before the new one resolves |
| L2-H3 | QA | `IamPermissionGrid.tsx` and `IamPolicySimulator.tsx` had zero test coverage, isolated or indirect, despite being two of the most functionally significant new pieces of this feature (confirmed by grep: zero references to "Simulator"/"checkbox"/"PermissionGrid" anywhere in the then-only frontend test file) | HIGH | **Fixed** — two new dedicated test files added: `IamPermissionGrid.test.tsx` (namespace grouping, wildcard-grant checkbox state, toggle-on/toggle-off correctness, search filtering) and `IamPolicySimulator.test.tsx` (both `draft`/`tier` request-body shapes, error surfacing, re-run) |
| L2-H4 | QA | The version-ID collision fix (`highestSeq+1`, replacing `versionCount+1`) had a manual, untracked verification script (`test_version_collision.mjs`, never committed) proving it worked, but zero durable regression coverage in the committed test suite | HIGH | **Fixed** — committed test reproducing the exact scenario (create 5 versions, roll back, delete a middle version, edit again) and asserting the new version ID doesn't collide with a still-existing one, with no data loss |
| L2-H5 | Cloud Security | `persist()`'s `0o600` file-permission write path had zero automated test coverage — every pre-existing test called every mutation function with `repoRoot=null`, so `writeJsonAtomic(..., 0o600)` was never actually exercised by `node --test`, only verified by direct manual execution during the audit itself | HIGH | **Fixed** — two committed tests using this codebase's existing `mkdtempSync`-based temp-directory convention (matching `addonItemGrants.test.js`), asserting the real file mode on disk (`statSync(path).mode & 0o777 === 0o600`) after calling representative mutation functions with a real `repoRoot` |
| L2-H6 | GRC | PR #336's risk classification still said "Medium, documentation-only (no code in this PR)" after 3 commits of real, shipped implementation code had landed | HIGH | **Fixed** — PR body updated to **High**, with an explicit note that this is a correction of a stale prior claim, not a silent edit |
| L2-H7 | GRC | `docs/console-iam.md`'s update (committed ~19 minutes before the frontend implementation) contained zero mention of the shipped UI/component structure | HIGH | **Fixed** — new "Web UI" section added describing the Roles/Policies/Simulator views and the `IamPermissionGrid.tsx` key/value-direction pitfall (L2-C1) explicitly, so a future reader doesn't reintroduce the same confusion |
| L2-M1 | GRC | The "502 passing tests across both layers" claim (issue #335 comment) did not reconcile against an independently reproduced count (503: 73+430) at the commit it described, due to reusing a stale, pre-L1-H1-fix backend count | MEDIUM | **Acknowledged** — the individual per-commit test counts were each independently confirmed accurate; only the later cross-commit arithmetic synthesis was stale. Current, exact counts as of this section: backend 82 tests (`policy.test.js`+`handoff.test.js`+`rbacParity.test.js`), frontend 441 tests (`npx vitest run`) — independently re-run immediately before writing this row, not carried forward from an earlier claim |
| L2-M2 | Architect | `rbacParity.test.js`'s route extractor is a regex/brace-counting parser of `server.js`'s literal source text, not the real dispatcher — coupled to `server.js`'s exact code shape, with no test asserting the extractor itself stays correct against a future refactor | MEDIUM | **Acknowledged, not fixed** — a real, pre-existing structural fragility (already responsible for L1-H2's original gap), out of scope to redesign in this change; tracked as a follow-up on #335 |
| L2-M3 | UI | The "N/5 versions" proactive disclosure (§4.7, resolving L1-M8) is genuinely visible within the detail pane once a policy is opened, but not surfaced in the Policies LIST itself — an owner scanning the list to decide what needs cleanup must open each policy individually | MEDIUM | **Acknowledged, not fixed** — `versionCount` is already present on every `PolicySummary` and would be a small addition; deferred as UI polish, tracked as a follow-up on #335 |
| L2-M4 | UI | The attach-policy picker's search input (`IamRolesView.tsx`) has no accessible name (`<label>`/`aria-label`) and its results list has no keyboard-navigation pattern, regressing from the accessible `<label>`-wrapped-checkbox pattern used one file away in `IamPermissionGrid.tsx` (itself inherited faithfully from the pre-rewrite original component) | MEDIUM | **Acknowledged, not fixed** — a real, avoidable inconsistency introduced during this implementation (not a pre-existing gap the L1 audit could have flagged); tracked as a follow-up on #335. Functionally still usable via Tab order |
| L2-M5 | UI | `inlineDraftStarted` (the fix for the empty-inline-policy-grid bug) gives a first-time custom-tier owner no visual distinction between "starting a brand-new draft" and "editing an existing, currently-empty inline policy" | MEDIUM | **Acknowledged, not fixed** — minor UX polish, not a functional defect; tracked as a follow-up on #335 |
| L2-L1 | DBA | `migrateIfLegacyShape()`'s doc comment slightly undersells which input shapes trigger its `null` return (a non-alien object simply missing an `"owner"` key also hits this path, not only genuinely alien input) | LOW | **Fixed in passing** — clarified during the L2-C3 fix to this same function (the dangerous-key salvage logic was added directly adjacent to this comment) |
| L2-L2 | DBA, Network | Pre-existing, out-of-scope observations confirmed unaffected by this change: orphaned `*.tmp` file cleanup gap in `writeJsonAtomic()` (shared across 5 files, none touched here); `oauth.js`'s pre-existing fail-open bug (confirmed byte-identical between `main` and this branch) | LOW | **Confirmed out of scope, no action** — both predate this PR and are unrelated to the files this PR touches |

**CRITICAL and HIGH findings: all resolved with committed fixes and regression tests**, verified by re-running the full test suite after every fix (backend: 82/82 passing; frontend: 441/441 passing — both counts independently reproduced at the time this section was written, not carried forward from an earlier claim, per the L2-M1 lesson this same table records). 5 MEDIUM findings and 1 LOW finding are acknowledged, tracked as follow-ups on issue #335, and do not block this PR — consistent with Requirement 20's own framing that MEDIUM findings require "explicit deferral justification," which each row above provides.

**A note on why this layer mattered**: every one of the 4 CRITICAL and most of the HIGH findings in this table are implementation-level defects that no amount of additional L1 design review could have caught, because they didn't exist until code was written — a key/value direction bug in a specific function, a missing effect-dependency reset, an unsanitized bracket-access key, a test that happens to pass regardless of correctness. This is exactly the class of error Requirement 20's Layer 2 (implementation) audit exists to catch before it reaches Layer 3 (integration) or an upstream PR, and this session's own experience writing the implementation is direct, first-hand confirmation of that rationale, not just a policy this project asserts abstractly.
</content>
