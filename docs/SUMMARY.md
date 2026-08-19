# Table of Contents

## Getting Started
* [Introduction](README.md)
* [Quick Start Guide](quick-start.md)
* [Installation & Setup](installation-setup.md)
* [Screenshots Gallery](screenshots.md)

## Console Documentation

### Console Overview
* [Web Console Guide](console/web-console-overview.md)
* [Authentication & IAM](console-iam.md)

### Console Operations
* [Base Management](console/base-management.md)
  * [Base Backups](console/base-backups.md)
  * [Base Deletion](console/base-deletion.md)
  * [Base Inventory](console/base-inventory.md)
  * [Base Permissions](console/base-permissions.md)
* [Database Management](console/database-backups.md)
* [Player Management](console/player-management.md)
* [Map Management](console/map-management.md)

### Game Systems
* [Blueprint Management](console/blueprints.md)
* [Pre-Augmented Gear](console/PRE-AUGMENTED-GEAR.md)
* [Exchange System](console/exchange.md)
* [Generator Systems](console/generator-systems.md)
  * [Fuel Burn Rates](console/generator-fuel-burn-rates.md)
  * [Refill Capacities](console/generator-refill-caps.md)
* [Restart Queue](console/restart-queue.md)

### Console API
* [Console API Reference](console/API-REFERENCE.md)

## Runtime & Deployment

### Docker & Infrastructure
* [Container Architecture](architecture/container-architecture.md)
* [Container Hardening](runtime/CONTAINER-HARDENING.md)
* [Metrics Stack](runtime/metrics-stack.md)
  * [Metrics & AlertManager Setup](runtime/METRICS-ALERTMANAGER-DISCORD-RELAY.md)
  * [E2E Metrics Testing](runtime/E2E-METRICS-TESTING.md)

### Advanced Deployment
* [Multi-Server Single Public IP](runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md)
* [Specialization Readiness Tool](architecture/SPECIALIZATION-READINESS-TOOL.md)

## Integrations

### Discord Integrations
* [Discord Integration Overview](integrations/discord-integration/README.md)
* [Discord Admin Guide](integrations/discord-integration/admin-guide.md)
* [Discord User Guide](integrations/discord-integration/user-guide.md)
* [Tier Tracking](integrations/discord-integration/TIER-TRACKING.md)
* [Discord Integration FAQ](integrations/discord-integration/faq.md)
* [Troubleshooting](integrations/discord-integration/troubleshooting.md)

### Discord Control Bot (ACP Integration)
* [Control Bot Setup](integrations/discord-control-bot/setup-guide.md)
* [Control Bot Admin Guide](integrations/discord-control-bot/admin-guide.md)
* [Control Bot User Guide](integrations/discord-control-bot/user-guide.md)
* [Control Bot API Contract](integrations/discord-control-bot/api-adapter-contract.md)

### Bot Architecture
* [Discord Bot Output Architecture](bot/output-architecture.md)

## Addons

### Addon System
* [Addon Overview](addons/addon-overview.md)
* [Item Grants Addon](addons/addon-item-grants.md)
* [Scheduled Jobs Addon](addons/addon-scheduled-jobs.md)
* [Hardware Status Addon](addons/hardware-status.md)
* [Addon Provenance & Security](security/addon-provenance.md)

## Security & Compliance

### Security Documentation
* [Security Audit 2026-07-04](security/audit-2026-07-04.md)
* [Security Model & Threats](security/security-overview.md)
* [Player Linking Security](security/player-linking-security-architecture.md)
  * [Discord Player Link Hardening](security/discord-player-link-hardening.md)
  * [Player Linking Implementation](security/player-linking-implementation.md)
* [Console RBAC Implementation](security/console-rbac-implementation-and-testing.md)
* [Login Rate Limiting](security/login-rate-limit-defense.md)
* [Command Auth Token Security](security/command-auth-token-vulnerability-and-failed-remediation.md)
* [Generated Command Auth Tokens](security/generated-command-auth-token.md)
* [Pre-Augmented Gear Security](security/pre-augmented-gear-grant.md)

### Secrets Management
* [Secrets Management](security/secrets-management.md)
* [Age-Based Secret Encryption](security/age-secrets.md)
* [Data Classification & Access Review](security/data-classification-and-access-review.md)

## Architecture & Design

### System Architecture
* [Read-Write Architecture](rw-architecture.md)
* [Command Discovery RFC](rfc-command-discovery.md)
* [Console Authentication RFC](rfc-console-auth.md)
* [Console Layered Auth Design](design/console-layered-auth-l1-design-2026-08-17.md)

### Engine & Commands
* [Command Catalog](engine/command-catalog.md)

## Incidents & Postmortems

### Incident Reports
* [Incident Index](../archive/INCIDENT-INDEX.md)
* [INC-2026-07-24: SteamCMD CDN Outage](incidents/INC-2026-07-24-STEAMCMD-CDN-OUTAGE.md)
* [INC-2026-07-27: Environment Root Ownership](incidents/INC-2026-07-27-ENV-ROOT-OWNERSHIP.md)
* [INC-2026-07-31: Fill Items Visibility](incidents/INC-2026-07-31-FILL-ITEMS-VISIBLE-ONLY-AFTER-RESTART.md)

## Contributing & Development

* [Contributing Guide](../CONTRIBUTING.md)
* [Changelog](../CHANGELOG.md)
* [License](../LICENSE)
* [Notice](../NOTICE)

## Resources

* [Official Website](https://dunedocker.app/)
* [GitHub Repository](https://github.com/yacketrj/dune-awakening-selfhost-docker)
* [Upstream Repository](https://github.com/Red-Blink/dune-awakening-selfhost-docker)
