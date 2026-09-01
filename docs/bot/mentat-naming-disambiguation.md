# "Mentat" Naming Disambiguation (Discord Bot vs. In-Game Specialization)

**Date:** 2026-08-31 (implementation completed 2026-09-01)
**Status:** Current
**Companion repository:** [Project-Arrakis/sentinel](https://github.com/Project-Arrakis/sentinel) *(GitHub repo rename to `mentat` still pending — see Project-Arrakis/meta#56; the bot's own product branding is already "Mentat" as of `sentinel#234`)*
**Tracking issue:** [Project-Arrakis/meta#56](https://github.com/Project-Arrakis/meta/issues/56)

## Summary

The companion Discord bot (formerly "Arrakis Control Panel" / "ACP", most recently "Sentinel") is being renamed to **Mentat**. This document exists because that name collides with something already real in this repository: **"Mentat" is a pre-existing, unrelated in-game player-specialization / skill-track category** that this console's admin UI has managed since before this rename was proposed.

This is a naming homonym, not a naming conflict. Neither meaning is being renamed to resolve the collision. This document exists so that distinction stays explicit for anyone editing bot-integration code in this repository.

## The two meanings

| | The Discord bot | The in-game specialization |
|---|---|---|
| What it is | A companion application, external to this repository, that calls this console's API | A real player specialization/skill-track category, part of the actual game data this console administers |
| Canonical name | **Mentat** (product/bot), **Mentat Mnemonic** (its companion web app — corrected from an earlier "Mentat Web" working name) | **Mentat** (unchanged, always has been) |
| Owned by | `Project-Arrakis/sentinel` (GitHub repo rename to `mentat` still pending) | This repository — confirmed identical in the pristine Red-Blink upstream, i.e. canon game content, not fork-specific |
| Where it shows up here | Comments/docs describing the bot integration; a small number of API-consumed identifiers (see below) | `console/web/src/features/players/CharacterAdminUI.tsx`, `PlayerCategoryIconRail.tsx`, `SpecializationTab.test.tsx`, `runtime/data/admin-skill-modules.json` |

## What changed in this repository (implemented 2026-09-01)

Every item originally scoped here is done, plus several more found by a repo-wide sweep once implementation started. Only code/comments/docs that referenced **the bot** by an outgoing old name were changed, and only to say "Mentat" as the bot's name (or, for docs describing this site's own separate product, "Mentat Mnemonic" — this repo's own doc references are all about the bot, not the web app, so that distinction rarely came up here):

- `docs/rw-architecture.md:214` — `### Bot (arrakis-control-panel)` → `### Bot (Mentat)`
- `docs/bot/output-architecture.md` — companion-repo name/link corrected to the bot's current real location (`Project-Arrakis/sentinel`) and current product name (Mentat); issue links repointed from the retired `yacketrj` org
- `console/api/src/integrations/discord/commandCatalog.js` — the one present-tense "(arrakis-control-panel)" naming reference updated; several *undated* "confirmed/verified against arrakis-control-panel" comments normalized to "the bot repo" (repo-name-agnostic, since they don't cite a specific commit); the comments that DO cite a specific commit SHA (`@ 8f3d3ed`, 2026-08-18) were deliberately left as-is — they're accurate historical fact about what was verified at that commit, when the repo's name at the time was, in fact, still "arrakis-control-panel"
- `console/api/src/integrations/discord/roleTiers.js:65` — **not touched**: this file does not exist on `main` (it's part of unmerged work on the `tier4-totp-upstream` branch). Whoever eventually merges that branch will need its own naming pass; out of scope here
- `console/api/src/integrations/discord/handoff.js:3`, `.env.example:187`, `console/api/src/integrations/discord/multiAccountLinkProvider.js`, `console/api/test/discordCommandCatalog.test.js` — generic present-tense "the ACP bot"/"arrakis-control-panel" references updated
- `console/api/src/integrations/discord/linkProvider.js`, `multiAccountLinkProvider.js` — the generated verification-code prefix changed from `"ACP-"` to `"MENTAT-"`, plus the test fixtures/regex assertions in `discordLinkProvider.test.js`, `discordMultiAccountLinkProvider.test.js`, and `discordAdapter.test.js`. **This turned out not to need coordinated bot-side rollout** despite this document's own earlier caution: tracing the actual code confirmed the bot never inspects or validates this prefix — it's generated, stored, and verified entirely within this console's own database by exact string match; the bot only ever relays it as an opaque string. A pre-existing pending code (`ACP-XXXXXX`) already whispered to a player mid-flight at deploy time also still verifies correctly, since verification is a stored-value lookup, not a format/regex check.
- Also found and fixed during the same sweep (beyond the original scope of this document): `console/api/src/duneDb.js` (a `yacketrj/arrakis-control-panel` doc-path citation), `docs/runtime/METRICS-ALERTMANAGER-DISCORD-RELAY.md` (a live, "Status: Current" doc — bot references and a stale `yacketrj` issue link), `docs/security/secrets-management.md` and `docs/security/console-rbac-implementation-and-testing.md` (generic "ACP bot"/"arrakis-control-panel" prose; literal file paths and the still-live `ACP_SECRETS_KEY` env var name were deliberately left untouched, since those describe real, not-yet-renamed infrastructure — see the bot repo's own credential-vars deferral in `docs/env-var-compatibility.md`)

**Deliberately left untouched, with reasons:** `CHANGELOG.md`'s historical entries (accurate at the time they were written); `docs/security/discord-player-link-hardening.md` (an extensive, deeply commit-SHA-dated security investigation write-up — rewriting its citations to current branding would misrepresent what was actually true at each cited commit); every generic-programming "sentinel value" occurrence across the codebase (`duneDb.js`, `addonJobs.js`, `secondFactorStore.js`, the `console/web` test files, etc.) — unrelated to the bot brand, verified by reading context, not just string-matched.

## What must never change because of this rename

Every in-game "Mentat" reference above is real player-facing game data this console administers. It must not be renamed, relabeled, or have disambiguating text added to work around the homonym — doing so would misrepresent actual game content. If you are editing bot-integration code and you encounter "Mentat" in `CharacterAdminUI.tsx`, `PlayerCategoryIconRail.tsx`, `SpecializationTab.test.tsx`, or `admin-skill-modules.json`, that is the specialization, not the bot — leave it alone.

## References

- [Mentat Rename Ledger](https://claude.ai/code/artifact/fe568f39-ac04-4641-a222-c3bea37d228c) — running record of the full org-wide rename (discovery, naming, compatibility design, and each phase's implementation)
- [Project-Arrakis/meta#56](https://github.com/Project-Arrakis/meta/issues/56) — tracking issue for the implementation work scoped above
