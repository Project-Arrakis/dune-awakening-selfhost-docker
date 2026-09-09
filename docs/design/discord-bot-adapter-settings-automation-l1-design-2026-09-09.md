# Discord Bot Adapter Setup Automation (Settings UI) — L1 Design

**Date:** 2026-09-09
**Status:** L1 design, drafted through a direct brainstorming dialogue with the operator (architectural path, per this org's brainstorming process). Layer 1 Eight-Hats audit findings incorporated inline below — see §7.
**Scope:** a new Settings UI section in Core that automates enabling the Discord bot adapter — token generation, `.env` writes, and applying the change — replacing the current fully-manual process. Applies identically regardless of whether the operator ends up connecting the hosted "Sahir Venn" bot (repos `mentat`/`mentat-link`) or a self-hosted instance of the same bot code; Core's side of this is unaware of which.
**Explicitly out of scope (v1):** automating the live-stats-sharing opt-in (a separate, lower-priority manual `.env` burden using the same underlying mechanism — deferred as a fast-follow once this path is proven); a live Discord role picker (would require Core to hold its own Discord OAuth scope for browsing an operator's server, a materially bigger feature); any change to `mentat`/`mentat-link` — this design touches Core only.

---

## 1. Problem statement

Confirmed by direct investigation (not assumed): Core already has a full, real backend for the Discord bot adapter — ~40 routes under `/api/integrations/discord/*` (`console/api/src/integrations/discord/`), bearer-token auth, role-ID-based tier mapping — but **zero frontend UI for configuring any of it**. Enabling the adapter today, for *both* the hosted and self-hosted bot paths, requires an operator to:

1. Hand-edit Core's `.env` to set `DUNE_DISCORD_ADAPTER_ENABLED=true` and `DUNE_DISCORD_ADAPTER_TOKEN_FILE=...`
2. Generate the token file themselves (`openssl rand -hex 32 > runtime/secrets/discord-adapter-token.txt`)
3. `chmod 600` it
4. **Recreate** (not just restart) the console container
5. Copy the resulting token value into wherever the bot side needs it (mentat's hosted setup-portal form, or their own self-hosted bot's `.env`)

This is real, current friction confirmed against `mentat`'s own `docs/installation-guide.md` and `src/setupServer.js` (the hosted setup portal's own inline copy walks the operator through exactly these five steps before it can accept a token). Core has zero awareness that this friction exists on its own side — the burden is identical whether the operator is heading toward the hosted bot or self-hosting.

Core's Settings page (`console/web/src/features/settings/SettingsPanel.tsx`) already has a structurally similar section — "Discord OAuth" — for a *different* purpose (console admin login via Discord, not the bot adapter). That section proves the UI pattern exists in this codebase; it has simply never been built for the adapter.

## 2. Why "real automation" is feasible without new risk

The blocking technical question for any UI-driven `.env` change is: **a running container never re-reads its own env vars**, so writing a new value has no effect until the container is recreated — and a process cannot cleanly recreate its own container from inside itself.

Confirmed directly: this exact problem is already solved in this codebase, for the "Updates" nav item. Core's console container has the Docker socket mounted (`docker-compose.web.yml`, with an explicit existing warning comment about the trust this implies), and `console/api/src/tasks.js`'s `buildSelfUpdateHelperDockerArgs()` launches a **detached, ephemeral sibling helper container** (`docker run -d --rm`, survives the console's own teardown) that runs `runtime/scripts/self-update.sh`. That script's console-rebuild path runs `docker compose -f docker-compose.web.yml up -d --force-recreate <service>` — a real, already-shipped "recreate this exact container with fresh config" operation.

The frontend side is equally already solved: on "Apply Console Update," the UI shows a confirm dialog, then switches from live task-polling to **status-file polling** (`selfUpdateStatus.js`'s generated status file) once the update helper starts — because the live connection itself drops when the console goes down — then polls `/api/auth/state` until the recreated console reports back up, shows a countdown, and auto-reloads (with a manual "Refresh Now" always visible as a fallback).

**This design proposes reusing that exact mechanism** — same helper-container pattern, same status-file polling, same reconnect/reload UX — triggered by a Settings save instead of an image-update check. No new mechanism, no new trust boundary; the docker-socket access this relies on is the same one already shipped and accepted for self-update.

## 3. Proposed design

### 3.1 Frontend

A new "Discord Bot" section added to `SettingsPanel.tsx`, next to (not replacing) the existing unrelated "Discord OAuth" section, following that section's own form conventions. Three states:

- **Disabled** — a toggle/button: "Enable Discord Bot Integration."
- **Enabling** — confirm dialog (plain yes/no, matching the Updates gate — no player-aware check needed, this never touches the game server), then the same status-file-polling progress UI Updates already presents.
- **Enabled** — the generated token, masked with reveal/copy; a "Regenerate Token" action; plain-text role-ID inputs (Observer/Moderator/Admin — matches the adapter's existing `DISCORD_*_ROLE_IDS` env vars exactly, no Owner field, matching `discordActorTier()`'s existing real-guild-ownership-only Owner rule); and two clearly labeled next-step links: "Using the hosted bot? → paste this into mentat-link's setup form" / "Self-hosting? → put this in your bot's `.env`" (see `mentat`'s `docs/installation-guide.md`).

### 3.2 Backend

New route(s) under `/api/settings/discord-bot` (read current state; enable/configure; regenerate token), gated by the existing `Action.SETTINGS_WRITE` permission the rest of Settings already requires — no new permission model.

- **Token generation**: same convention the manual docs already describe (`crypto.randomBytes`-equivalent to `openssl rand -hex 32`), written to `runtime/secrets/discord-adapter-token.txt` at `0600` — no new secret-storage convention invented.
- **Recreate trigger**: reuses the detached-helper pattern from `buildSelfUpdateHelperDockerArgs()`, recreating with the **current image** and **new env only** (no pull/build step). Whether `self-update.sh`'s compose-recreate step can be cleanly parameterized to skip the image-pull/build part, or needs a small additive sibling path, is an open implementation-time question — not a design blocker, flagged here for the implementation plan to resolve.
- **Status polling**: reuses `selfUpdateStatus.js`'s status-file schema/polling under a distinct run type, so the frontend's existing drop/reconnect handling works unmodified.

### 3.3 Data flow

1. Operator toggles "Enable Discord Bot Integration" → confirm dialog → `POST /api/settings/discord-bot`.
2. Backend generates the token, writes the secret file, updates `.env` (`DUNE_DISCORD_ADAPTER_ENABLED`, `DUNE_DISCORD_ADAPTER_TOKEN_FILE`, any submitted role-ID vars), launches the detached helper with the same docker-socket + repo-root mounts self-update already uses.
3. Helper runs `docker compose -f docker-compose.web.yml up -d --force-recreate <console-service>`, writes status to the generated status-file location.
4. Frontend polls the status file, shows progress, then polls `/api/auth/state` until back up, counts down, auto-reloads.
5. Post-reload, the Discord Bot section shows "Enabled" with the token and next-step links.

## 4. Error handling

- Helper-launch failure (e.g., a Docker socket issue): surfaced inline before the dialog closes, matching whatever failure-path UX self-update already has for the same case.
- Recreate succeeds but the new container fails health check (e.g., a malformed token file write): status file reports failed, frontend shows the error instead of the success countdown — identical to a failed self-update today.
- **Token regeneration risk**: an operator's bot (hosted or self-hosted) may already hold the old token. Regenerating disconnects it until the operator re-pastes the new value wherever their bot is configured — Core has no way to reach either bot type to update it automatically. The UI must warn explicitly before regenerating, not just silently rotate.

## 5. Testing

- Backend: unit tests for token generation, `.env` writing, and helper-argument construction, mirroring the existing self-update test suite's own patterns.
- Frontend: component tests for the three UI states.
- Real container-recreate behavior isn't meaningfully unit-testable — requires a manual verification pass against a real environment (dune-dev) before shipping, per this org's Requirement 0 ("test the actual upgrade, not just the new state").
- No new DB schema — purely `.env`/secret-file based; Requirement 26 (migration rollback) doesn't apply.

## 6. Requirement 0 / blast radius

Core is a public, multi-operator fork. This design is purely additive: a new Settings section, a new route, no change to any existing route or behavior — an operator who never opens this section sees zero difference. It reuses the exact trust boundary (docker-socket access from the console container) already shipped and accepted for self-update, rather than introducing a new one.

## 7. Layer 1 Eight-Hats Audit

_(dispatched against this design before implementation begins; findings and resolutions below)_
