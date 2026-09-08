# Unify the two Discord role→tier mappings — L1 Design

**Status:** Revision 2 — design only, not implemented. Eight Hats Layer 1 audit **not yet run** (§13); this document is not ready to leave draft until it has been.

**Revision 2 (maintainer feedback on PR #715):** confirmed `player` as the surviving unified-tier name (§3, §11 decision 3 — no change needed, now confirmed rather than assumed). **Corrected §2.4/§3/§4/§7/§11:** revision 1 proposed silently migrating a `DISCORD_OWNER_ROLE_IDS` role to `admin` on the strength of their identical bot capability sets. Maintainer correction: **owner is not admin** — capability equivalence is not identity equivalence, and collapsing them for migration convenience would erase what "owner is never a role" is supposed to mean once the console's stricter model becomes authoritative for the bot side too. A legacy owner-role mapping is now a **refused, operator-visible configuration**, exactly like any other role mapped to a forbidden tier — never auto-reassigned. See the revised §2.4, §3, §4, §7 and decision 2 for the corrected mechanism; §2.4's capability-identity observation is kept only as evidence that an operator who *chooses* to remap such a role to `admin` loses nothing by doing so — not as license to do it for them.
**Tracking issue:** dune-awakening-selfhost-docker#620 (`#628` was filed independently for the same finding and closed as its duplicate — `#628`'s "suggested direction" section is the origin of this design)
**Related:** #607 (design-debt bundle: parallel authz mechanisms), #632 (duplicated Discord helpers/constants), #610/#710 (API-key scopes vs. the crown-jewel deny list — a *different* parallel-authz drift, deliberately not folded in here), #676 (Settings consolidation — shares the Settings surface this design touches)

## 1. Problem

`#620`: the console resolves a Discord role to an access level **twice**, through two disjoint configuration surfaces that describe the same real-world Discord guild, with no shared source of truth and no cross-validation.

The failure scenario is an ordinary administrative act, not an exotic one. An operator revokes a departed admin's Discord role from `DISCORD_CONSOLE_ADMIN_ROLE_IDS` — the only one of the two surfaces with a UI — intending to cut that person off. `DISCORD_ADMIN_ROLE_IDS`, the env-only bot-capability mapping, is untouched, and every holder of that role keeps admin-level Discord-bot command capability. The two mappings drift apart the first time either is edited alone, which is the natural way an operator edits either one.

STRIDE: **Elevation of Privilege** — a role's bot capability outlives the console access it was revoked alongside.

## 2. Terminology and verified current state

Verified directly against `tier1-upstream`@`bacbd99d` (PR #578's head), by reading the files, not from memory or a prior session's summary.

### 2.1 The console sign-in mapping (`integrations/discord/roleTiers.js`)

- Tiers: `owner > admin > moderator > player` (`TIER_ORDER`).
- **Role-mappable tiers: `admin`, `moderator`, `player` only** (`ROLE_MAPPABLE_TIERS`). Owner is derived from Discord guild ownership and can never be conferred by a role — the RFC calls this "the strongest form of the separation-of-duties invariant."
- Env: `DISCORD_CONSOLE_ADMIN_ROLE_IDS`, `DISCORD_CONSOLE_MODERATOR_ROLE_IDS`, `DISCORD_CONSOLE_PLAYER_ROLE_IDS`.
- Parsing: `parseRoleIdList()` drops anything that is not a 17–19-digit snowflake, silently — "a typo in `.env` must not take Discord sign-in down."
- Invariant enforced: one role → exactly one tier. Violations are refused at save (settings API and guided setup) and, for a hand-edited `.env`, **disable Discord sign-in at boot** with a message naming the role.
- Configuration surfaces: Settings → Discord OAuth, and the guided setup wizard.
- Evaluated **at sign-in only** (RFC §2.1.1, "Trade-off, stated explicitly").
- Consumers: `config.js` → `createOAuthTierResolver()` in `integrations/discord/oauth.js` → `server.js`.

### 2.2 The bot capability mapping (`integrations/discord/policy.js`)

- Tiers: `public < observer < moderator < admin ≤ owner` (`DISCORD_ROLE_TIERS`).
- **Role-mappable tiers: all four of `observer`, `moderator`, `admin`, `owner`** — including owner, which the console forbids.
- Env: `DISCORD_OBSERVER_ROLE_IDS`, `DISCORD_MODERATOR_ROLE_IDS`, `DISCORD_ADMIN_ROLE_IDS`, `DISCORD_OWNER_ROLE_IDS`, read by `discordRoleMappingFromEnv()` in `integrations/discord/adapter.js`.
- Parsing: plain comma-split and trim. **No snowflake validation** — unlike the console side.
- No conflict invariant: a role under two tiers silently resolves to the higher one, with no refusal and no warning.
- Configuration surface: `.env` only. **No UI at all.**
- Evaluated **per command**, at every capability check.
- Consumers: `integrations/discord/adapter.js` (routes), `commandCatalog.js` (via `minTierForCapability()`).

### 2.3 The third resolver — dead code, and worse than either (new finding)

`console/api/src/services/discordAdapter.js` contains its *own* `discordRoleMappingFromEnv()` and `discordActorTier()`, distinct from both of the above:

- It reads only `DISCORD_OBSERVER_ROLE_IDS`, `DISCORD_ADMIN_ROLE_IDS` and `DISCORD_OWNER_ROLE_IDS`, **folding owner into admin** and **ignoring `DISCORD_MODERATOR_ROLE_IDS` entirely**.
- Its `requireDiscordCapability()` **fails open**: `if (!mapping.hasConfiguredRoles) return;` grants the capability to everyone when no roles are configured, where `policy.js`'s equivalent fails closed.

`grep -rn "services/discordAdapter"` across the whole repository returns **zero references** — no source file, no test, no doc. It is dead code. This is not a live vulnerability, but it is a loaded one: any future import of the obvious-looking module name gets a fail-open authorization check.

**This design deletes it.** That deletion is independently correct and does not depend on the rest of this design landing.

### 2.4 A fact worth recording, but not a license to auto-migrate

In `policy.js`'s `CAPABILITY_BY_TIER`:

```js
admin: new Set(Object.values(DISCORD_CAPABILITIES)),
owner: new Set(Object.values(DISCORD_CAPABILITIES))
```

**Bot `owner` and bot `admin` have byte-identical capability sets.** Every capability one grants, the other grants.

Revision 1 of this design read that as permission to silently migrate a `DISCORD_OWNER_ROLE_IDS` role to `admin` — "no capability change, so no harm." **Maintainer correction: owner is not admin.** Capability equivalence is not identity equivalence. Owner is the console's derived, non-role-mappable identity concept (Discord guild ownership) — that is true on the console side today, and unification's whole point is to make it true for the bot side as well, not to find a capability-preserving loophole around it the first time it is inconvenient.

So this fact is kept only as evidence for what §4 relies on: an operator who is shown their `DISCORD_OWNER_ROLE_IDS` roles at migration time and *chooses* to remap them to `admin` loses no bot capability by doing so. It is not, and must not become, a reason for the migration to make that choice on the operator's behalf.

## 3. The unified model

One mapping, one vocabulary, consumed by both paths.

| Unified tier | Role-mappable | Console sign-in grants | Bot capability grants |
|---|---|---|---|
| `owner` | **no** — derived from Discord guild ownership, on both paths | owner | full capability set (unreachable by role — a bot command from a non-owner, non-admin actor can never resolve to it) |
| `admin` | yes | admin | full capability set (today's bot `admin`, and today's bot `owner` role holders, once the operator has explicitly remapped them — see §4) |
| `moderator` | yes | moderator | `moderator` capability set |
| `player` | yes | player | the former `observer` capability set |
| — (no mapped role) | — | denied | `public` |

Env keys, one family: `DISCORD_ROLE_IDS_ADMIN`, `DISCORD_ROLE_IDS_MODERATOR`, `DISCORD_ROLE_IDS_PLAYER`. **No `DISCORD_ROLE_IDS_OWNER`** — owner is derived, never configured, on either path, once unified.

The console side's rules become the unified rules, because they are strictly the safer set:

- **Snowflake validation** (`parseRoleIdList`) applies to both paths. A malformed entry is dropped, never fatal.
- **One role → exactly one tier**, refused at save and warned at boot, applies to both paths.
- **Owner is never role-mappable**, for both paths — including a legacy `DISCORD_OWNER_ROLE_IDS` entry on the bot side, which the console model has no slot for at all (§4).

`player` is the retained name for the lowest signed-in tier (confirmed by the maintainer); bot `observer` becomes an alias that maps onto it. The console already folded observer into player once (`roleTiers.test.js`: "it was unreachable via Discord role mapping and a strict subset of player"), so this continues an existing decision rather than inventing one.

## 4. The one real behavior change, and why it needs staging

Unification is **not** capability-neutral in one direction, and this is the design's main hazard:

- A role in `DISCORD_OBSERVER_ROLE_IDS` today has bot read capability and **cannot sign in to the console**. Under a naive union it becomes `player` and **gains console sign-in**.
- A role in `DISCORD_CONSOLE_PLAYER_ROLE_IDS` today can sign in to the console and has **no bot capability**. Under a naive union it **gains bot observer capability**.
- A role in `DISCORD_OWNER_ROLE_IDS` today has full bot capability with **no console counterpart at all** — the unified model has no owner-role slot for it to land in (§2.4, §3, corrected in revision 2). This is not a gain/loss asymmetry like the first two; it is a mapping with **no valid unified target**, and treating "the capabilities happen to match `admin`'s" as an implicit answer is exactly the shortcut the maintainer rejected in revision 1. It must surface as a **refusal**, the same way the console already refuses a role mapped to two tiers at once — never a silent reassignment to `admin`, however capability-preserving that reassignment would be.

All three directions grant, lose, or reinterpret access nobody asked for, at upgrade time, silently. That is the exact class of failure this whole issue is about, so the migration must not perform a union, and must not resolve the owner case by inference either.

**Migration is opt-in and explicit, in three stages:**

**Stage 1 — detect and warn (no behavior change).** Ship drift detection against the legacy variables. Both mappings keep working exactly as today. At boot the console reports every role whose bot tier outranks its console tier, and the same report is surfaced in Settings. Nothing is auto-resolved. This alone closes `#620`'s reported hazard — the operator can no longer be unaware of the drift — and is safe to ship immediately, independently of stages 2 and 3.

**Stage 2 — the unified variables become authoritative when present.** If any `DISCORD_ROLE_IDS_*` key is set, it is the single source of truth for both paths and the legacy keys are ignored, with a boot warning naming each ignored legacy key. If `DISCORD_OWNER_ROLE_IDS` is still non-empty at that point, stage 2 **refuses to activate** the unified mapping — mirroring the console's own "sign-in disabled until the mapping is sound" precedent exactly — with a message naming the role(s) and telling the operator to either remap them to `admin` themselves or drop them, not a message that does it for them. If none of the unified keys is set, behavior is byte-identical to today plus stage 1's warnings. No deployment changes behavior without the operator setting a new key.

**Stage 3 — assisted migration + deprecation.** Settings offers a one-click migration that shows the operator exactly what the merged mapping would be, per role, with every access *gain* called out explicitly, **and every legacy `DISCORD_OWNER_ROLE_IDS` role listed separately as "needs your decision: map to Admin, or remove"** — never pre-selected — requiring acknowledgement before writing the unified keys. Legacy keys warn as deprecated for one release, then are removed.

Stage 1 is drafted already (§9). Stages 2 and 3 are this design's actual implementation scope.

## 5. Consumer-by-consumer impact

| Consumer | Change |
|---|---|
| `config.js` | Resolves one mapping; exposes it as `discordRoleTiers` plus the legacy-drift report. |
| `integrations/discord/oauth.js` | None — `createOAuthTierResolver()` already takes the mapping as a parameter. |
| `integrations/discord/policy.js` | `normalizeRoleMapping()`/`discordActorTier()` take the unified mapping; `CAPABILITY_BY_TIER` keeps its existing tier keys, with `player` added as the key `observer`'s capabilities move to. |
| `integrations/discord/adapter.js` | `discordRoleMappingFromEnv()` reads the unified keys, falling back to legacy. |
| `commandCatalog.js` | None — already derives from `minTierForCapability()`. |
| `services/discordAdapter.js` | **Deleted** (§2.3). |
| `server.js` | Settings save/validate routes write the unified keys; the existing conflict refusal now covers both paths. |
| `SettingsPanel.tsx` / `DiscordSetupWizard.tsx` | Role fields now state, in the UI, that they govern **both** console sign-in and bot capability. This is the single most important user-visible change: editing them was previously console-only. |

## 6. The Settings-UI consequence, stated plainly

After unification, an operator editing the role mapping in Settings changes **Discord-bot capability** too. That is the point of the change — but it means a UI that previously could not affect the bot now can, and an operator who does not realize it can widen bot access by editing what reads as a sign-in setting.

The mitigation is labelling, not a second confirmation dialog: the section is titled for what it now is (Discord roles → access, both surfaces), and each tier row names both consequences. A confirmation prompt on every save would train the operator to click through it; the acknowledgement gate belongs on the one-time migration (§4 stage 3), where the access change is real and quantified, not on routine edits.

## 7. Testing

- `roleTiers.test.js` — unified resolution, snowflake filtering on both paths, the conflict invariant on both paths, and the legacy-drift detector (drafted, §9).
- `discordPolicy.test.js` — capability sets unchanged for `admin`/`moderator`; `player` grants exactly what `observer` granted.
- **Stage 2 refuses to activate, at boot, while any `DISCORD_OWNER_ROLE_IDS` entry remains** — asserted as a refusal test, not a migration test. A companion test proves the refusal message names the specific role(s) and offers no default.
- **Stage 3's migration preview never pre-selects a target for a legacy owner role** — asserted directly against the preview payload, not inferred from the UI.
- Precedence tests: unified keys present → legacy ignored; unified keys absent → byte-identical to today.
- A migration test that asserts the **gain** list is complete for a mapping exercising every observer/player asymmetry in §4, and that the owner-role list is reported separately from (never merged into) that gain list.
- Mutation-test each new gate, per this project's convention.

## 8. Documentation to update

`docs/rfc-console-auth.md` §2.1.1 (the role-mapping table and the "owner is never a role" paragraph), `docs/integrations/discord-integration/README.md`, `admin-guide.md`, `troubleshooting.md`, `faq.md`, `docs/integrations/discord-control-bot/setup-guide.md` and `admin-guide.md`, `.env.example` (both blocks, currently ~140 lines apart), `docs/console-iam.md`, and the authentication upgrade guide — which is where the stage-2/3 migration must be written down for real.

## 9. Already drafted

Stage 1's detector exists on this branch: `roleTierDrift()` / `describeRoleTierDrift()` / `botRoleTier()` in `roleTiers.js`, wired into `config.js` as `discordRoleMappingDrift` and surfaced as a boot warning in `server.js`, with 8 tests. It reports only privileged bot tiers (`owner`/`admin`/`moderator`) — a warning that fired for every read-only community role would be ignored, and being ignored is how the real one gets missed. Two mutations (`<` → `<=`, and removing the privileged-tier filter) were each confirmed to turn the suite red.

## 10. Explicitly out of scope

- **#610/#710** (API-key scopes vs. the crown-jewel deny list). A real parallel-authz drift, but a different pair of mechanisms with a different fix; folding it in would make both harder to review.
- **Live revocation.** Role→tier stays sign-in-time for the console path (RFC §2.1.1's stated trade-off). Unification does not change it, and an operator needing immediate revocation still restarts.
- **The handoff path.** When a bot handoff is configured it remains authoritative for console sign-in, untouched.
- **Multi-owner.** Out of scope per the existing operator decision.

## 11. Decisions log

| # | Decision | Rationale |
|---|---|---|
| 1 | Console rules win where the two differ | Strictly safer: snowflake validation, the one-role-one-tier refusal, and owner-never-mappable all exist only on the console side. |
| 2 | A legacy `DISCORD_OWNER_ROLE_IDS` role is **refused at stage 2, and requires an explicit operator choice at stage 3** — never auto-remapped to `admin` | **Revised in revision 2** (was: auto-collapse into `admin`, on the strength of identical capability sets — maintainer correction: owner is not admin; capability equivalence is not identity equivalence, and inferring the operator's intent defeats the point of making owner non-role-mappable at all). §2.4's capability-identity fact survives only as evidence that the operator's own choice to remap costs nothing, not as the mechanism that makes the choice for them. |
| 3 | `player` is the surviving name; `observer` maps onto it | Continues the console's existing fold, rather than reintroducing a tier it deliberately removed. **Confirmed by the maintainer in revision 2.** |
| 4 | Migration is opt-in, never a union at upgrade | A union silently grants access in both directions (§4) — the same class of failure as #620 itself. |
| 5 | Delete `services/discordAdapter.js` rather than fix it | Zero references repo-wide; it is a fail-open authorization check waiting to be imported by name. |
| 6 | Acknowledgement gate on migration, not on routine saves | A prompt on every save trains click-through; the real access change happens once. |
| 7 | Stage 1 ships independently | It closes #620's actual reported hazard without changing any behavior, so it need not wait on stages 2–3. |

## 12. Open questions for the maintainer

Resolved in revision 2: `player` as the surviving tier name (confirmed), and owner-vs-admin (owner stays non-role-mappable on both paths; a legacy owner-role mapping is refused and requires an explicit operator choice, never auto-remapped — §2.4, §3, §4, §11 decision 2).

Still open:

1. **Stage 1 alone, or all three?** Stage 1 closes the reported hazard with zero behavior change. Stages 2–3 deliver the single source of truth `#628` asked for but require a migration every existing deployment must consciously perform.
2. **Deprecation window** for the legacy keys — one release, or longer given this is a fork tracking an upstream that does not have these keys at all?
3. **Upstream framing.** #578 is an upstream candidate. Does the unified mapping go upstream as part of Tier 1, or stay fork-local until Red-Blink has taken Tier 1 itself?

## 13. Layer 1 Eight Hats audit — NOT YET RUN

Per org Requirement 20, a design of this size needs a Layer 1 Eight Hats audit with a committed findings register and a STRIDE report before the implementation PR leaves draft. **That audit has not been run for this document.** This section is a placeholder naming the gate, deliberately not a claim that it passed — an internal "all findings resolved" assertion is a hypothesis until independently confirmed, and this one has not even been made yet.
