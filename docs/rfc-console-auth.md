# RFC: Console Layered Authentication — Discord OAuth (Fixed), Optional Passkeys, Hardened Password Fallback

**Date:** 2026-08-17
**Status:** Layer 1 Design — Request for Comment
**Audit:** Eight-Hat Layer 1 completed across three passes (two full, one targeted). Findings incorporated; full findings register in §8.

**Dependency note, checked directly against `upstream/main` before submitting this RFC:** §2.1 (Tier 1) and part of §2.2 (Tier 2) reference `console/api/src/integrations/discord/oauth.js` and `handoff.js` — the Discord OAuth sign-in + signed-handoff tier-resolution system. This code does **not exist on `upstream/main` today**. It was previously proposed as its own PR (#130, "Tranche 2: Discord OAuth sign-in with PKCE + tiered sessions", self-closed by the submitter, never merged) and currently exists only in this fork. The RBAC/session foundation it builds on (opaque sessions, `resolveSessionTier`, the policy engine) **did** land upstream via PR #134 and is present today — §2.3 (Tier 3) builds directly on that already-merged foundation and has no dependency gap. Sequencing is left to the maintainer's judgment: Tier 3 could be reviewed/merged independently of Tiers 1/2, or Tiers 1/2 could be resubmitted (individually or together with this RFC) if there's still interest in the Discord OAuth feature itself landing upstream. Flagging this now rather than presenting the whole design as if every piece it touches already exists on `main`.

---

## 1. Problem

The console's admin login today is a single shared password (`ADMIN_PASSWORD` or a generated secret) on both this fork and upstream, plus an optional "Sign in with Discord" path (`console/api/src/integrations/discord/oauth.js`) that resolves a tiered session via a signed handoff to the operator's own Discord bot — this second path exists only in this fork today (see the dependency note above).

Two independent, real problems exist in this area today, both confirmed against the current code, not theoretical:

**1.1 — A fail-open privilege-escalation bug in the existing Discord OAuth path.**

`resolveOAuthTier()` (`oauth.js:166-183`) falls through to a static, env-configured owner allowlist (`resolveBootstrapTier()`) whenever the bot's role-resolution handoff (`handoff.js`) returns an empty tier **for any reason** — network timeout, bot down, malformed response, or a genuine "this user has no access" denial are all indistinguishable to the caller:

```js
export function resolveBootstrapTier({ userId, guildIds, allowOwnerBootstrap, homeGuildId, ownerAllowlist = [] }) {
  if (!allowOwnerBootstrap) return "";
  if (!homeGuildId) return "";
  if (!guildIds.includes(homeGuildId)) return "";
  if (!ownerAllowlist.includes(userId)) return "";
  return "owner";
}
```

This requires four simultaneous conditions (bootstrap explicitly enabled, a home guild configured, live guild membership, and static-allowlist membership) — not "any Discord user" — but the real bug is genuine: an operator who runs with bootstrap enabled (a supported, documented configuration) and later revokes someone's Discord role, but doesn't also remember to prune the static `DISCORD_OAUTH_OWNER_ALLOWLIST` env var (no UI, no reminder, an easy miss), has that person's access silently restored to `owner` the moment the bot handoff has any hiccup at all — a bot restart, a network blip, or a deliberate DoS against the bot.

**1.2 — No hardened, non-Discord login path exists for operators who don't or can't use Discord.**

Every self-hosted operator of this project needs a working login even without any Discord integration configured (a fresh install, or a permanent choice not to run a Discord community around the server). Today, that path is the single shared password with no second factor and no recovery mechanism beyond the password itself — for an operator with no Discord and no reverse-facing TLS in their access path (a common, legitimate, permanent configuration — not just a startup-transient state), **this password is the sole thing standing between an attacker and full owner access, for the entire lifetime of the install.**

---

## 2. Architecture

Rather than replacing the password path with a single new "primary" mechanism (two earlier internal drafts of this design each tried that — one made Discord OAuth the sole primary and depended on Cloudflare Access for multi-admin identity management, the other made WebAuthn/passkeys the sole primary — both were rejected at Layer 1 audit for assuming a network/identity topology that doesn't hold for this project's actual, self-hosted, globally-diverse operator base; see §8 for the specific findings), this RFC proposes three independently-optional login tiers, so each operator's real deployment determines which one(s) they actually have:

### 2.1 Tier 1 — Discord OAuth (fixed)

**Depends on the not-yet-upstreamed Discord OAuth system** (see the dependency note at the top of this document — this section describes "what exists today" in the *fork*, not on `upstream/main`). No new requirement over what exists in the fork today. The only change is closing the fail-open bug from §1.1:

```js
// Current:
export function createOAuthTierResolver({ bootstrap = {}, handoff = null } = {}) {
  return async function resolveOAuthTier(identity) {
    const { userId, guildIds } = identity;
    if (handoff && handoff.enabled) {
      const tier = await handoff.resolveTier({ userId, username: identity.username });
      if (tier) return tier;
    }
    return resolveBootstrapTier({ userId, guildIds, ...bootstrap });
  };
}

// Fixed: only consult the bootstrap allowlist when the handoff is not
// configured at all -- never when it's configured but the specific call failed.
export function createOAuthTierResolver({ bootstrap = {}, handoff = null } = {}) {
  return async function resolveOAuthTier(identity) {
    const { userId, guildIds } = identity;
    if (handoff && handoff.enabled) {
      // Handoff is configured: its result is authoritative. An empty
      // result means "deny" (bot unreachable, or bot said no), not
      // "fall through to the static allowlist" -- the allowlist exists
      // only to bootstrap the very first owner on an install that has
      // never configured a handoff at all, not to survive an outage
      // once one is configured.
      return handoff.resolveTier({ userId, username: identity.username });
    }
    return resolveBootstrapTier({ userId, guildIds, ...bootstrap });
  };
}
```

This is the entire fix — no cache, no grace window, no new persisted state. `handoff.enabled` is already a static, boot-time-computed boolean (`handoff.js:27-33`), so the fix is a one-line change to *when* the bootstrap fallback is consulted, not a new mechanism.

**Trade-off, stated explicitly:** once an operator configures the bot handoff, a bot outage now means "no *new* Discord-tiered logins until the bot is back," instead of "the allowlist quietly grants owner regardless of the person's real current role." Already-active sessions are unaffected (session cookies validate against the in-memory session store, never re-checked against the handoff) — only *new* logins during an outage window are affected.

### 2.2 Tier 2 — Passkeys (opt-in, secure-context-gated)

**Partially depends on the not-yet-upstreamed Discord OAuth system**: the storage/registration mechanics below are independent of it, but re-resolving a passkey login's tier "the exact same way a fresh Discord login would" assumes that resolution path exists — on an install with no Discord OAuth (upstream today, before/unless #130-equivalent work lands), a passkey login's tier resolution would instead fall back to whatever tier system is present (currently the plain session/policy tier already merged via #134). Gated by an explicit, operator-set config value — never auto-detected from request headers (auto-detection would reintroduce a spoofable-header trust problem an earlier draft of this design had and rejected):

```
WEBAUTHN_RP_ID=console.example.com
```

Unset by default — byte-identical behavior to today; no passkey routes are even registered. When set, this string becomes the WebAuthn Relying Party ID, and the operator setting it **is** the confirmation that a secure context (HTTPS, or literal `localhost`) exists somewhere in their access path — WebAuthn's browser APIs (`navigator.credentials.create()`/`.get()`) are unavailable outside a secure context regardless of anything server-side, so an operator who sets this without actually having TLS anywhere simply finds registration fails client-side, with no security consequence.

**This tier is explicitly optional, not a replacement for Tier 3**, because this project's own deployment guidance for the console specifically recommends reaching it over a plain-HTTP VPN tunnel with no reverse proxy — an access pattern where WebAuthn's secure-context requirement is never satisfied. An earlier draft of this design made passkeys the sole primary login and was rejected at audit specifically because it would have broken login entirely for any operator following that exact guidance.

**Self-service registration is the second-admin-onboarding mechanism**: any already-authenticated admin (any tier) can add a passkey to their own identity from the settings panel. This reuses an authorization pattern this fork has already established for an analogous problem in its Discord adapter — `console/api/src/integrations/discord/policy.js`'s `SELF_SCOPED_CAPABILITIES` (`PLAYER_LINK_WRITE`, `ACCOUNT_LINK_WRITE`, fork-only, not currently on `upstream/main` — see the dependency note above), capabilities deliberately carved out of the normal tier ladder because "every route that checks it always passes `discordUserId = actor.userId`, never a separate target... gating it by role tier either over-restricts or over-grants." This RFC proposes applying the identical shape to the console's own session-based policy engine (which *is* present upstream via PR #134): a new action namespace (`self:passkey-register`/`self:passkey-remove`) outside `settings:*` entirely, checked by a dedicated `requireSelfScopedAction()` helper that only confirms a valid session exists, never a caller-supplied target. The pattern itself is transferable even where the original example isn't (yet) present upstream.

Storage is deliberately minimal — no new local-identity/account concept. A passkey credential is keyed by the `userId` already present on every session, in one small new file (`runtime/generated/webauthn-credentials.json`, via the console's existing `writeJsonAtomic()` helper, the same one `policy.js` already uses for `iam-policies.json`):

```json
{
  "version": 1,
  "credentials": [
    { "userId": "...", "credentialId": "...", "publicKey": "...", "signCount": 0, "label": "work laptop", "createdAt": "..." }
  ]
}
```

A passkey login authenticates *who* the person is, then re-resolves their **current** tier the same way a fresh Discord login would — so a passkey login is always as fresh/correctly-tiered as a live Discord login, and a demoted admin's passkey never grants a stale tier.

**Dependency**: `@simplewebauthn/server` (npm, MIT, `13.3.2`, 8 well-scoped transitive dependencies for CBOR/ASN.1/X.509 parsing) + `@simplewebauthn/browser` (MIT, zero dependencies) for the registration/authentication ceremonies, using the standard `attestationType: "none"` flow with neither the library's certificate-revocation check nor its FIDO Metadata Service integration ever enabled — keeping its own network-capable code paths entirely unreached. `qrcode` (npm, MIT, zero runtime dependencies in its browser bundle) for TOTP QR rendering (Tier 3, §2.3).

### 2.3 Tier 3 — Password + mandatory TOTP + recovery codes (universal, dual-role)

This tier is **not** pure emergency break-glass. For an operator with neither Tier 1 nor Tier 2 configured — no Discord community around their server, no TLS anywhere in the access path — this is their real, everyday primary login, every session, not a degraded fallback. For an operator who *does* have Tier 1 and/or Tier 2 configured, this tier correctly serves as break-glass recovery. Both roles are real and this design must be genuinely good at both, not merely tolerable in one.

This is why TOTP is **mandatory**, not optional, regardless of which role the tier is playing for a given operator: the justification is structural, not frequency-based. Tier 3 is the only tier backed by a single static, shareable, non-device-bound secret (unlike Tier 1's live Discord identity check or Tier 2's per-device passkey) — a compromised Tier 3 credential, for an operator with no Tier 1/2 configured, grants everything, unconditionally, for the entire lifetime of the install.

**Recovery codes**: 10, single-use, hashed with `scrypt` (Node's built-in `crypto.scryptSync`, no new dependency) using **explicit, non-default parameters** — Node's bare `scryptSync` defaults (`N=16384`) are below OWASP's current minimum recommendation for this use case, and OWASP-strength parameters (`N=131072, r=8, p=1`) throw `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` against Node's default 32MiB `maxmem` unless an explicit override is supplied. This RFC specifies `N=131072, r=8, p=1, maxmem=256MiB` (confirmed working, ~430ms per hash — acceptable for an action that happens a handful of times per install's lifetime) plus a random 16-byte per-code salt, rather than "use scrypt" alone. Consuming a code triggers forced TOTP+password re-setup on that same login, so losing a TOTP device does not permanently lock an operator out as long as they still have at least one unused recovery code.

**Session invalidation on credential rotation**: rotating the Tier 3 password/TOTP clears every session **except** the one performing the rotation, and requires that acting session to re-prove its own credential immediately before the rotation is accepted — not just trusted from an existing cookie. This closes two problems at once: legitimate concurrent admins are correctly logged out (a real credential-rotation event), and a session-hijacking attacker cannot use a stolen session alone to entrench a credential rotation, since the rotation itself demands fresh proof of possession.

**Audit logging**: every new state-changing action gets an explicit `audit()` call, following this codebase's existing pattern (already used 126 times in `server.js`): `settings.totp-setup`, `settings.totp-regenerated`, `settings.recovery-codes-regenerated`, `auth.recovery-code-consumed`, `auth.password-changed.sessions-revoked`, `settings.passkey-registered`, `settings.passkey-removed`.

**Backup/restore guidance** (two integrity edge cases this design introduces, both distinct from "old secrets become live again"):
1. Restoring `runtime/generated/` from a backup taken before a recovery code was consumed silently un-consumes it. Documented operator guidance: after any restore, regenerate the entire recovery-code set unconditionally.
2. Restoring an old `webauthn-credentials.json` rolls a passkey's server-recorded signature counter backward relative to the authenticator's real internal counter — WebAuthn's anti-cloning check treats a non-increasing counter as a cloning signal, risking a false-positive lockout of a legitimate device. Mitigation: a new owner-only settings action (`/api/settings/passkeys/reset-counters`) accepts the next successful assertion's counter as the new trusted baseline, rather than requiring full re-registration.

**`signCount` read-modify-write safety**: concurrent passkey logins racing on the same credential-store file need serialized reads/writes. A module-level `Promise` chain acts as a serializing queue (not a boolean lock) — each request appends its read-modify-write to the tail of the chain and awaits its own link, so concurrent requests are queued and both eventually succeed in arrival order, never rejected outright.

**Rate limiting on this path is unchanged** — the existing login rate limiter (8 attempts/key, 32 global, 15-minute block) is kept as-is. This project's own console deployment guidance already recommends VPN-based access (which preserves real per-client source IPs) over an HTTP-terminating reverse proxy/tunnel (which would collapse all client IPs to one shared bucket) for exactly this reason — a generic, proxy-aware fix is real, useful, future work, but is not required by this RFC's scope and is not attempted here.

---

## 3. Security Model

### 3.1 Tier independence and blast radius

Each tier's compromise has a bounded, tier-specific blast radius:
- A compromised Discord account only grants what that account's real, live-checked Discord role currently allows (re-verified on every login, not cached).
- A stolen/cloned passkey only grants access from that specific device/credential, and is individually revocable without affecting any other admin's access.
- A compromised Tier 3 credential is the only one that can grant unconditional owner access on an install with no Tier 1/2 configured — which is exactly why it receives the strongest hardening (mandatory TOTP, named-and-tuned KDF, proof-of-possession-gated rotation) regardless of how often it's actually used.

### 3.2 No new network-topology assumption

This design was revised specifically to remove a Cloudflare-specific rate-limiting mechanism an earlier draft proposed (trusting a `CF-Connecting-IP` header behind an operator-declared trusted-proxy IP). That mechanism was rejected because this project has a large, globally-distributed self-hosted operator base, most of whom do not run Cloudflare Tunnel/Access at all. This RFC introduces zero new network-topology assumptions, no new port, no new bind address, and no new outbound network dependency of any kind — `@simplewebauthn/*` and `qrcode` are both local-computation-only.

### 3.3 Origin binding is a documented operator constraint, not a code-level gap

`WEBAUTHN_RP_ID` is a single, static, operator-chosen value. An operator who reaches the console via more than one hostname/IP (e.g. a VPN-internal address and a public DNS name) must choose one canonical hostname for passkey purposes — consistent with this project's own existing documented preference to use exactly one consistent access path for the console. This is WebAuthn's phishing-resistance property working as intended (a credential registered against one origin is not valid for another), not a limitation this RFC attempts to code around.

---

## 4. Migration Path

- **Tier 1 fix has no upgrade-path complexity**: it's a behavior correction to already-optional, already-Discord-OAuth-configured installs only. An operator who has never configured Discord OAuth is completely unaffected.
- **`WEBAUTHN_RP_ID` unset (default) is byte-identical to today**: no new routes registered, no new file created, zero behavior change for any operator who doesn't opt in.
- **Tier 3's hardening is not gated behind an opt-in**: this is a correctness/security fix to an existing, always-on mechanism, with no new required config. An existing `ADMIN_PASSWORD` continues to authenticate exactly as today until an operator next changes it, at which point TOTP setup becomes part of that one-time flow.
- **No existing config key is renamed or removed.**

---

## 5. What This Replaces

| Current | After |
|---|---|
| *(fork-only, see dependency note above)* Discord OAuth silently falls through to a static owner allowlist on any handoff failure | Handoff failure denies access; allowlist only applies to a brand-new install with no handoff configured at all |
| Single shared password, no second factor, no recovery path | Password + mandatory TOTP + 10 single-use, properly-hashed recovery codes |
| No non-Discord device-bound login option | Optional, TLS-gated passkey support, self-service per-admin registration |
| Full-file, unscoped session invalidation on any credential change (considered and rejected during design) | Scoped invalidation (only the credential-type affected) + proof-of-possession required from the acting session |

---

## 6. Test Strategy

| Layer | What it tests | File |
|-------|---------------|------|
| Unit — Tier 1 fix | `handoff.test.js`'s two existing "falls back to bootstrap" tests: one (`handoff configured but failing`) is rewritten to assert denial; the other (`handoff never configured`) is re-verified unchanged, since that case is intentionally preserved | `console/api/test/handoff.test.js` |
| Unit — passkey ceremonies | Registration/authentication success and failure paths, using `@simplewebauthn/server`'s own known-good test fixtures | new `console/api/test/passkey*.test.js` |
| Unit — signCount safety | Concurrent-request queueing behavior; replay/rollback detection | new test, same file |
| Unit — recovery codes | Correct KDF parameters produce a working hash/verify round-trip within an acceptable time budget; single-use enforcement; forced re-setup on consumption | new `console/api/test/recoveryCodes.test.js` |
| Integration — session scoping | A credential-type-scoped rotation clears only the intended sessions, leaves others untouched, and requires fresh proof-of-possession from the acting session | extends `auth.test.js` |
| Upgrade-path | Fresh install (no config) → Tier 3 only, functions correctly; existing pre-RFC install with `ADMIN_PASSWORD` set → unaffected until first credential-rotation event; `WEBAUTHN_RP_ID` configured mid-lifecycle → Tier 2 becomes available without disrupting Tier 1/3 | extends existing upgrade-path test conventions |
| Frontend | Login form's passkey/password branching, settings-panel passkey list/add/remove, TOTP+recovery-code setup screen (QR + text-fallback secret shown together) | `console/web` Vitest suite |

---

## 7. Not in Scope

- **Removing the password/Tier 3 path entirely.** Not possible for this project's operator base — many self-hosted installs have no Discord community and no reverse-facing TLS, and Tier 3 must remain a fully legitimate, permanent, first-class login path for them, not a state to be designed out of existence.
- **Any Cloudflare-specific mechanism of any kind.**
- **A generic, proxy-aware fix for the shared-rate-limit-bucket problem** behind an HTTP-terminating reverse proxy/tunnel — real, deferred, separate work.
- **Multi-instance/clustered console deployment** — this console is, and remains, single-process; both new mechanisms (in-memory sessions, the passkey credential store) are designed against that existing architecture, not a future clustered one.
- **A local admin-identity/account system with its own credential-linking schema.** Discord OAuth remains the identity source for admin-ship; a passkey attaches to an existing, already-authenticated session rather than a new, parallel identity concept.

---

## 8. Audit Record

**Layer 1 Eight-Hat Findings (three passes: two full, one targeted against the final revision):**

- **Architect:** GO with the layered, tier-independent model over either single-primary alternative considered first; flagged and resolved a wrong precedent citation for the signCount concurrency fix (corrected to the existing pre-`await`-reservation pattern already used elsewhere in this codebase, not a whole-job lock).
- **Security:** GO with Tier 1's fix as a minimal, stateless correction (no caching, no new stale-privilege window); found and required a fix for a session-scoping regression (an earlier draft's design let a stolen session rotate the break-glass credential without losing its own access — closed by requiring fresh proof-of-possession from the acting session).
- **GRC:** GO with a full findings-traceability table carried in the design document itself (an earlier draft's own audit findings were never committed to a retrievable artifact — this pattern is not repeated); required explicit `audit()` coverage for every new state-changing action.
- **Network:** GO with Tier 2 as opt-in/TLS-gated rather than a sole primary, specifically because WebAuthn's secure-context requirement is incompatible with this project's own documented plain-HTTP-over-VPN console access guidance; confirmed no new network-topology assumption is introduced.
- **Cloud Security:** GO after confirming a Cloudflare-Access-dependent multi-admin-identity design (an earlier draft) doesn't achieve its own stated goal, since Access gates reachability before the console's own login ever runs; confirmed `@simplewebauthn/*` and `qrcode` introduce zero outbound network dependency as used.
- **UI:** GO after requiring concrete dependency naming (no "TBD, confirm at implementation" for new libraries) and requiring a text-fallback (not QR-only) presentation for the TOTP secret during setup.
- **DBA:** GO with a deliberately minimal new persisted file (credential ID/public key/counter only, no tier/identity data); required explicit backup/restore guidance for two new integrity edge cases (recovery-code consumption state, passkey signature-counter rollback) neither prior draft had addressed.
- **QA:** GO with named, file:line-specific existing tests that must change (not just new tests to add) — an earlier draft's audit found two passing tests that assert the exact fail-open behavior being removed, and this was not called out until a dedicated review pass caught it.

Three design iterations preceded this RFC, each corrected by direct Layer 1 audit findings (a Discord-primary-plus-Cloudflare-Access design, then a passkey-sole-primary design) before arriving at the layered model presented here. Full internal audit history and per-finding disposition is preserved in this fork's own development history for reference; this document presents the resulting, audited design.
