# Discord Bot Output Architecture

**Date:** 2026-08-10
**Repo:** yacketrj/arrakis-control-panel

## Overview

The Arrakis Control Panel Discord bot surfaces 54 slash commands across
9 groups. Output formatting was consolidated from 4 independent rendering
paths into a single unified pipeline with shared enrichment.

## Unified Output Pipeline

```
src/output/
├── pipeline.js       # Single call site: sendEmbed, sendCard, sendError, sendText, sendEphemeral
├── enricher.js       # Footer, timestamp, version applied to ALL outputs
└── (formatters in embedFormat.js)
```

Every command response flows through one of 5 pipeline methods:
- `sendEmbed()` — styled Discord embed (primary path, ~30 commands)
- `sendCard()` — PNG image card + optional embed (13 OPS + server status commands)
- `sendError()` — red-styled error embed (all errors)
- `sendText()` — plain text with enrichment footer (fallback)
- `sendEphemeral()` — ephemeral embed (auth/cooldown denials)

## Output Polish (12 fixes, 2026-08-10)

| Fix | Description |
|-----|-------------|
| Dead formatter cleanup | Removed 10 unused OPS embed formatters from import chain |
| fmtBool guard | `undefined`/`null` shows "— Unknown —", not "❌ No" |
| Dynamic colors | Population/Storage/Unlink/Ports use warning on empty, success on data |
| Readiness undefined | `r.ready === true` (not `!== false`) prevents false "READY" |
| Null placeholders | formatGenericEmbed shows "— None —" instead of silently dropping fields |
| "?" fix | Population missing counts show "— Unknown —" not "?" |
| Map names guard | Missing map names show "Unknown Map" not "undefined" |
| Steam-link embed | Uses styled embed + button instead of raw text |
| Auth/cooldown embeds | Ephemeral denials use styled embeds, distinct from permanent errors |
| Bold fmt() | String values render in **bold** for consistency with dedicated formatters |
| Dedicated formatters | 7 command groups got dedicated formatters replacing generic JSON flattening |

## Architecture Properties

- **Single edit site**: adding a footer/timestamp/version to all output requires editing `enricher.js` only
- **Domain-separated formatters**: each command group has its own `format*Embed()` function in `embedFormat.js`
- **Pipeline testability**: formatters are pure functions `(payload) → embed`, testable against JSON fixtures
- **Card + embed composition**: OPS commands can send both a PNG card and a styled embed simultaneously

## Related

- yacketrj/arrakis-control-panel#114-131 (output polish issues)
- yacketrj/arrakis-control-panel#118 (unified pipeline)
- Red-Blink/dune-awakening-selfhost-docker#141 (RW architecture docs)

## Requirements Compliance

- **Requirement 13**: Issue #231 filed before PR creation
- **Requirement 19**: Created as draft, marked ready after local verification
- **Requirement 20**: Docs-only PR — Layer 1 design audit not applicable (no code)
- **Requirement 21**: Branch `docs/bot-output-architecture` used, not main
- **Requirement 22**: Test drift checked — N/A (docs-only, no test code changed)
