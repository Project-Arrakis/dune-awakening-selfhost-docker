# RBAC: roles, permissions and architecture

**Status:** Current | **Last Updated:** October 2026

Verified 2026-10-25 against this repo at `82548d72` (v1.4.52) and the `mentat` bot repo at `f8709f0`. The permission matrix in section 4 is **generated from the real policy engine**, not typed by hand; section 7 shows how to regenerate it.
**Scope:** who can do what in the Web Console and in the Discord bot, how a person ends up in a role, and where the two halves disagree. It is a map, not a replacement: the linked documents hold the detail and the history.

## 1. Two different things called "tier"

| Term | What it is | Values |
|---|---|---|
| **Role tier** (this document's subject) | The authorization level of a signed-in session | `owner` > `admin` > `moderator` > `player` |
| **Auth layer** ("Tier 1/2/3" in `rfc-console-auth.md`) | How a person proves who they are | Tier 1 Discord OAuth, Tier 2 passkeys, Tier 3 optional TOTP second factor; the hardened password is the fallback |

`observer` is the old name of `player` and is aliased to it (`normalizeTier`), never honoured as its own tier. In the bot, `player` is the user-facing label for the internal `observer` tier.

## 2. Architecture

```
 Discord user                         Browser (operator)
     |                                      |
     | slash command                        | password / Discord OAuth / passkey (+TOTP)
     v                                      v
 +-----------------+   bearer token   +---------------------------------------------+
 | mentat (bot)    | ---------------> | Web Console API (console/api)               |
 |  rbac.js        |  actor identity  |  auth.js     session (cookie, server-side)  |
 |  guild_roles DB |  + signed hand-  |  actions.js  route -> one action name       |
 |  canWrite()     |  off for sign-in |  policy.js   evaluate(tier, action)         |
 +-----------------+                  |  requireAction  second check on body        |
     ^                                |  playerTierGate caps `player` to own data   |
     | role -> tier                   +----------------------+----------------------+
     | (owner = guild owner only)                            | duneDb.js (only DB access)
                                                             v
                                                       Postgres / game server
```

- **The bot never touches the database.** Every read and write goes bot -> console adapter API (bearer token) -> `duneDb.js`. See `mentat/docs/architecture.md`.
- **Two checks, two places.** The bot refuses a command its caller's tier is too low for (`canWrite()` / `tierAtLeast`) before it calls the console. The console then applies its own policy to the tier it holds for that actor. Both must allow it.
- **Console evaluation** (`console/api/src/policy.js`): every authenticated route maps to exactly one action (`actions.js`); an unmapped authenticated route is denied; for each statement in the tier's policy, a matching `Deny` wins immediately, otherwise a matching `Allow` allows, otherwise the answer is **default deny**. Handlers whose privilege depends on the request body run a second `requireAction` check. Detail: [`console-iam.md`](../console-iam.md).
- **Policies.** Shipped defaults are `DEFAULT_POLICIES` in `policy.js`. An operator can save `runtime/generated/iam-policies.json`, which **replaces the defaults wholesale** per tier; on load, security denials for actions added after the file was saved are re-applied so an upgrade cannot silently widen `admin` (issue #1117). Saving a policy that would lock `owner` out of `settings:write` is refused. Patterns are literal text plus `*` only (no regex).
- **`player` is capped twice**: the default policy grants only `players:read` and `guilds:read`, and `playerTierGate` narrows even those to the signed-in player's own characters, items and guild.

## 3. How a person gets a role

| Path | Resulting tier | Notes |
|---|---|---|
| Console admin password | `owner` | The local operator. Hardened password flow and optional TOTP/passkeys are specified in `rfc-console-auth.md`. |
| Discord OAuth sign-in (Tier 1) | Whatever the bot's role handoff returns | The console asks the bot to resolve the user's tier from `guild_roles`. An empty or failed answer means **deny**, not a lower tier. |
| Static bootstrap allowlist | `owner` only | Only when explicitly enabled, a home guild is set, the user is a live member and is on the allowlist. A first-owner escape hatch, not a normal path. |
| Bot slash commands | From the user's Discord roles via `guild_roles` | Highest matching mapped role wins. **`owner` is never reachable through a role mapping**: it comes only from owning the Discord guild itself, so any role an operator creates reaches at most `admin`. |
| API keys | Scoped per key | See `apiKeys.js` / `apiKeyScopes.js`. Not covered by this document's matrix. |

## 4. What each role can do today (console default policies)

Counts out of **137** console actions: **owner 137**, **admin 116**, **moderator 16**, **player 2**.

| Role | In one line |
|---|---|
| **Owner** | Everything, including secrets, settings, authentication, the Discord bot configuration, server restart and system-backup download/import/restore. |
| **Admin** | Day-to-day operations: players, bases, storage, vehicles, maps, backups (create/delete/restore, not the system-wide ones), logs, updates, care packages, addons. Cannot touch settings, the Discord bot setup, passwords/ports, database write/execute, or restart the server. |
| **Moderator** | Read-only view of players, guilds, bases, storage, blueprints, vehicles, exchange, maps, sietches, deep desert, landsraad and server status; read logs; kick-all; broadcast and map chat. No edits. |
| **Player** | `players:read` and `guilds:read`, narrowed to their own data. |

**Denied to `admin` by default (21 actions):** `admin:history:clear`, `backups:download-system`, `backups:import-system`, `backups:restore-system`, `carepackage:clear-history`, `carepackage:grant-all`, `database:execute`, `database:mutate`, `database:write-config`, `server:restart`, and every `settings:*` action (`settings:read`, `settings:write`, `change-password`, `change-port`, `regenerate-recovery-codes`, `discord-bot-disable`, `discord-bot-hosted-oauth`, `discord-bot-hosted-register`, `discord-bot-oauth-config`, `discord-bot-oauth-secret`, `discord-bot-regenerate-token`). A system backup contains the console's own secrets and `iam-policies.json`, which is why its download, import and restore are owner-only.

Full matrix (generated):

**addons**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `addons:bridge` | ✅ | ✅ | — | — |
| `addons:install` | ✅ | ✅ | — | — |
| `addons:read` | ✅ | ✅ | — | — |
| `addons:remove` | ✅ | ✅ | — | — |
| `addons:toggle` | ✅ | ✅ | — | — |
| `addons:unclassified` | ✅ | ✅ | — | — |
| `addons:update` | ✅ | ✅ | — | — |

**admin**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `admin:announcements:read` | ✅ | ✅ | — | — |
| `admin:announcements:write` | ✅ | ✅ | — | — |
| `admin:broadcast` | ✅ | ✅ | ✅ | — |
| `admin:broadcast-shutdown` | ✅ | ✅ | — | — |
| `admin:history:clear` | ✅ | — | — | — |
| `admin:history:read` | ✅ | ✅ | — | — |
| `admin:items:read` | ✅ | ✅ | — | — |
| `admin:map-chat` | ✅ | ✅ | ✅ | — |
| `admin:motd:read` | ✅ | ✅ | — | — |
| `admin:motd:write` | ✅ | ✅ | — | — |
| `admin:skills:read` | ✅ | ✅ | — | — |
| `admin:transfer-settings:read` | ✅ | ✅ | — | — |
| `admin:transfer-settings:write` | ✅ | ✅ | — | — |
| `admin:vehicles:read` | ✅ | ✅ | — | — |

**backups**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `backups:create` | ✅ | ✅ | — | — |
| `backups:create-system` | ✅ | ✅ | — | — |
| `backups:delete` | ✅ | ✅ | — | — |
| `backups:delete-system` | ✅ | ✅ | — | — |
| `backups:download-system` | ✅ | — | — | — |
| `backups:import` | ✅ | ✅ | — | — |
| `backups:import-system` | ✅ | — | — | — |
| `backups:read` | ✅ | ✅ | — | — |
| `backups:restore` | ✅ | ✅ | — | — |
| `backups:restore-system` | ✅ | — | — | — |
| `backups:write-config` | ✅ | ✅ | — | — |

**bases**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `bases:add-item` | ✅ | ✅ | — | — |
| `bases:bulk-delete-items` | ✅ | ✅ | — | — |
| `bases:delete` | ✅ | ✅ | — | — |
| `bases:delete-backup` | ✅ | ✅ | — | — |
| `bases:delete-item` | ✅ | ✅ | — | — |
| `bases:edit-backup` | ✅ | ✅ | — | — |
| `bases:export-backup` | ✅ | ✅ | — | — |
| `bases:fill-item` | ✅ | ✅ | — | — |
| `bases:give-item` | ✅ | ✅ | — | — |
| `bases:import-backup` | ✅ | ✅ | — | — |
| `bases:mutate` | ✅ | ✅ | — | — |
| `bases:read` | ✅ | ✅ | ✅ | — |
| `bases:write-config` | ✅ | ✅ | — | — |

**blueprints**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `blueprints:delete` | ✅ | ✅ | — | — |
| `blueprints:export` | ✅ | ✅ | — | — |
| `blueprints:import` | ✅ | ✅ | — | — |
| `blueprints:read` | ✅ | ✅ | ✅ | — |
| `blueprints:unclassified` | ✅ | ✅ | — | — |

**carepackage**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `carepackage:clear-history` | ✅ | — | — | — |
| `carepackage:grant` | ✅ | ✅ | — | — |
| `carepackage:grant-all` | ✅ | — | — | — |
| `carepackage:read` | ✅ | ✅ | — | — |
| `carepackage:scan` | ✅ | ✅ | — | — |
| `carepackage:write-config` | ✅ | ✅ | — | — |

**database**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `database:execute` | ✅ | — | — | — |
| `database:export` | ✅ | ✅ | — | — |
| `database:mutate` | ✅ | — | — | — |
| `database:query` | ✅ | ✅ | — | — |
| `database:read` | ✅ | ✅ | — | — |
| `database:write-config` | ✅ | — | — | — |

**deepdesert**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `deepdesert:read` | ✅ | ✅ | ✅ | — |
| `deepdesert:write` | ✅ | ✅ | — | — |

**exchange**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `exchange:market` | ✅ | ✅ | — | — |
| `exchange:market-write` | ✅ | ✅ | — | — |
| `exchange:read` | ✅ | ✅ | ✅ | — |
| `exchange:write-config` | ✅ | ✅ | — | — |

**guilds**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `guilds:disband` | ✅ | ✅ | — | — |
| `guilds:membership` | ✅ | ✅ | — | — |
| `guilds:rank` | ✅ | ✅ | — | — |
| `guilds:read` | ✅ | ✅ | ✅ | ✅ |
| `guilds:unclassified` | ✅ | ✅ | — | — |

**landsraad**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `landsraad:read` | ✅ | ✅ | ✅ | — |
| `landsraad:write` | ✅ | ✅ | — | — |

**logs**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `logs:read` | ✅ | ✅ | ✅ | — |

**maps**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `maps:despawn` | ✅ | ✅ | — | — |
| `maps:read` | ✅ | ✅ | ✅ | — |
| `maps:reconcile` | ✅ | ✅ | — | — |
| `maps:restart` | ✅ | ✅ | — | — |
| `maps:spawn` | ✅ | ✅ | — | — |
| `maps:teleport` | ✅ | ✅ | — | — |
| `maps:write-config` | ✅ | ✅ | — | — |

**players**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `players:configure-list` | ✅ | ✅ | — | — |
| `players:delete-item` | ✅ | ✅ | — | — |
| `players:edit-item` | ✅ | ✅ | — | — |
| `players:give-item` | ✅ | ✅ | — | — |
| `players:grant` | ✅ | ✅ | — | — |
| `players:kick-all` | ✅ | ✅ | ✅ | — |
| `players:moderate` | ✅ | ✅ | — | — |
| `players:read` | ✅ | ✅ | ✅ | ✅ |
| `players:recover` | ✅ | ✅ | — | — |
| `players:repair` | ✅ | ✅ | — | — |
| `players:reset` | ✅ | ✅ | — | — |
| `players:teleport` | ✅ | ✅ | — | — |
| `players:unclassified` | ✅ | ✅ | — | — |

**realtime**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `realtime:read` | ✅ | ✅ | — | — |

**server**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `server:console-reload` | ✅ | ✅ | — | — |
| `server:network-fix` | ✅ | ✅ | — | — |
| `server:read` | ✅ | ✅ | ✅ | — |
| `server:restart` | ✅ | — | — | — |
| `server:restart-service` | ✅ | ✅ | — | — |
| `server:start` | ✅ | ✅ | — | — |
| `server:stop` | ✅ | ✅ | — | — |
| `server:storage-cleanup` | ✅ | ✅ | — | — |
| `server:write-config` | ✅ | ✅ | — | — |

**settings**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `settings:change-password` | ✅ | — | — | — |
| `settings:change-port` | ✅ | — | — | — |
| `settings:discord-bot-disable` | ✅ | — | — | — |
| `settings:discord-bot-hosted-oauth` | ✅ | — | — | — |
| `settings:discord-bot-hosted-register` | ✅ | — | — | — |
| `settings:discord-bot-oauth-config` | ✅ | — | — | — |
| `settings:discord-bot-oauth-secret` | ✅ | — | — | — |
| `settings:discord-bot-regenerate-token` | ✅ | — | — | — |
| `settings:read` | ✅ | — | — | — |
| `settings:regenerate-recovery-codes` | ✅ | — | — | — |
| `settings:write` | ✅ | — | — | — |

**setup**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `setup:read` | ✅ | ✅ | — | — |
| `setup:write` | ✅ | ✅ | — | — |

**sietches**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `sietches:read` | ✅ | ✅ | ✅ | — |
| `sietches:write` | ✅ | ✅ | — | — |

**storage**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `storage:mutate` | ✅ | ✅ | — | — |
| `storage:read` | ✅ | ✅ | ✅ | — |

**updates**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `updates:apply` | ✅ | ✅ | — | — |
| `updates:check` | ✅ | ✅ | — | — |
| `updates:fix` | ✅ | ✅ | — | — |
| `updates:install-assets` | ✅ | ✅ | — | — |
| `updates:read` | ✅ | ✅ | — | — |
| `updates:repair` | ✅ | ✅ | — | — |
| `updates:self-check` | ✅ | ✅ | — | — |
| `updates:write-config` | ✅ | ✅ | — | — |

**vehicles**

| Action | Owner | Admin | Moderator | Player |
|---|:-:|:-:|:-:|:-:|
| `vehicles:bulk-delete-items` | ✅ | ✅ | — | — |
| `vehicles:delete` | ✅ | ✅ | — | — |
| `vehicles:delete-item` | ✅ | ✅ | — | — |
| `vehicles:mutate` | ✅ | ✅ | — | — |
| `vehicles:read` | ✅ | ✅ | ✅ | — |
| `vehicles:stored-delete` | ✅ | ✅ | — | — |

## 5. The bot's own tiers

The bot uses `observer`/"Player" < `moderator` < `admin` < `owner` (`mentat/src/rbac.js`). Read commands in `commands-registry.json` by minimum tier: 2 `public`, 6 `observer`, 11 `moderator`, 9 `admin`. Write commands (`mentat/src/writeActions.js`, all behind `DUNE_DISCORD_WRITES_ENABLED` and a button confirmation, some with a typed phrase):

| Tier | Write commands |
|---|---|
| moderator | `player warn` |
| admin | `player kick/ban/unban/fill-water`; `base refill-generators/refill-water`; `server start/restart-service`; `map spawn/despawn/respawn/teleport`; `carepackage grant/enable/disable/scan`; `guild add/remove` |
| owner | `player give-item/clear-backpack`; `server restart/stop`; `carepackage grant-all/history-clear`; `operations create-backup/trigger-update` |
| host-operator | `bot self-update` (a dedicated bot-host identity check, never `canWrite()`) |

## 6. Where the pieces disagree (verify before relying on either side)

These are observations from reading both sides on 2026-10-25, not confirmed defects. Whether the console re-checks the bot's actor against its own policy for these writes is the question; see the write-bridge design in [`rw-architecture.md`](../rw-architecture.md).

1. **Stricter in the bot than in the console defaults.** The bot requires `owner` for `server stop`, `player give-item`, `player clear-backpack` and `operations create-backup`; the console default policy lets `admin` do the equivalent (`server:stop`, `players:*`, `backups:create`). An admin using the console UI can do what an admin using Discord cannot.
2. **`public` tier.** `mentat/docs/architecture.md` says there is no `public` tier, but `commands-registry.json` has two commands with `minTier: "public"` and one with none. Either the doc or the registry is out of date.
3. **Operator-edited policies.** Everything in section 4 is the shipped default. A saved `iam-policies.json` replaces it per tier, so a running install may differ; read the live policy from the console's IAM settings page.

## 7. Regenerating the matrix

From `console/api/`:

```bash
node --input-type=module -e '
import { evaluate, allKnownActions, DEFAULT_POLICIES } from "./src/policy.js";
const T = ["owner","admin","moderator","player"];
for (const a of [...allKnownActions()].filter(a => a.includes(":")).sort())
  console.log(a, T.map(t => evaluate({ tier: t }, a, DEFAULT_POLICIES) ? "yes" : "no").join(" "));'
```

`rbacParity.test.js` already guards that every route has an action; this document does not have its own drift test.

## 8. Sources

`console/api/src/policy.js`, `actions.js`, `auth.js`, `playerTierGate.js`, `integrations/discord/oauth.js`; [`console-iam.md`](../console-iam.md); [`rfc-console-auth.md`](../rfc-console-auth.md); [`design/console-layered-auth-l1-design-2026-08-17.md`](../design/console-layered-auth-l1-design-2026-08-17.md); [`security/console-rbac-implementation-and-testing.md`](../security/console-rbac-implementation-and-testing.md); [`design/bot-console-authorization-l1-design-2026-09-07.md`](../design/bot-console-authorization-l1-design-2026-09-07.md); [`rw-architecture.md`](../rw-architecture.md); `mentat/docs/architecture.md`, `mentat/src/rbac.js`, `mentat/src/writeActions.js`.
