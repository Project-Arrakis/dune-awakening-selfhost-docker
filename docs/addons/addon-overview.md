# Addon System Overview

**Status:** Current | **Last Updated:** August 2026

The addon system lets you extend the Dune: Awakening console with additional features through a plugin architecture.

## What are Addons?

Addons are optional extensions that add new functionality to your console:

- **Item Grants** — Admin-controllable item granting system
- **Scheduled Jobs** — Market bots and seasonal event automation
- **Hardware Status** — Host monitoring and telemetry dashboards
- **Custom Commands** — Community-created automation tools

## Installing Addons

### From the Console

```
Settings → Addons → Browse Addons
→ [Addon] → Install
→ Configure
→ Restart required
```

### From the Catalog

Browse community addons at [dune-docker-addons](https://github.com/Red-Blink/dune-docker-addons).

### Manual Installation

Place addon files in `./addons/` and configure in `.env`:

```bash
ENABLED_ADDONS="item-grants,scheduled-jobs,hardware-status"
```

Then restart:
```bash
dune restart
```

## Built-In Addons

### Item Grants Addon

Grant players items directly from the console.

- **Path:** Addons → Item Grants
- **Permission Required:** Admin
- **Related:** [Item Grants Documentation](addon-item-grants.md)

### Scheduled Jobs Addon

Automate recurring tasks and market operations.

- **Path:** Addons → Scheduled Jobs
- **Permission Required:** Admin
- **Related:** [Scheduled Jobs Documentation](addon-scheduled-jobs.md)

### Hardware Status Addon

Monitor server resources and performance.

- **Path:** Addons → Hardware Status
- **Permission Required:** Admin
- **Related:** [Hardware Status Documentation](hardware-status.md)

## Addon Permissions

Control which admins can access which addons:

```
Settings → Addon Permissions → [Addon] → Configure
→ Select which admin roles can use this addon
```

Permissions:
- **View** — Read data from the addon
- **Manage** — Create/edit/delete addon items
- **Configure** — Change addon settings

## Addon Permissions Model

Each addon declares which console permissions it requires.

### Item Grants

- Requires: `items:grant`
- Default role: Server Admin

### Scheduled Jobs

- Requires: `jobs:manage`, `bots:manage`
- Default role: Server Admin

### Hardware Status

- Requires: `system:view`
- Default role: Server Admin, Moderator

See [Console IAM](../console-iam.md) for complete permission model.

## Developing Addons

Addons use a standard JavaScript plugin interface:

```javascript
module.exports = {
  name: "my-addon",
  version: "1.0.0",
  install() {
    // Setup code
  },
  uninstall() {
    // Cleanup code
  },
  commands: {
    // Commands exposed to the console
  }
};
```

For full development guide, see the [Developer Guide](../../CONTRIBUTING.md).

## Addon Security

All addons are:

- **Sandboxed** — Cannot access host filesystem
- **Rate-limited** — API calls are throttled
- **Audited** — All actions are logged
- **Code-signed** — Community addons are verified

See [Addon Provenance](../security/addon-provenance.md) for security details.

## Troubleshooting

### Addon Won't Install

1. Check console logs: `dune logs console-api`
2. Verify addon compatibility with your server version
3. Try manual installation
4. Report issue on GitHub

### Addon Crashes

1. Disable the addon temporarily
2. Check logs for error details
3. Update to latest version
4. Report with logs if bug persists

### Missing Addon Features

Not all addons are available in all regions. Check:

```
Settings → Addons → Available Addons
```

To request an addon, open an issue on [GitHub](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues).

## Related Guides

- [Item Grants](addon-item-grants.md)
- [Scheduled Jobs](addon-scheduled-jobs.md)
- [Hardware Status](hardware-status.md)
- [Addon Provenance & Security](../security/addon-provenance.md)

---

**Need help?** See the [FAQ](../integrations/discord-integration/faq.md) or [GitHub Issues](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues).
