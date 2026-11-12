# Console themes

Status: Current (verified against the console build in this repository).

The palette button in the console header (next to the language button) opens **Console Theme**.
The choice applies to the browser you made it in and is stored in that browser's local storage
(`dune-console-theme`). Nothing is stored on the server, so each operator and each device picks
independently. **Default** is the standard console look and sets no overrides at all; clearing the
choice, or choosing Default, restores it exactly.

## What is offered

- 16 dark palettes from [Fedaykin Dune Themes](https://github.com/btriapitsyn/zed-fedaykin-themes) (MIT).
- Three looks from [Tabr](https://github.com/Project-Arrakis/tabr-tau) (MIT): Tabr Fremen, Tabr Awakening, Tabr Sietch.

Light palettes (Fedaykin Mentat and Fremen Sietch, the Tabr "Dayside" variants) are vendored and the
engine supports them, but they are **not offered**: the stylesheet still has many hardcoded dark
surfaces, so a light theme shows pale text on dark cards. They return once those surfaces use tokens.

## How it works

`console/web/src/themes/themeEngine.ts` maps each source palette onto the console's existing CSS custom
properties (`--bg`, `--panel`, `--text`, `--accent`, ...) by setting them on `<html>` at runtime, before the
first render so there is no flash. Text colours are pulled toward white or black until they reach WCAG AA
(4.5:1, 7:1 for body text) on the page and panel surfaces, so a palette whose own text colours are too dim
for the console is corrected rather than shipped unreadable. Colours that are hardcoded in the stylesheet
(for example the Discord and Support buttons, map and status colours) are not themed.

## Adding a palette

Drop a Fedaykin-format `dune-<name>.json` into `console/web/src/themes/palettes/` (slots `color_01`..`color_46`,
see the template in the Fedaykin repo) and it appears in the picker. `npm test` in `console/web` checks that every
palette yields a complete token set and meets the contrast floor. Keep each source's licence next to its files
(`palettes/LICENSE`, `tabr/LICENSE`).
