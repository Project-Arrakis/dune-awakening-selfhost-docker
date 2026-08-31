# "Mentat" Naming Disambiguation (Discord Bot vs. In-Game Specialization)

**Date:** 2026-08-31
**Status:** Current
**Companion repository:** [Project-Arrakis/mentat](https://github.com/Project-Arrakis/sentinel) *(rename pending — see Project-Arrakis/meta#56)*
**Tracking issue:** [Project-Arrakis/meta#56](https://github.com/Project-Arrakis/meta/issues/56)

## Summary

The companion Discord bot (formerly "Arrakis Control Panel" / "ACP", most recently "Sentinel") is being renamed to **Mentat**. This document exists because that name collides with something already real in this repository: **"Mentat" is a pre-existing, unrelated in-game player-specialization / skill-track category** that this console's admin UI has managed since before this rename was proposed.

This is a naming homonym, not a naming conflict. Neither meaning is being renamed to resolve the collision. This document exists so that distinction stays explicit for anyone editing bot-integration code in this repository.

## The two meanings

| | The Discord bot | The in-game specialization |
|---|---|---|
| What it is | A companion application, external to this repository, that calls this console's API | A real player specialization/skill-track category, part of the actual game data this console administers |
| Canonical name | **Mentat** (product), **Mentat Web** (its web app) | **Mentat** (unchanged, always has been) |
| Owned by | `Project-Arrakis/mentat` (pending rename from `sentinel`) | This repository — confirmed identical in the pristine Red-Blink upstream, i.e. canon game content, not fork-specific |
| Where it shows up here | Comments/docs describing the bot integration; a small number of API-consumed identifiers (see below) | `console/web/src/features/players/CharacterAdminUI.tsx`, `PlayerCategoryIconRail.tsx`, `SpecializationTab.test.tsx`, `runtime/data/admin-skill-modules.json` |

## What changes in this repository

Nothing has changed yet — this document and Project-Arrakis/meta#56 only scope the work. When it is implemented, only code/comments/docs that reference **the bot** by an outgoing old name should change, and only to say "Mentat" as the bot's name:

- `docs/rw-architecture.md:214` — `### Bot (arrakis-control-panel)`
- `docs/bot/output-architecture.md` — companion-repo prose/links
- `console/api/src/integrations/discord/commandCatalog.js` — comments naming the companion bot repo
- `console/api/src/integrations/discord/roleTiers.js:65` — illustrative comment ("Sentinel's own data...")
- `console/api/src/integrations/discord/handoff.js:3` — comment ("the ACP bot resolves...")
- `.env.example:234` — comment describing the integration
- `console/api/src/integrations/discord/linkProvider.js:20` + `console/api/test/discordLinkProvider.test.js:95-96` — the generated verification-code prefix `"ACP-"`. This one is a cross-system contract (the code is relayed by a human from the bot into the console), not a cosmetic string — any change here needs coordinated rollout with the bot side, not a blind find-and-replace.

## What must never change because of this rename

Every in-game "Mentat" reference above is real player-facing game data this console administers. It must not be renamed, relabeled, or have disambiguating text added to work around the homonym — doing so would misrepresent actual game content. If you are editing bot-integration code and you encounter "Mentat" in `CharacterAdminUI.tsx`, `PlayerCategoryIconRail.tsx`, `SpecializationTab.test.tsx`, or `admin-skill-modules.json`, that is the specialization, not the bot — leave it alone.

## References

- [Mentat Rename Ledger](https://claude.ai/code/artifact/d93949d3-673e-4e92-911b-36030c320fa0) — Phase 1 discovery and Phase 2 canonical naming for the full org-wide rename
- [Project-Arrakis/meta#56](https://github.com/Project-Arrakis/meta/issues/56) — tracking issue for the implementation work scoped above
