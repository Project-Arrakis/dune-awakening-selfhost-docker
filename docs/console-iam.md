# Console IAM Architecture

The Web Console applies an IAM action to every authenticated API route. Public authentication and health routes remain outside this gate, and Discord adapter routes continue to use their existing bearer-token and Discord capability checks.

## Authorization flow

1. `auth.js` verifies the opaque `asc_session={id}.{HMAC(id)}` cookie and loads the server-side session.
2. `actions.js` maps the request method and path to one action such as `players:read` or `server:restart`.
3. `policy.js` evaluates the session tier using explicit-deny precedence: Deny, then Allow, then default Deny.
4. An unmapped authenticated route is denied. `rbacParity.test.js` prevents new routes from being merged without a mapping.

## API key principals

An API key is the second principal type. It authenticates with `Authorization: Bearer <key>`
before `auth.js` runs, because a bearer request carries no CSRF token and `requireAuth` would
reject it. Its scope is a per-namespace Read/Read+write map of its own, evaluated by
`apiKeys.js` on top of the action this route resolved to.

Keys carry no configurable tier. The `owner` tier in the synthesized principal exists only so
`resolveSessionTier` recognises it — `owner` is `Allow *`, so the policy check is a no-op and
the key's scope map is the single thing deciding access. `settings:*`, `database:*` and `setup:*` are
denied to every key regardless of what its stored record says, which is what keeps key
management a browser-session operation. `updates:*` and `addons:*` are write-denied rather than
denied outright, so a key can poll for updates and list addons but never install either. See [console/api-keys.md](console/api-keys.md).

Session tier and identity stay in the in-memory session store; they are not placed in the browser cookie. A Console process restart invalidates existing sessions, matching the previous session lifecycle and preventing stale role claims from surviving a restart.

## Policies

The default policies preserve full owner access and apply a deliberately **over-restrictive** default to the lower tiers (see *Tier model* below). Password logins and `ADMIN_AUTH_DISABLED=1` create owner sessions, so existing Console installations keep their current behavior.

Policy documents use this shape:

```json
{
  "owner": {
    "version": 1,
    "tier": "owner",
    "statements": [
      { "Effect": "Allow", "Action": "*" }
    ]
  }
}
```

`Action` may be one string or an array. Exact actions, namespace wildcards such as `players:*`, and `*` are supported. Explicit Deny statements override Allow statements for every tier, including owner.

The policy API is owner-only under the default policy:

- `GET /api/settings/iam/policies` returns the active policy store.
- `PUT /api/settings/iam/policy` validates and atomically saves the complete policy store to `runtime/generated/iam-policies.json`.
- `POST /api/settings/iam/policy/test` evaluates an action for a tier without changing policy.

Updates that remove the owner's `settings:write` access are rejected so the local-password recovery path remains available.

## Tier model (default policy)

The shipped defaults follow a **governance vs. operation** split, biased
over-restrictive by design: anything that could compromise, re-deploy, or
destroy the deployment is owner-only, and a capability added to the catalog
later defaults to owner-only until an operator grants it. Operators loosen the
lower tiers per-deployment via the Access Control editor.

- **owner** — everything (`Allow: "*"`). The single root of trust: the only
  tier that can edit IAM policies, rotate credentials (the Funcom game-server
  token, the DB/admin passwords), change the server IP, deploy code
  (updates/addons), run destructive SQL, restore/import backups, and set the
  economy. Password / `ADMIN_AUTH_DISABLED` sessions are owner.
- **admin** — *operate the live server and moderate players; change nothing
  persistent.* Explicit allow-list: server lifecycle (start/stop/restart, map
  shards), player moderation (kick/ban/teleport + mass kick), communications
  (broadcast/MOTD/announcements), read-only visibility, read-only SQL, taking
  (not restoring) backups. A Deny block keeps the crown jewels
  (`server:write-credentials`, `settings:*`, `database:mutate`/`write-config`,
  `updates:apply/fix/repair`, `backups:restore/import`, `addons:install/update`,
  `setup:write`, `players:mutate`, and the economy actions) unreachable even if
  a future edit widens the allow-list.
- **moderator** — live moderation only: read everything, broadcast/map-chat,
  and act on individual griefers (kick/ban/teleport). No config, no economy, no
  server lifecycle, nothing destructive.
- **player** — read-only view of the game world.
- **observer** — minimal server-status viewer (`server:read`) — "is the server
  up?" A richer read-only ops/audit definition is tracked for revision.

Two catalog details make the admin/moderator line enforceable rather than
all-or-nothing:

- **`players:kick` / `players:ban` / `players:teleport`** are split out of the
  `players:mutate` economy bucket (`REGEX_ACTIONS_BY_METHOD_PATTERN`), so a
  moderator/admin can act on an individual player without gaining give-item /
  add-currency / reset-progression.
- **`server:write-credentials`** carries the Funcom token and the server IP
  change (and the setup-time `save-token`), split from the operational
  `server:write-config`, so those trust-anchor writes are owner-only on every
  path.
- **API keys run as a synthesized `owner` tier**, so the policy engine is a no-op for them
  and their per-namespace scope map (plus three deny sets) is the sole control. Beyond the
  denied namespaces (`settings`/`database`/`setup`) and write-denied namespaces
  (`updates`/`addons`), specific **actions** are denied to keys regardless of scope:
  `server:write-credentials` (Funcom token + IP) and `backups:restore`/`import`/`delete`
  (whole-DB overwrite / identity adoption / recovery destruction). See
  [console/api-keys.md](console/api-keys.md).
- **Destructive SQL via `POST /api/database/query`** is gated in-handler on
  `database:mutate` (owner-only): admin holds `database:query` for read-only
  SQL, but a non-read-only statement is refused unless the session is owner.

## Route maintenance

When adding an authenticated API route, add its method/path mapping to `actions.js` in the same change and run:

```bash
cd console/api
node --test test/rbacParity.test.js test/policy.test.js test/auth.test.js
```

Parameterized routes use the method-aware and prefix mappings at the bottom of `actions.js`. Prefer exact mappings whenever the route has a fixed path.
