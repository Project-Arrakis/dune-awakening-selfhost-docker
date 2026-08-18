# Console IAM Architecture

The Web Console applies an IAM action to every authenticated API route. Public authentication and health routes remain outside this gate, and Discord adapter routes continue to use their existing bearer-token and Discord capability checks.

## Authorization flow

1. `auth.js` verifies the opaque `asc_session={id}.{HMAC(id)}` cookie and loads the server-side session.
2. `actions.js` maps the request method and path to one action such as `players:read` or `server:restart`.
3. `policy.js` evaluates the session tier using explicit-deny precedence: Deny, then Allow, then default Deny.
4. An unmapped authenticated route is denied. `rbacParity.test.js` prevents new routes from being merged without a mapping.

Session tier and identity stay in the in-memory session store; they are not placed in the browser cookie. A Console process restart invalidates existing sessions, matching the previous session lifecycle and preventing stale role claims from surviving a restart.

## Policies and roles

The default policies preserve full owner access and provide conservative defaults for the built-in admin, moderator, player, and observer tiers. Password logins and `ADMIN_AUTH_DISABLED=1` create owner sessions, so existing Console installations keep their current behavior.

Since schema v2 (see `docs/design/console-custom-iam-roles-l1-design-2026-08-17.md` for the full design and its audit trail), the Console mirrors AWS IAM's own editing model: a **tier/role** attaches zero or more independently-named, versioned **policies**, in addition to keeping one optional inline policy of its own. This replaces the earlier model where a tier's policy was a single embedded document with no identity, no version history, and no reuse across tiers.

The on-disk store (`runtime/generated/iam-policies.json`) uses this shape:

```json
{
  "schemaVersion": 2,
  "tiers": {
    "owner": { "inline": { "statements": [{ "Effect": "Allow", "Action": "*" }] }, "attached": [] },
    "event-mod": { "inline": null, "attached": ["<policyId>"] }
  },
  "policies": {
    "<policyId>": {
      "name": "read-only-metrics",
      "managed": false,
      "defaultVersionId": "v1",
      "versions": {
        "v1": { "statements": [{ "Effect": "Allow", "Action": "server:read" }], "createdAt": "2026-08-18T00:00:00.000Z", "createdBy": "owner" }
      }
    }
  }
}
```

`Action` may be one string or an array. Exact actions, namespace wildcards such as `players:*`, and `*` are supported. A tier's effective permissions are the union of its own inline statements plus every attached policy's **default** version's statements; attachment order does not affect the result, since an explicit Deny anywhere in the aggregate always wins over an Allow, exactly as within a single document today. An operator upgrading from a pre-schema-v2 install needs no manual action — the store is migrated transparently on the next Console start, tier-by-tier (a single malformed tier does not discard the rest), with byte-identical evaluation results for every tier/action combination that existed before the upgrade.

**Built-in tiers stay fully owner-editable** — mirroring AWS's managed-policy concept only as a `managed: true` label for clarity, not as a read-only enforcement difference, since making the 5 shipped tiers read-only would remove an existing, already-used capability.

**Resource bounds**: 50 named policies, 20 custom tiers (the 5 built-in tiers are exempt from this cap and cannot be deleted), 5 versions per named policy. These are owner-only, human-paced limits, not expected to be reached in normal use.

The policy API is owner-only under the default policy (gated on the `settings:write` action — see "Authorization flow" above; there is no separate identity check):

