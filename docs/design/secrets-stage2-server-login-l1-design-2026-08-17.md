# Secrets Library Stage 2 — Wiring `server-login-password-secret` + `username-server-login-secret` — L1 Design

**Date:** 2026-08-17
**Status:** L1 design, revision 1. Not yet audited (Layer 1 eight-hats dispatch is the next step after this document).
**Tracking issue:** `dune-awakening-selfhost-docker#318`
**Upstream context:** `Red-Blink/dune-awakening-selfhost-docker#160` (library-only PR, open). Upstream maintainer's exact instruction, 2026-08-16T19:26:07Z:

> "Please build the first low-blast-radius credential integration on top of this work, then present the library and that first consumer together for review... That combined change should cover: Fresh installation / Plaintext migration / Missing or incorrect age identity behavior / Backup and restore / Recovery and rollback / Preservation of existing installations when encryption is not configured. Please keep PostgreSQL, Funcom, and RMQ out of this first integration."

This document is the Layer 1 design artifact for that combined change, scoped exactly to the two secrets our own PR #286/upstream #160 already named as "Stage 2" in their own body.
**Parent design:** `Arrakis-Project/docs/design/unified-age-secrets-management-l1-design-2026-08-13.md` (§7 in particular — this document implements a concrete subset of that design's Core upgrade-path mechanics for exactly these two secrets, not a new design from scratch).

---

## 1. Scope

**In scope — exactly 2 secrets, currently plain flat files:**
- `runtime/secrets/server-login-password-secret.txt`
- `runtime/secrets/username-server-login-secret.txt`

**Explicitly out of scope (per upstream's own instruction and existing issue boundaries):**
- PostgreSQL superuser/`dune` role password (issue #122/#263 — deliberately last, per upstream's own request; also `#251`'s DatabasePassword-argv problem is a separate, unrelated, currently-unsolvable issue)
- Funcom service token, RabbitMQ HTTP token-auth secret, FLS API key (unscheduled later stages per PR #286's own body)

**Current read/write call sites (verified 2026-08-17 against `main`@`09cb4fc9`):**

| File | Function | Lines |
|---|---|---|
| `runtime/scripts/runtime-env.sh` | `resolve_server_login_password_secret()` | 706-710 |
| `runtime/scripts/runtime-env.sh` | `resolve_username_server_login_secret()` | 712-716 |
| `runtime/scripts/spawn-server.sh` | calls both resolvers | 61-62, then ~10 `-e` aliases each, 592-621 |
| `runtime/scripts/start-director.sh` | calls both resolvers | 41-42 |
| `runtime/scripts/start-server-overmap.sh` | calls both resolvers | 24-25 |
| `runtime/scripts/start-server-survival-1.sh` | calls both resolvers | 24-25 |

All four call sites use the identical pattern: `VAR="$(resolve_X)"`, then pass `$VAR` into one or more `-e KEY=$VAR` docker run flags. No other reader exists (`console/api/test/usersettingsSecurity.test.js` and `console/web/src/features/maps/MapsPanel.tsx` reference the *concept* of server-login secrets for unrelated map/backend-config display purposes, not by reading the flat files — confirmed via grep, neither touches `runtime/secrets/`).

**Why these two, specifically (restating PR #286's own rationale, now verified against real call sites above):** neither secret is read by Postgres (`start-postgres.sh` doesn't reference either), the Funcom API client, or RabbitMQ (`start-rabbitmq.sh` doesn't reference either). A bug in this stage's wiring can affect, at worst, whether the game server's own login handshake with these two values succeeds — not database availability, not matchmaking (FLS/RMQ), not the Funcom API relationship. This confirms the low-blast-radius framing is accurate, not just asserted.

---

## 2. What Changes, Concretely

`resolve_server_login_password_secret()` and `resolve_username_server_login_secret()` in `runtime-env.sh` are the **only** two functions that change. Every one of the 4 launcher call sites is unchanged — they still call the same two resolver function names, expecting the same behavior (print the secret's value to stdout, generate-if-absent).

**Before (current, unchanged for any operator not opting in):**
```bash
resolve_server_login_password_secret() {
  local path="runtime/secrets/server-login-password-secret.txt"
  ensure_secret_file "$path" 32
  tr -d '\r\n' < "$path"
}
```

**After:**
```bash
resolve_server_login_password_secret() {
  local legacy_path="runtime/secrets/server-login-password-secret.txt"

  if dune_secrets_backend_configured; then
    local value
    if value="$(dune_secrets_read_secret "server-login-password-secret" "$legacy_path")"; then
      printf '%s' "$value"
      return 0
    fi
    # dune_secrets_read_secret already fails closed and prints a
    # diagnostic to stderr if a .enc file exists but won't decrypt --
    # do not fall through to ensure_secret_file below in that case,
    # or we'd silently generate a NEW random legacy secret while a
    # real, migrated one exists and is merely unreadable right now.
    # dune_secrets_read_secret's own return code distinguishes
    # "never migrated" (falls through internally to legacy_path,
    # which either exists or doesn't) from "migrated but broken"
    # (returns 1 after printing to stderr) -- but from THIS caller's
    # perspective both look like "return 1." See open question in
    # §6 -- resolved below by having read_secret's caller check
    # dune_secrets_encrypted_path existence directly first.
    return 1
  fi

  ensure_secret_file "$legacy_path" 32
  tr -d '\r\n' < "$legacy_path"
}
```

**Resolving the open question above, before implementation** (this is exactly the kind of gap the Layer 1 audit exists to catch — stated here explicitly rather than left implicit): the real implementation must check `dune_secrets_encrypted_path` existence itself, not rely on `dune_secrets_read_secret`'s return code alone, so that a migrated-but-broken secret produces a **loud failure that stops server startup**, not a silent fall-through into generating a brand-new random legacy secret (which would desync from whatever the game binary/operator expects, and would be a far worse failure mode than simply refusing to start). Concretely:

```bash
resolve_server_login_password_secret() {
  local legacy_path="runtime/secrets/server-login-password-secret.txt"

  if dune_secrets_backend_configured; then
    local enc_path
    enc_path="$(dune_secrets_encrypted_path "server-login-password-secret" 2>/dev/null || true)"
    if [ -n "$enc_path" ] && [ -e "$enc_path" ]; then
      # Migrated. Must succeed or fail loudly -- never fall through
      # to generating a new legacy secret once a .enc file exists.
      dune_secrets_read_secret "server-login-password-secret" "$legacy_path"
      return $?
    fi
    # Backend configured but this specific secret was never migrated
    # yet -- fall through to legacy behavior below, exactly as today.
  fi

  ensure_secret_file "$legacy_path" 32
  tr -d '\r\n' < "$legacy_path"
}
```

Same pattern, mirrored exactly, for `resolve_username_server_login_secret()`.

**`ensure_secret_file`'s role is unchanged** — it remains the generator for a *new* legacy secret when neither the encrypted nor legacy form exists yet (fresh install, backend not configured). It is never called once a `.enc` file exists for that secret.

---

## 3. New CLI Surface: `dune secrets`

No `dune secrets` subcommand exists today (confirmed via grep — zero matches for `dune secrets` or `dune-secrets` anywhere in `runtime/scripts/`). The parent design (`unified-age-secrets-management-l1-design-2026-08-13.md` §7.2) specifies `dune secrets setup`/`verify`/`cleanup-legacy`/`rotate`. Stage 2 needs a real, working minimum subset of this — not the full command surface, since most of it (KEK rotation, `age` binary provisioning via `dune doctor`, break-glass QR/Shamir setup) is out of scope for "wire two low-blast-radius secrets" and belongs to a later stage once more secrets justify the operational surface.

**Minimum viable subset for Stage 2, added as `runtime/scripts/secrets.sh` + a `secrets)` case in `runtime/scripts/dune`:**

- **`dune secrets status`** — for each of the 2 wired secrets: reports `not migrated (legacy plaintext)` / `migrated (encrypted)` / `backend not configured`. Read-only, always safe to run, no side effects. This is the primary answer to "how does an operator know what state they're in," and is the cheapest possible piece of this surface to build correctly.
- **`dune secrets migrate <name>`** — migrates exactly one named secret (`server-login-password-secret` or `username-server-login-secret`) from its legacy flat file to the encrypted form, using the write-ordering discipline already specified in the parent design (§7.4: write `.enc` to temp, fsync, atomic rename, only then write the per-secret marker — this exact sequence is already implemented inside `dune_secrets_write_secret()` itself per the library's own code, so this command is a thin wrapper, not new crypto logic). Refuses to run if `dune_secrets_backend_configured` is false, with a clear message pointing at the missing env vars. **Does not delete the legacy flat file** — see §4 rollback.
- **`dune secrets cleanup-legacy <name>`** — deletes the legacy flat file for a named secret, but **only** if `dune secrets status` confirms that secret is currently migrated and a fresh `dune_secrets_read_secret` call for it succeeds (i.e., re-verifies decryption works *right before* deleting the only fallback, not relying on a stale earlier check). Refuses otherwise.

**Deliberately NOT built in Stage 2** (named explicitly, so this isn't mistaken for an oversight): `dune secrets setup` (full first-time wizard, age-keygen, KEK generation, break-glass), `dune secrets rotate` (KEK rotation), any `dune doctor`/`dune init` integration. An operator wiring these two secrets in this stage is expected to have already run `age-keygen`/generated a KEK manually (documented in the PR body's "Fresh Install"/"Migration" sections) or via a minimal setup step scoped narrowly to what these two commands need — this is intentionally the smallest CLI surface that makes the 6 required upstream scenarios (§5) independently verifiable, not the full eventual UX.

---

## 4. Rollback Path

Directly inherited from the parent design's own §7.3, restated concretely for this stage's exact 2 secrets: because `dune secrets migrate` never deletes the legacy flat file, rollback is trivial by construction. An operator who migrates a secret and then wants to go back:

1. Unset `DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` (or leave them set — doesn't matter, see next point).
2. Delete (or simply ignore) the `.enc` file for that secret.
3. The very next `resolve_server_login_password_secret()`/`resolve_username_server_login_secret()` call falls through to the unchanged legacy-flat-file branch, because `dune_secrets_backend_configured` is false (step 1) or the `.enc` file no longer exists (step 2) — no code path change needed, no manual file restoration needed, since the legacy file was never touched.

**No destructive step exists anywhere in this flow except `dune secrets cleanup-legacy`**, which is the one command an operator must explicitly, separately invoke, and which re-verifies decryption immediately before deleting anything.

---

## 5. Answering Upstream's 6 Named Requirements Directly

| Requirement | Answer |
|---|---|
| **Fresh installation** | Zero behavior change unless `DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` are both set. A fresh install that does nothing described in this stage gets exactly today's `ensure_secret_file`-generates-a-random-32-byte-secret behavior, verified by the unchanged final `else` branch in §2's new resolver code. |
| **Plaintext migration** | `dune secrets migrate <name>` (§3), built directly on `dune_secrets_write_secret()`'s already-audited write-ordering (temp → fsync → rename → marker). Legacy file read once, encrypted, never re-read as an input after that (the *resolver* still knows how to fall back to it, but the migrate command itself only writes, never mutates the legacy file). |
| **Missing or incorrect age identity** | `dune_secrets_load_kek` (already implemented and tested in the library itself) fails cleanly with a specific stderr message for both "binary missing" and "wrong identity/corrupted KEK" cases. This stage's new code (§2) additionally ensures that once a secret is migrated, a load failure is a **hard stop** (non-zero exit propagated all the way up through the resolver into the calling launcher script), not silently absorbed — an operator who breaks their KEK after migrating finds out immediately when the server fails to start, with a clear message, rather than the server silently generating a brand-new mismatched secret. |
| **Backup and restore** | Free, by existing construction: `dune db backup-system` (already shipped, PR #159) stages `runtime/secrets/` verbatim via `tar` (`db.sh:924-932`) — confirmed via direct code read, this already includes any `.enc` files this stage creates with zero changes to `db.sh` itself. Verification task for implementation: confirm this claim directly with a real backup/restore round-trip of a migrated secret (not just read the code and assume it holds), since this is exactly the kind of unverified-but-plausible claim Requirement 20 exists to catch. |
| **Recovery and rollback** | §4 above. Additionally: since the age identity itself is explicitly out of scope for this stage's CLI surface (§3), "recovery" for *this* stage means the rollback path in §4 (go back to plaintext), not a full break-glass identity-recovery procedure — that remains correctly scoped to the parent design's later, dedicated work (§6 of the unified design), not duplicated here. |
| **Preservation of existing installations when encryption is not configured** | Directly verified by the `dune_secrets_backend_configured` check being the very first branch in both modified resolvers (§2) — an installation that has never heard of this feature takes the exact same code path it does today, with no new required env var, no new required file, no new required binary on the critical path. |

---

## 6. Open Questions for the Layer 1 Audit

Stated explicitly rather than silently assumed, per this project's own established practice of naming gaps instead of hiding them:

1. **Is a bare `dune secrets migrate <name>` (positional arg, one secret at a time) the right UX, or should there be a `dune secrets migrate --all` for wiring both secrets in one command?** Leaning toward one-at-a-time for this stage specifically, since forcing an explicit per-secret action matches this stage's deliberately narrow, low-ceremony scope — but this is a real design choice, not a foregone conclusion, and the Architect/UI hats should weigh in.
2. **Where does the age identity/KEK come from for someone testing this stage**, given `dune secrets setup` is explicitly not built yet (§3)? Current plan: document (in the PR body, not new tooling) the exact manual `age-keygen`/KEK-generation steps an operator or reviewer needs to run by hand to exercise this stage — mirroring how PR #160 itself was tested before any CLI existed. The Security Architect and QA hats should confirm this is an acceptable testing/documentation-only bridge rather than a gap that needs its own mini-tool.
3. **Does `dune secrets status`'s output need to avoid ever printing the secret value itself, even redacted-looking?** Current design (§3) only ever prints migration state, never a value or even a partial value — confirmed as the intended design, but worth an explicit Security Architect sign-off given this is new, real credential-adjacent CLI surface.
4. **Should `runtime/scripts/dune`'s dispatch to a new `secrets.sh` follow the exact `db)  shift || true; runtime/scripts/db.sh "$@" ;;` pattern** (confirmed as the established convention at `runtime/scripts/dune:427-430`) or does this specific command warrant different argument handling given it's manipulating credentials? Leaning toward matching the existing convention exactly (consistency is itself a security property — reviewers already know how to read this pattern) unless a hat finds a concrete reason not to.
5. **`tests/security-pr-checks.sh` and CI wiring**: this stage's new `secrets.sh` (CLI wrapper, distinct from the library's own `lib/secrets.sh`) needs to be added to the existing shellcheck invocation list, matching PR #160's own precedent of adding its new files to that same list. Not a design question, but flagged here so it isn't dropped during implementation.

---

## 7. What This Document Deliberately Does Not Re-Litigate

Per this project's own established practice (see the parent design's §0 boundary statement), the following are treated as already-decided, upstream-accepted, or explicitly out of scope, and are not reopened here:
- The KEK/DEK envelope-encryption mechanism itself, the `enc:v2:` format, AAD binding, atomic-write discipline — all already implemented, audited (2 rounds), and upstream-reviewed in the library PR (#160/#286). This document only adds two call sites and a thin CLI wrapper on top.
- Postgres/Funcom/RMQ integration — explicitly excluded by upstream's own instruction, tracked as separate, later, unscheduled stages.
- Full `dune secrets setup`/break-glass/KEK-rotation UX — correctly deferred to a later stage per §3's explicit scoping, once more secrets exist to justify that operational surface.
