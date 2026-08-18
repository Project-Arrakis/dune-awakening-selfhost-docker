# Secrets Management Deep Dive — PKI, CMK, Storage, Retrieval & Rotation

**Date:** 2026-08-07 (background sections trimmed and corrected 2026-08-15, issue #287)
**Status:** Historical evaluation. **Superseded for implementation details** — see below.

> **This document does NOT describe the actual implemented architecture.**
> The evaluation below (§1-3) led to choosing an age-based approach over
> Vault/Infisical/SOPS/Bitwarden, and that choice still stands. But the
> specific design this document originally proposed as "Phase 1"
> (a single `vault.json.age` blob containing every secret) was never
> built. What was actually implemented is a different, later design:
> **one `.enc` file per secret**, each independently encrypted with its
> own DEK, which is itself wrapped by a shared KEK — not one shared
> blob. For the real, current design and implementation status, see:
>
> - `docs/design/unified-age-secrets-management-l1-design-2026-08-13.md`
>   (canonical L1 design, in the `Arrakis-Project` meta-repo)
> - `runtime/scripts/lib/secrets.sh` / `secrets_aead.py` (the actual
>   library, stage 1 of the rollout — upstream PR
>   `Red-Blink/dune-awakening-selfhost-docker#160`, internal PR #286)
>
> §4-5 below (the old Phase 1-3 plan and implementation plan) are kept
> only as historical record of the discarded single-blob approach and
> must not be used as a guide to the current or planned architecture.

---

## 1. Current State

### 1.1 What Secrets Exist

| Secret | Location | Format | Permissions | Auto-Created | Rotatable |
|---|---|---|---|---|---|
| Admin web password | `runtime/secrets/admin-web-password.txt` | Plaintext | 600 | Yes (`getOrCreateSecret`) | Manual |
| Session signing key | `runtime/secrets/admin-web-session-secret.txt` | Plaintext base64url | 600 | Yes | Manual |
| Funcom service token | `runtime/secrets/funcom-token.txt` | Plaintext JWT | 600 | No (operator) | Via Funcom portal |
| Discord OAuth client secret | `runtime/secrets/discord-oauth-client-secret.txt` | Plaintext | 600 | No (operator) | Via Discord portal |
| Discord adapter token | `runtime/secrets/discord-adapter-token.txt` | Plaintext | 600 | No (operator) | Manual |
| Discord bot handoff secret | `runtime/secrets/discord-bot-handoff-secret.txt` | Plaintext | 600 | No (operator) | Manual |
| FLS API key | `runtime/secrets/fls-apikey.txt` | Plaintext | 600 | No (operator) | Via Funcom |
| RMQ HTTP token secret | `runtime/secrets/rmq-http-token-auth-secret.txt` | Plaintext | 600 | Manual | Manual |
| Server login password secret | `runtime/secrets/server-login-password-secret.txt` | Plaintext | 600 | Manual | Manual |
| Username server login secret | `runtime/secrets/username-server-login-secret.txt` | Plaintext | 600 | Manual | Manual |
| Public directory JSON | `runtime/secrets/public-directory.json` | Plaintext JSON | 600 | Auto-managed | N/A |
| ACP bot adapter token | `arrakis-control-panel/data/acp.db` | AES-256-GCM encrypted | 600 | Per-guild setup | Manual |
| ACP Discord bot token | `arrakis-control-panel/.env` | Plaintext env var | 600 | No (operator) | Via Discord portal |

**Total: 10+ secrets in 2 repos, all plaintext files except the bot's SQLite encryption layer.**

### 1.2 How Secrets Are Loaded Today

```
config.js: readInlineOrFile(env_var, file_path)
  → If env var set: use it
  → Else if file exists: read file, trim, return
  → Else: return ""

getOrCreateSecret(path, bytes):
  → If file exists: read it
  → Else: generate random, write file, return value
```

Each secret is loaded independently. There's no unified secret store, no key hierarchy, no master key, and no rotation mechanism. The only existing encryption is the ACP bot's `ACP_SECRETS_KEY` → AES-256-GCM for SQLite at-rest encryption of adapter tokens and OAuth access tokens.

### 1.3 The Current Threat Model

| Threat | Mitigation Today | Gap |
|---|---|---|
| Local file access by other processes | 600 permissions | Any process running as the `dune` user can read all secrets |
| Accidental git commit | `.gitignore` excludes `runtime/secrets/` | One misconfigured `.gitignore` and all secrets leak |
| Docker container mount exposure | Secrets directory bind-mounted into containers | Every container can read every secret — no per-container scoping |
| Backup exposure | `dune db backup` tars secrets directory | Backups contain plaintext secrets; no encryption-at-rest in backups |
| Operator error (terminal history) | None | Typing `cat admin-web-password.txt` exposes the secret in terminal |
| Log exposure | Manual discipline | A misconfigured log statement could dump a secret value |
| Secret rotation | None | No rotation schedule, no rotation tooling, no version tracking |

---

## 2. Candidate Solutions

### 2.1 Evaluation Criteria

| Criteria | Weight | Notes |
|---|---|---|
| Open source / free | **Mandatory** | No license costs for self-hosters |
| Single binary or minimal deps | **High** | Must run on Ubuntu 24.04 with no external DB required |
| Node.js integration | **High** | `config.js` needs to load secrets at startup |
| Shell script integration | **High** | `spawn-server.sh`, `dune` CLI scripts need secrets at container launch |
| Secret rotation built-in | **High** | Must support rotating secrets without downtime |
| Audit trail | **Medium** | Who accessed which secret, when |
| Encryption at rest | **Mandatory** | All secrets encrypted on disk |
| Encryption in transit | **Low** | All secrets used within the same VM (localhost) |
| PKI / CMK support | **Medium** | Asymmetric key pairs for signing (HMAC handoff #135 already uses symmetric) |
| Multi-machine support | **Low** | Single R740 deployment today |

### 2.2 Candidate Solutions

#### A. HashiCorp Vault (Community Edition)

**Overview:** Industry-standard secret management. KV v2 secrets engine, PKI engine, transit engine (encryption-as-a-service). Runs as a daemon with a storage backend.

**Pros:**
- The gold standard for secret management
- Full PKI: issue/revoke X.509 certs, manage CA hierarchies
- Transit engine: encryption-as-a-service — apps never see the key material
- KV v2: versioned secrets with rollback
- Dynamic secrets: generate temporary credentials (Postgres, etc.) that auto-expire
- Audit logging built-in
- Node.js client: `node-vault` library
- API-driven: everything is HTTP, easy to script from bash
- Secret rotation: lease-based with renewable credentials

**Cons:**
- **Heavy** — requires its own process, storage backend (raft/file/consul), unseal procedure
- Unseal keys are themselves a secret management problem
- Overkill for a single-node self-hosted game server
- Adds a new SPOF — if Vault is down, no secrets load, console won't start

**Fit:** 3/10 — correct tool for the wrong scale

#### B. OpenBao

**Overview:** Fork of HashiCorp Vault after BSL license change. Same API, same architecture. Community-maintained.

**Pros:** Same as Vault, but with a truly open-source license guarantee

**Cons:** Same as Vault — too heavy. Smaller community, less documentation.

**Fit:** 3/10 — same problems as Vault at smaller scale

#### C. Infisical

**Overview:** Modern open-source secret management platform. Web UI, CLI, SDK, secret rotation, dynamic secrets, audit logs. Self-hostable with SQLite or Postgres.

**Pros:**
- Web UI for managing secrets (visual editor)
- CLI for CI/CD and scripts
- Node.js SDK: `@infisical/sdk`
- Secret rotation: built-in, with configurable rotation policies
- Audit logs: who accessed what, when
- Lighter than Vault — single binary, SQLite backend option
- Dynamic secrets for Postgres
- Designed for teams, works for solo operators

**Cons:**
- Newer project — less battle-tested than Vault
- Still a separate daemon process
- Web UI requires browser access (not headless-friendly)
- Self-hosted version has fewer features than cloud

**Fit:** 6/10 — promising but still a separate service to manage

#### D. SOPS (Mozilla) + age

**Overview:** SOPS encrypts structured files (YAML, JSON, .env) using age keys. Files are encrypted at rest in git or on disk. No daemon — just a CLI tool.

**Pros:**
- **Zero infrastructure** — no server, no daemon, no unseal
- Git-friendly: encrypted files can be committed (age keys stay out of git)
- age keys are simple: one keypair per operator/machine
- `.env` files can be encrypted wholesale: `sops -e .env > .env.enc`
- Shell-friendly: `sops exec --decrypt .env.enc -- your-command`
- Node.js: can shell out or use `sops` npm wrapper
- Industry adoption: used by Mozilla, GitLab, FluxCD

**Cons:**
- **No secret rotation built-in** — rotation means re-encrypting the file with the same or different key
- No audit trail — file access is at the OS level only
- No per-secret access control — one key decrypts the whole file
- No dynamic secrets or lease management
- age key management is manual (key file on disk, same problem as current secrets)

**Fit:** 5/10 — solves encryption-at-rest elegantly but doesn't address rotation or access control

#### E. Custom Solution: age + Node.js Secret Manager

**Overview:** Build a minimal secret management layer using `age` for file encryption and a thin Node.js/CLI wrapper for key generation, secret retrieval, and rotation.

**Architecture:**
```
runtime/secrets/              (encrypted at rest with age)
├── .master-key.age           (age identity — encrypted with operator passphrase)
├── vault.json.age            (all secrets in one encrypted JSON blob)
│   ├── admin-web-password
│   ├── session-secret
│   ├── funcom-token
│   ├── discord-oauth-client-secret
│   ├── discord-adapter-token
│   ├── discord-bot-handoff-secret
│   └── ...
└── vault.json.age.1          (previous version after rotation)

config.js:
  import { loadSecrets } from "./secrets.js"
  const secrets = loadSecrets(repoRoot)  // decrypts vault.json.age with age key

spawn-server.sh:
  age --decrypt -i ~/.age/dune-server.key $SECRETS_FILE | jq -r '.funcom_token'
```

**Pros:**
- **Incremental** — replaces the current file-per-secret approach with one encrypted file
- **Zero new dependencies** beyond `age` (single Go binary, in apt: `age`)
- **Versioned rotation** — rotation = re-encrypt vault with new key, keep .1 backup
- **Familiar pattern** — same `readInlineOrFile` concept, just reading from a decrypted JSON blob
- **No daemon** — no SPOF, no unseal ritual
- **Costs <1 hour to implement** the basic version
- **CMK/Key rotation** — age supports multiple recipients; rotate the age identity

**Cons:**
- **No audit trail** — still OS-level
- **No per-secret access control** — one key decrypts all
- **Manual rotation** — needs a CLI script (which we'd build)
- **age key IS the master key** — if lost, all secrets lost; needs secure backup
- Not standardized — custom code we maintain

**Fit:** 8/10 — pragmatic, minimal, fits the current architecture, solves the core problems

#### F. Bitwarden Secrets Manager CLI

**Overview:** Bitwarden's enterprise secret management. Self-hosted server (Bitwarden Unified) + CLI for retrieval. SDKs for Node.js.

**Pros:**
- Self-hosted option (Bitwarden Unified, free for personal use)
- Web UI for management
- CLI: `bw get item <id>`
- Machine accounts for automation
- Secret rotation via the UI
- Already has a Node.js SDK

**Cons:**
- Requires Docker to run the self-hosted server
- Heavy for what we need — full password manager stack
- Bitwarden Unified needs 2 GB+ RAM
- Adds a new service dependency on the prod VM

**Fit:** 4/10 — correct tool, wrong scale

---

## 3. Trade-Off Matrix

| Criterion | Vault | OpenBao | Infisical | SOPS+age | Custom age | Bitwarden SM |
|---|---|---|---|---|---|---|
| Open source / free | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Single binary / minimal deps | ❌ | ❌ | ⚠️ | ✅ | ✅ | ❌ |
| Node.js integration | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| Shell script integration | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Secret rotation built-in | ✅ | ✅ | ✅ | ❌ | ⚠️ (scripts) | ✅ |
| Audit trail | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Encryption at rest | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| PKI / CMK | ✅ | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| Implementation effort | 20-30h | 20-30h | 15-25h | 5-8h | 3-5h | 15-20h |
| Operational overhead | High | High | Medium | Low | Low | Medium |

---

## 4. Recommendation (Historical — See Notice Above)

The decision made here was: **age-based, not a heavy daemon
(Vault/OpenBao/Infisical/Bitwarden)** — that conclusion still holds.
The specific implementation plan that followed from it (a single
`vault.json.age` blob, a `SecretsManager.tsx` UI, `secrets.sh audit`/
`rotate` subcommands) was **not built as designed** and has been
removed from this document to avoid describing a nonexistent system.
See the notice at the top of this document for what was actually
built instead.

**When to reconsider Vault/Infisical instead of the age-based
approach:** if this deployment ever needs 3+ machines with
coordinated secret access, or real PKI/certificate management. Until
then, the age-based approach (as actually implemented, not as
originally planned above) remains sufficient.
