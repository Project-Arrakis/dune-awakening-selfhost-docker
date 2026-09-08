# Bot/Console Authorization Decoupling — L1 Design

**Date:** 2026-09-07
**Status:** L1 design, drafted through direct human-AI brainstorming dialogue (not a dispatched eight-hats review — the operator drove every key decision directly; see Decision Log). Reviewed by a full Layer 2 eight-hats pass after the fact (see the companion PR's audit trail) — HIGH/MEDIUM findings from that pass are incorporated inline. This document describes verified-current code behavior as of 2026-09-07/08 (commit `c80a647b`) — re-verify §3's code excerpt and §2's matrix against `console/api/src/integrations/discord/policy.js`/`oauth.js` directly before relying on this if significant time has passed, rather than trusting this snapshot indefinitely.
**Scope:** clarifies where Discord-role-based authorization decisions live across the Discord bot ("Sahir Venn," repos `mentat`/`mentat-link`) and the game console ("Core," this repo) — two independent systems that can each be present, absent, or differently configured in a given deployment.
**Explicitly out of scope:** the terminology/documentation-clarity work covering *what the 4 Discord-named things are* (bot identity, bot setup-portal OAuth, console adapter, console's own OAuth login) — that's tracked separately (`mentat-link` issue #132/PR #133, companion work planned in this repo and `mentat`). This document is the authorization-architecture decision that work needs to reference, not a replacement for it.

---

## 1. Problem statement

An operator asked a direct, concrete question that exposed a real architectural gap: *if the console and the bot are separate systems, where does authorization actually live, and what happens when one of them isn't connected to Discord at all?*

Investigation found **three independent tier-resolution mechanisms**, not the two or four the terminology-only framing assumed:

1. **The bot's own tier resolution** (`mentat/src/rbac.js`) — governs which Discord slash commands a user sees in Discord. Source: the bot's own `guild_roles` DB table (configured via the bot's setup portal) + real Discord guild ownership for Owner.
2. **The console's Discord *adapter* authorization** (`console/api/src/integrations/discord/policy.js`, `discordActorTier()`) — governs whether a privileged action the *bot* asks the console to perform (maintenance, broadcast, backups, etc.) is actually honored. Source: the console's own `DISCORD_OBSERVER_ROLE_IDS`/`_MODERATOR_ROLE_IDS`/`_ADMIN_ROLE_IDS`/`_OWNER_ROLE_IDS` env vars, checked entirely console-side, gated behind `DUNE_DISCORD_ADAPTER_ENABLED`.
3. **The console's own "Sign in with Discord" web-login** (`console/api/src/integrations/discord/oauth.js` + `handoff.js`) — governs who can log into Core's own admin UI. Has an existing "Phase 3 signed tier handoff" (2026-08-06) that, when configured, has the console ask the bot in real time for a user's tier; when no handoff is configured, falls back to a bootstrap mechanism that **only ever produces `"owner"` or deny** — no Moderator/Admin path exists in that fallback today.

The operator's own initial instinct ("core should be the source of truth, but what if core isn't connected to Discord") surfaced a real question about mechanism 2 specifically, and a real gap in mechanism 3's non-handoff fallback.

---

## 2. Use-case matrix

Three independent dimensions, not two: whether a bot is present, whether Console has its own Discord OAuth Application configured, and whether Console's own role-ID mapping is populated. A fourth, `DUNE_DISCORD_ADAPTER_ENABLED`, gates whether the bot can reach the console for *anything* — confirmed via `console/api/src/integrations/discord/routes.js:183`, this is all-or-nothing: disabled means every bot→console route (read-only status checks included, not just privileged actions) returns `adapter_disabled`.

**Note on the "Console Roles" column:** it does double duty and means two different, independently-configured things depending on the row — for rows 1-3 (no bot) it means the console **login-OAuth** role mapping (§4's gap: not yet implemented); for rows 4-6 (bot present) it means the **adapter's own** `DISCORD_*_ROLE_IDS` mapping, which is configured independently of whether console login-OAuth is enabled at all. Row 4 is split below (4b-i/4b-ii) the same way rows 5 and 6 already are, to make this explicit rather than implicit — an earlier draft of this table only showed row 4b as "unconfigured → owner-only" without acknowledging the adapter's role mapping can just as easily be populated in that row too, independent of console OAuth.

| # | Bot Present | Console OAuth (login) | Console Roles | Adapter Enabled | Bot Command Gating | Adapter/Privileged-Action Authority |
|---|---|---|---|---|---|---|
| 1 | No | False | — | — | N/A (no bot) | Console (single implicit Owner, password-only, no tiers) |
| 2 | No | True | False | — | N/A | Console (Owner-only via allowlist) |
| 3 | No | True | True | — | N/A | Console (own role-ID mapping, full tiers) — **not yet implemented, see §4** |
| 4a | Yes | False | — | False | Bot (own `guild_roles`) | N/A — no privileged-action channel exists; even read-only console commands fail |
| 4b-i | Yes | False | Adapter roles unconfigured | True | Bot (own `guild_roles`) | **Console** (owner-only, automatic — the empty-mapping fallback) |
| 4b-ii | Yes | False | Adapter roles configured | True | Bot (own `guild_roles`) | **Console** (own adapter role-ID mapping, full tiers — independent of console OAuth being off) |
| 5a | Yes | True | False | False | Bot (own `guild_roles`) | N/A — no channel |
| 5b | Yes | True | False | True | Bot (own `guild_roles`) | Console (owner-only, unconfigured) |
| 6a | Yes | True | True | False | Bot (own `guild_roles`) | N/A — no channel |
| 6b | Yes | True | True | True | Bot (own `guild_roles`) | Console (own role-ID mapping, fully configured) |

**Two decisions, always kept separate:**
- **Bot command gating** — which slash commands a user sees/can invoke in Discord. Always the bot's own `guild_roles` table. Never overridden by Console, in any row.
- **Adapter/privileged-action authority** — whether a specific action the bot asks Console to perform is actually honored. Always Console's own decision, checked console-side, using Console's own role-ID mapping (`discordActorTier()` in `policy.js`).

---

## 3. The core decision

**Authorization for privileged/adapter actions always belongs to Console, checked console-side, using Console's own role-ID mapping if configured, else owner-only.** This applies uniformly across every row in the matrix — there is no special case for "bot is the only OAuth" (an earlier draft of this design proposed making the bot authoritative in that specific case; the operator correctly rejected it as unnecessary complexity in favor of this single uniform rule — see Decision Log).

This is **not a new behavior** — it is already exactly how `discordActorTier()` works today:

```js
export function discordActorTier(actor, mapping) {
  if (isRealGuildOwner(actor)) return "owner";
  const roleIds = new Set(normalizeStringList(actor?.roleIds));
  const normalized = normalizeRoleMapping(mapping);
  if (normalized.ownerRoleIds.some((roleId) => roleIds.has(roleId))) return "owner";
  if (normalized.adminRoleIds.some((roleId) => roleIds.has(roleId))) return "admin";
  if (normalized.moderatorRoleIds.some((roleId) => roleIds.has(roleId))) return "moderator";
  if (normalized.observerRoleIds.some((roleId) => roleIds.has(roleId))) return "observer";
  return "public";
}
```

When all four role-ID lists are unconfigured (empty), no non-owner role can ever match, so everyone but the verified real guild owner falls through to `"public"` — the owner-only default is automatic, requiring **zero code changes** to this function.

### 3.1 What this reframes, not fixes

The "misalignment risk" this whole investigation started from is **narrower than originally framed**. It is not "an unconfigured console is broken" (that's already correctly owner-only, automatically). It is: **when an operator *does* populate Console's `DISCORD_*_ROLE_IDS` to mirror the bot's `guild_roles`, nothing keeps the two in sync going forward.** Row 6b explicitly allows the two mappings to diverge *intentionally* (Console and bot are independently meaningful in that row) — the real risk is *unintentional* divergence in a deployment where the operator meant the two to track each other, with no mechanism or warning when they drift.

**This is an operator-configuration/tooling problem, not an authorization-architecture problem**, per the operator's own conclusion. No change to *who decides* is needed. What may be worth a follow-up (not blocking, not designed here): making it easy for an operator to populate or verify Console's role-ID mapping against the bot's `guild_roles` (e.g., the bot's setup portal surfacing or pushing suggested values, or a doctor-style check flagging a mismatch) — explicitly deferred, see §5.

---

## 4. Real code gap identified: standalone console-OAuth has no role path

Confirmed via `console/api/src/integrations/discord/oauth.js`: when console OAuth login is enabled but no bot handoff is configured, `resolveBootstrapTier()` can only ever return `"owner"` (if the user is on the static allowlist for the home guild) or `""` (deny) — there is no way to reach Moderator/Admin tiers through login alone in this mode.

The operator confirmed this is a real, intended-to-be-supported deployment shape (row 2/3: console OAuth with no bot at all), not a bootstrap-only-then-abandon flow — "OAuth with no bot is valid. OAuth will provide roles if configured." This means row 2/3's current behavior for row 3 (roles configured) is **not actually implemented** — only the row-2 shape (owner-only) exists in code today.

**Required change:** extend the non-handoff branch of `createOAuthTierResolver`/`resolveBootstrapTier` to check a role-ID-to-tier mapping (the same shape as the adapter's `DISCORD_*_ROLE_IDS`, either reusing those exact env vars or a parallel `DISCORD_LOGIN_*_ROLE_IDS` set — **open question for the implementation plan**, not resolved here) before falling back to the current owner-allowlist-only behavior. This is the one piece of this design that is a genuine code change, not a reframing of existing behavior.

---

## 5. Explicitly deferred (named for the record, not designed here)

- **Keeping Console's adapter role-ID mapping in sync with the bot's `guild_roles`** (§3.1) — a tooling/UX improvement, not an authorization change. Owner: whoever picks up the documentation work this design unblocks; revisit as its own scoped design if an actual mechanism (not just a doc warning) is wanted.
- **UX gap: adapter-disabled error clarity** (rows 4a/5a/6a) — does a bot user seeing every console-touching command fail get a clear "adapter not enabled" message, or a confusing generic error? Needs a real check against current behavior before scoping a fix.
- **UX gap: partial-config surprise** (rows 5b/6a) — an operator who configures Console roles but forgets the adapter (6a), or vice versa (5b), gets no signal that their configuration is incomplete relative to what they likely intended. A `dune doctor`-style check could catch this; not designed here.
- **Row 5b's execute-time-denial UX** — a bot user sees a command as available (per the bot's own `guild_roles`) that then hard-denies at the console because Console's roles aren't configured. Whether the bot should be made aware of Console's configuration state to avoid showing the command at all is an open question the operator has not yet resolved (raised, not decided, during the brainstorming dialogue).
- **Which exact env var(s) back §4's new role-mapping path** — reuse `DISCORD_*_ROLE_IDS` (shared with the adapter) or a parallel, login-specific set. Needs a decision in the implementation plan, informed by whether an operator would ever plausibly want *different* role mappings for "who can log into the console UI" vs. "whose privileged bot actions the console honors" (plausible in row 6b's own logic — these are allowed to diverge) — meaning reuse may be wrong and a parallel set may be more consistent with the rest of this design. Flagged, not resolved.

---

## 6. Decision log (for anyone reading this design cold)

Captured because this was a direct dialogue, not a dispatched review — the reasoning matters as much as the conclusion:

1. **Priority deployment confirmed:** hosted bot + password-only console (row 4b) is the common case this investigation should optimize for.
2. **Standalone console-OAuth (no bot) confirmed as a real, valid deployment** — not just a bootstrap-to-owner-then-abandon flow. This is what surfaced the §4 gap.
3. **Initial proposal rejected:** making the bot authoritative for adapter decisions specifically when it's "the only OAuth" (row 4b as a special case). Operator's counter-principle — "authorization falls to console; if it has roles adhere to them, if no roles then owner only; the code lives in console and all calls are checked console-side" — was adopted instead, as a single uniform rule with no special-casing, and confirmed to already match existing code with zero changes needed.
4. **Bot command gating and adapter authority are always two separate decisions**, established early and held throughout — Console never overrides which commands the bot shows in Discord; the bot never overrides whether Console honors a privileged action.

**Layer 2 audit findings, incorporated 2026-09-08** (retroactive eight-hats pass against this doc + the 3 companion PRs; see the tracking issue for the full findings register):
5. **Architect hat (HIGH):** the companion `operator-guide.md` PR initially claimed console login (#4) "works the same way" as the adapter (#3) — implying it, too, could be configured with role IDs. False: §4's gap means #4 has no role-mapping path at all today, only owner-or-deny. Fixed in `operator-guide.md`.
6. **Architect hat (MEDIUM):** §2's matrix "Console Roles" column conflated two independently-configured things (console login-OAuth roles for rows 1-3; the adapter's own roles for rows 4-6) and didn't show that the adapter's role config varies independently of console OAuth even in row 4. Fixed by splitting row 4b into 4b-i/4b-ii and adding an explanatory note.
7. **GRC hat:** flagged a real merge-order risk — the companion `operator-guide.md` PR links to this file by path; if it merges first, the link is briefly dead. Resolved by merging this PR first.

---

## 7. Relationship to the in-flight documentation work

`mentat-link` PR #133 (open) and planned companion work in this repo and `mentat` currently frame the bot/console relationship purely in terms of *terminology* (which of the 4 Discord-named things is which). That work should be updated to also state this design's §3 conclusion plainly: **Console decides privileged actions, using its own configuration, independent of the bot** — this is likely the single most useful sentence for an operator, more important than the terminology disambiguation alone. The §4 gap, once fixed, also needs its own operator-facing documentation (how to configure standalone console-OAuth roles).
