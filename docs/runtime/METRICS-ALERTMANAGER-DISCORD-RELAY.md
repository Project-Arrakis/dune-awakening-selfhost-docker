# Alertmanager Discord Relay Authentication

**Status:** Current | **Last Updated:** August 2026

This document covers `dune-alertmanager`'s `discord-relay` receiver
(`runtime/metrics/alertmanager/alertmanager.yml`), which forwards firing/
resolved Prometheus alerts to a Discord channel via the external ACP
(Arrakis Control Panel) bot's `POST /api/alerts/relay` endpoint.

## Background

`POST /api/alerts/relay` previously had zero authentication --
`yacketrj/arrakis-control-panel#167` found that anyone who discovered its
URL could inject arbitrary-looking alert payloads and have them relayed
to the real, configured Discord channel as if genuine. The fix spans two
repositories:

- **arrakis-control-panel** (the bot): validates a shared secret sent as
  `Authorization: Bearer <token>`, via `DUNE_ALERT_RELAY_TOKEN`/
  `DUNE_ALERT_RELAY_TOKEN_FILE`. Deliberately opt-in/backward compatible
  -- if unset, the bot still accepts requests (logging a warning) rather
  than breaking every existing deployment the moment this ships.
- **This repo** (Core): Alertmanager sends that same shared secret as its
  `discord-relay` receiver's `webhook_configs[].http_config.authorization`
  credential.

## Setup

### 1. Generate the shared secret (automatic)

`dune metrics start` / `dune metrics restart` auto-generate
`runtime/secrets/alert-relay-token.txt` (a random 32-byte hex value, mode
`600`) the first time either is run, the same way `start-director.sh`
auto-generates `runtime/secrets/rmq-http-token-auth-secret.txt` and
`runtime/secrets/fls-apikey.txt`. You do not need to create this file
yourself, and an existing deployment upgrading to this change will have
it created automatically on its next metrics-stack start/restart --
nothing breaks if you don't take any action immediately.

This file is bind-mounted read-only into `dune-alertmanager` at
`/etc/alertmanager/secrets/alert-relay-token.txt`, and is git-ignored
(`runtime/secrets/` is never committed).

### 2. Configure the bot with the matching value

Copy the generated file's contents into the bot's own configuration:

```bash
cat runtime/secrets/alert-relay-token.txt
```

Then, on the bot's host, set one of:

```bash
# Direct value (simpler, less ideal for process-list visibility)
DUNE_ALERT_RELAY_TOKEN=<paste the value here>

# OR: point at a copy of the file (preferred -- avoids the value
# appearing in `ps`/`/proc`)
DUNE_ALERT_RELAY_TOKEN_FILE=/path/to/alert-relay-token.txt
```

Restart the bot for the new value to take effect.

### 3. Verify

Trigger a real test alert (or use `amtool alert add` against the
Alertmanager container) and confirm it appears in the configured Discord
channel. Check `dune-alertmanager`'s logs (`dune metrics logs
dune-alertmanager`) for any `401`/authorization errors from the bot side,
and the bot's own logs for `alerts_relay.unauthorized` or
`alerts_relay.unauthenticated_request_allowed` events.

## What happens if the secret is lost or needs rotation

There is no recovery path for the existing value -- generate a new one
and update both sides:

```bash
rm runtime/secrets/alert-relay-token.txt
dune metrics restart   # regenerates the file
cat runtime/secrets/alert-relay-token.txt   # copy this into the bot's config, then restart the bot
```

Until the bot side is updated to match, the bot will reject Alertmanager's
requests with `401` (if the bot's own `DUNE_ALERT_RELAY_TOKEN` is set to
the old value) -- this is a fail-safe outcome (alerting pauses, loudly,
rather than silently accepting a stale/mismatched credential), not data
loss. No game data, backups, or other secrets are affected by rotating
this specific token.

## Why Alertmanager fails closed but the bot doesn't

These two sides deliberately have different failure behavior for the
same underlying gap, and that asymmetry is intentional, not an
inconsistency:

- **Alertmanager (this repo) fails closed**: if
  `runtime/secrets/alert-relay-token.txt` doesn't exist, Alertmanager
  refuses to start at all (a clear "no such file" error in `docker logs
  dune-alertmanager`), because this repo controls both the secret's
  generation and its only consumer (Alertmanager itself) -- there's no
  reason to ever run this receiver without a real credential once this
  fix has shipped.
- **The bot (arrakis-control-panel) is opt-in/fails open with a warning**:
  the bot is a separate, independently-deployed component that many
  operators run without this specific fork's Alertmanager setup at all
  (or with a different metrics stack entirely). Requiring the token
  immediately would break every existing bot deployment's alerting the
  moment the bot-side fix ships, before any operator has had a chance to
  configure the matching value. See `arrakis-control-panel`'s own
  `CHANGELOG.md` entry for `DUNE_ALERT_RELAY_TOKEN` for the full
  reasoning.
