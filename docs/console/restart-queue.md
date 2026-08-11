# Restart Queue

**Status:** Current | **Last Updated:** August 2026

The Restart Queue turns any console-triggered restart into a warned, player-aware
operation. When it is enabled and real players are online, a restart does not run
immediately — it starts a countdown and sends in-game **Server Broadcast**
warnings before the server goes down. When nobody is online, the restart runs at
once with no countdown.

The toggle lives in **Admin Tools → Schedule Server Restart**, between
**Daily Restart** and **Restart On Public IP Change**.

## What it gates

With the queue **enabled**, restart actions triggered *from the console* are
intercepted:

- Battlegroup restart
- Single-map respawn
- Service restart
- Sietch restart
- Settings-save-and-restart (saving user/gameplay settings that require a
  restart to apply — the whole save-and-restart is captured into the countdown
  and runs at T-0). A settings save that does **not** restart (`restart: false`)
  is unaffected.

For each gated action, the console first checks how many real players are online across the
battlegroup:

- **No real players online** → the restart runs **immediately**, with no
  countdown.
- **Players online** → a countdown starts (default **15 minutes**) and Server
  Broadcast warnings are sent at configurable checkpoints (default **15, 10, 5
  and 1 minutes** remaining). The restart runs at T-0. If everyone logs off
  before then, it restarts immediately.

## Enabling and configuring

Open **Admin Tools → Schedule Server Restart** and turn on **Restart Queue**.
Settings persist to `runtime/generated/restart-queue.json`:

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `false` | Master toggle. When off, restarts run as before, ungated. |
| `defaultCountdownMinutes` | `15` | Countdown length when players are online. |
| `broadcastCheckpoints` | `[15, 10, 5, 1]` | Minutes-remaining marks at which a warning broadcast is sent. |
| `broadcastDurationSec` | — | How long each broadcast banner is shown in game. |
| `recoveryGraceMinutes` | `5` | Crash-recovery window for a just-elapsed countdown (see below). |

Configuration is read per save, so changes take effect without a console
release.

## The two broadcast message variants

Warnings are delivered as in-game **Server Broadcast** banners. The variant
depends on the scope of the restart:

**Battlegroup restart**

- Title: `Battlegroup Restart`
- Body: `All servers will restart in {x} minutes. Please get to a safe place.`

**Single-map restart**

- Title: `Map Restart`
- Body: `{MapLabel} will restart in {x} minutes. Please move to another map or get to a safe place.`

The map warning is a **battlegroup-wide banner that names the map**, not a
per-map banner. The shipped game has no per-map titled banner, so the message is
broadcast to everyone and identifies the affected map by name in its body.

## Concurrency rules

Only one of these can be in flight at a time:

- **One battlegroup countdown**, XOR
- **Multiple simultaneous countdowns for distinct maps.**

Specifically:

- A battlegroup restart is **blocked while any map is restarting**, and a map
  restart is **blocked while a battlegroup restart is in flight**.
- The **same map cannot be queued twice** — a second attempt is rejected rather
  than starting a duplicate countdown.

A blocked attempt returns a concurrency conflict (see
[the endpoints](#endpoints)) rather than silently starting a second timer.

## Crash recovery

Active queue state persists to `runtime/generated/restart-queue-state.json` so a
countdown survives a console restart. On boot, each stored entry is reconciled:

| Stored state | Action on boot |
|---|---|
| Already dispatched | Cleared — never re-fired. |
| Countdown still in its window | Resumed. |
| Countdown just elapsed, within `recoveryGraceMinutes` (default 5) | Run now. |
| Countdown long-stale (past the grace window) | Discarded. |

This prevents a console crash from either double-firing a restart or silently
dropping one that was seconds away.

## Limitations

Two limitations are intentional in this version and are documented here so they
are not mistaken for bugs.

**Online-count scope is battlegroup-wide, not per-map.** The "players online"
check counts real players across the whole battlegroup. A **map** restart
therefore only runs immediately when the **entire battlegroup** is empty — a map
with no players still gets a countdown if anyone is online elsewhere. This is a
known v1 simplification.

**There is no join-lock.** Players can still join during a countdown. The shipped
game commands offer no way to block new joins with a reason, so only the T-0
restart itself stops joins. A player who joins mid-countdown will see the
remaining warning broadcasts but is not prevented from entering.

## Enforcement scope

Only **console-triggered** restarts are gated by the queue. These paths are
**not** gated in this version and keep their own existing warnings:

- The systemd daily-restart timer
- The public-IP-change monitor
- Direct CLI restarts

Extending the queue to cover those paths is a possible future enhancement.

## Endpoints

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/server/restart-queue` | Settings, defaults, active state and online count | None |
| POST | `/api/server/restart-queue` | Save settings | `enabled`, `defaultCountdownMinutes`, `broadcastCheckpoints`, `broadcastDurationSec?`, `recoveryGraceMinutes?` |
| POST | `/api/server/restart-queue/cancel` | Cancel one active countdown | `id` |
| POST | `/api/server/restart-queue/restart-now` | Execute one queued restart immediately | `id` |

`GET /api/server/restart-queue` returns the saved settings, the shipped defaults,
the active state (the queued `entries`), and the battlegroup `playersOnline`
count.

When the queue is enabled, the existing restart routes
(`/api/server/restart`, `/api/server/restart-service`, and the map/sietch restart
paths) answer:

- **`202 { queued: true, ... }`** when the restart is queued behind a countdown.
- **`409 { queued: false, error }`** when a concurrency conflict blocks it.

Append **`?restartQueue=immediate`** to a restart route to bypass the queue and
force an immediate restart.

## Related

- [API-REFERENCE.md](API-REFERENCE.md) — full HTTP API reference, including the
  Server Operations section these routes belong to.
