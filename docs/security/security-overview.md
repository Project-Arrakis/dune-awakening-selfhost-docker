# Security Overview

**Status:** Current | **Last Updated:** August 2026

Comprehensive guide to the security model and threat controls built into the Dune: Awakening Docker Console.

## Security Principles

This deployment follows these core principles:

1. **Defense in Depth** — Multiple layers of protection
2. **Least Privilege** — Users and services have minimal required access
3. **Transparency** — Security decisions are documented
4. **Incident Response** — Clear procedures for handling breaches

## Key Security Features

### Authentication

- **Admin Console** — Strong password authentication with optional 2FA
- **API Tokens** — Bearer token auth for integrations
- **Session Management** — Automatic session expiry
- **Rate Limiting** — Prevent brute force attacks (see [Login Rate Limiting](login-rate-limit-defense.md))

See [Console IAM](../console-iam.md) for details.

### Authorization

Role-based access control (RBAC):

- **Server Admin** — Full console access
- **Moderator** — Player management only
- **Content Manager** — Map/system management only
- **Support** — View-only access

See [Console IAM](../console-iam.md) for complete permission model.

### Data Protection

- **Secrets Management** — Encrypted token storage (see [Secrets Management](secrets-management.md))
- **Player Data** — PII is redacted in logs
- **Database Encryption** — At-rest encryption for sensitive fields
- **TLS/HTTPS** — All traffic encrypted in transit (via reverse proxy)

### Player Linking

Discord/Steam player linking with security hardening:

- **State Tokens** — Cryptographically secure linking verification
- **Token Rotation** — Tokens rotate on each auth
- **SameSite Cookies** — CSRF protection
- **Secure Cookies** — HTTPS-only

See [Player Linking Security](player-linking-security-architecture.md).

### Addon Security

Community addons are:

- **Code-signed** — Verified before installation
- **Sandboxed** — Cannot access host files
- **Rate-limited** — API throttling prevents abuse
- **Audited** — All addon actions are logged

See [Addon Provenance](addon-provenance.md).

## Threat Model

### Admin Account Compromise

**Risk:** Compromised admin can perform any action

**Controls:**
- Strong password policy
- Optional 2FA
- Session timeouts
- Activity auditing
- Emergency account lockdown
- Log review procedures

### Game Server Exploitation

**Risk:** Attacker gains game server access

**Controls:**
- Command auth token (signed, time-limited)
- Whitelist of allowed commands
- Rate limiting on all APIs
- Network segmentation
- Container hardening

### Database Breach

**Risk:** Player data (passwords, email, etc.) exposed

**Controls:**
- Database runs on isolated network
- Restricted port access (localhost only, no external exposure)
- Regular backups for recovery
- Activity logging for forensics

### Addon Malware

**Risk:** Malicious addon infects server

**Controls:**
- Code signing verification
- Sandboxing/isolation
- Activity auditing
- Installation confirmation
- Easy disable/uninstall

### DDoS / Resource Exhaustion

**Risk:** Server crashes from legitimate traffic surge

**Controls:**
- Rate limiting on player connections
- Timeout policies
- Resource quotas per player
- Load testing procedures

## Security Audits

This project undergoes regular security reviews:

- **L1 Design Audit** — Architecture threat modeling
- **L2 Implementation Audit** — Code-level vulnerability scanning
- **L3 Integration Audit** — Full-stack testing
- **Penetration Testing** — Real-world attack simulations (periodic)

See [Console Layered Auth Design](../design/console-layered-auth-l1-design-2026-08-17.md) for recent audit results.

## Incident Response

If you discover a security issue:

1. **Do not publicize** — Responsibly disclose to security team
2. **Report immediately** — Email or GitHub Security Advisory
3. **Provide details** — Steps to reproduce, impact assessment
4. **Allow time to fix** — Typically 30-90 days before public disclosure

See [SECURITY.md](../../SECURITY.md) for detailed response procedures.

## Related Documentation

### Authentication & Authorization

- [Console IAM](../console-iam.md) — Permission model
- [Login Rate Limiting](login-rate-limit-defense.md)
- [Generated Command Auth Tokens](generated-command-auth-token.md)

### Data Protection

- [Secrets Management](secrets-management.md)
- [Data Classification & Access Review](data-classification-and-access-review.md)
- [Age-Based Secret Encryption](age-secrets.md)

### Player Security

- [Player Linking Security](player-linking-security-architecture.md)
- [Discord Player Link Hardening](discord-player-link-hardening.md)

### System Security

- [RBAC Implementation & Testing](console-rbac-implementation-and-testing.md)
- [Container Hardening](../runtime/CONTAINER-HARDENING.md)
- [Addon Provenance](addon-provenance.md)

### Audit & Compliance

- [Full Security Audit 2026-07-04](audit-2026-07-04.md)
- [Command Auth Token Incident](command-auth-token-vulnerability-and-failed-remediation.md)

## Best Practices for Operators

### Secrets Management

- Never commit tokens or passwords to Git
- Rotate secrets monthly
- Use strong, unique passwords (20+ chars)
- Store secrets in `runtime/secrets/` with 0600 permissions

### Admin Governance

- Use separate admin accounts (no shared logins)
- Grant least required privilege
- Disable unused admin accounts
- Review admin activity monthly
- Use Discord role-based access when available

### Network Security

- Use a reverse proxy (nginx, Apache) for HTTPS
- Enable a firewall (ufw, iptables)
- Only expose necessary ports
- Use Cloudflare or similar DDoS protection if public

### Backup Security

- Store backups securely (encrypted, off-site)
- Test restore procedures regularly
- Limit who can access backup files
- Rotate backup credentials monthly

## Security Roadmap

Planned improvements:

- [ ] Hardware security module (HSM) support for secrets
- [ ] Multi-factor authentication (2FA) for admins
- [ ] Real-time threat detection
- [ ] Enhanced audit logging
- [ ] Automated security scanning

---

**Need help?** See the [FAQ](../integrations/discord-integration/faq.md) or [Troubleshooting](../integrations/discord-integration/troubleshooting.md).

**Report a security issue?** See [SECURITY.md](../../SECURITY.md).