- `GET /api/settings/iam/policies` returns every tier and every named policy's **default version only** (not full version history, to keep this response small regardless of how many versions a policy has accumulated).
- `GET /api/settings/iam/policies/{policyId}` returns one policy's full version history.
- `POST /api/settings/iam/policies` creates a new named policy.
- `PUT /api/settings/iam/policies/{policyId}` edits a policy, creating a new version and making it the default.
- `POST /api/settings/iam/policies/{policyId}/rollback` sets an existing version as the default without creating a new one.
- `DELETE /api/settings/iam/policies/{policyId}/versions/{versionId}` deletes a specific non-default version (the default version cannot be deleted directly — roll back to a different version first).
- `DELETE /api/settings/iam/policies/{policyId}` deletes a policy, only if it is not currently attached to any tier.
- `POST /api/settings/iam/tiers` creates a new tier/role.
- `PUT /api/settings/iam/tiers/{tier}/inline` sets or replaces a tier's own inline policy.
- `PUT /api/settings/iam/tiers/{tier}/attach` / `.../detach` attach or detach a named policy from a tier.
- `PUT /api/settings/iam/policy` (legacy, still supported) validates and atomically saves a flat per-tier statement map, matching the pre-schema-v2 contract — existing callers of this route are unaffected.
- `POST /api/settings/iam/policy/test` (Policy Simulator) evaluates either a draft statement set (`{"mode": "draft", "statements": [...]}`) or a tier's real, current, fully-aggregated permissions (`{"mode": "tier", "tier": "moderator"}`) without changing policy.

**Every mutating write is rejected if it would remove the owner tier's aggregate `settings:write` access** — including through an attached policy's edit, rollback, or detachment, not only a direct edit to the owner tier itself — so the local-password recovery path remains available. All 7 mutating operations funnel through a single internal choke point specifically so this guard cannot be bypassed by any one of them individually; see the `CONCURRENCY INVARIANT` comment above `applyMutation()` in `policy.js` before making any of that code path asynchronous.

Restoring a backup of `iam-policies.json` taken before the schema v2 upgrade shipped works with no special procedure — the same transparent migration that runs on every Console start also applies to a restored legacy-shape backup.

## Web UI

The Console's "Access Control" settings panel (`console/web/src/features/settings/IamPolicyEditor.tsx`) presents two linked views, matching the split above between tiers/roles and named policies:

- **Roles** (`IamRolesView.tsx`) — a per-tier picker, dynamically derived from the live catalog (never a hardcoded tier list), showing that tier's own inline policy (Permissions checkbox grid or raw JSON), an Attached Policies tab (attach/detach picker), and a Test tab (the Policy Simulator in `mode: "tier"`). An owner-only "New Role" action creates a custom tier.
- **Policies** (`IamPoliciesView.tsx`) — a standalone list of named policies, independent of any tier, with create/edit/version-history (including "Set as default" and delete-a-non-default-version) and a confirmed, owner-only whole-policy delete action.
- **Policy Simulator** (`IamPolicySimulator.tsx`) — shared by both views' Test tabs; supports `mode: "draft"` (an unsaved statement set) and `mode: "tier"` (a real tier's current, fully-aggregated permissions).
- **`IamPermissionGrid.tsx`** — the checkbox-per-permission grid, extracted so both views share one implementation. It renders and toggles permissions keyed by the catalog's HTTP-route strings (`actionMap`'s keys, e.g. `"GET /api/server/status"`), not the underlying IAM action strings (`actionMap`'s values, e.g. `"server:read"`) — the two are easy to confuse and a prior implementation bug (now fixed and regression-tested) grouped/matched by the wrong one, which silently made every checkbox appear unchecked and broke namespace grouping entirely.

Every mutating action's backend rejection message (e.g. which tiers block a policy delete, or the specific owner-lockout reason) is surfaced verbatim in the UI, not replaced with a generic failure string — see `errorText()` in `iamTypes.ts`.

## Route maintenance

When adding an authenticated API route, add its method/path mapping to `actions.js` in the same change and run:

```bash
cd console/api
node --test test/rbacParity.test.js test/policy.test.js test/auth.test.js
```

Parameterized routes use the method-aware and prefix mappings at the bottom of `actions.js`. Prefer exact mappings whenever the route has a fixed path.

`rbacParity.test.js`'s route extractor recognizes routes declared via `path === "literal"`, `path.startsWith("prefix")`, template-literal paths, **and** `path.match(/regex/)` (added when the IAM policy/role routes were implemented — the extractor previously had no branch for regex-declared routes at all, meaning it was silently not checking roughly half of `server.js`'s real route surface, not just the new ones). A new regex-dispatched route with no matching entry in `REGEX_ACTIONS_BY_METHOD_PATTERN` will fail this test.
