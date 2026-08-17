# Secrets Library Stage 2 — Wiring `server-login-password-secret` + `username-server-login-secret` — L1 Design

**Date:** 2026-08-17
**Status:** L1 design, revision 2. Layer 1 eight-hats audit against revision 1 is complete (8 hats dispatched as independent Task-tool workers: Software Architect, Security Architect, GRC, QA/Test, Network Engineer, Cloud Security Engineer, UI Design/Architect, DBA). Findings register is §8. Every CRITICAL/HIGH finding is resolved inline below, marked `[R2]` at its resolution point, matching this project's own established revision-marking convention (see the parent design's `[R2]`/`[R3]` markers).
**Tracking issue:** `dune-awakening-selfhost-docker#318`, `#320` (console-visibility deferral, filed per finding F-UI-1)
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

**`[R2]` — Corrects a HIGH finding (Security Architect, Finding 1): revision 1's "resolving the open question" code used `[ -e "$enc_path" ]` (existence only) as its migrated-or-not predicate, but `dune_secrets_read_secret` internally uses `[ -r "$enc_path" ]` (readable). If the `.enc` file exists but isn't readable by the current user (permission drift after a restore, a `chmod` bug, a root-owned file left by a container), the outer check commits to "migrated, must fail loud" while the inner function's `-r` check fails and silently returns the legacy plaintext with exit 0 — exactly the failure mode this design exists to prevent, just triggered by a permissions mismatch instead of corruption. Also corrects a HIGH finding (Finding 3): `.enc`-file existence was the *only* migration signal consulted; the library's own per-secret migration marker (`runtime/generated/.secrets-migrated/<name>.done`) was never checked, meaning a scenario where the `.enc` file is lost (disk corruption, a bad `rm`, a backup restore that captures `runtime/secrets/` but not `runtime/generated/`, or vice versa) after `cleanup-legacy` has already deleted the legacy fallback leaves *zero* surviving artifact — the resolver would silently mint a brand-new random secret via `ensure_secret_file`, with no diagnostic at all.**

**Resolved implementation** (belt-and-suspenders: either surviving artifact — `.enc` file OR marker — forces fail-loud behavior; readability, not mere existence, is the actual predicate):

```bash
resolve_server_login_password_secret() {
  local name="server-login-password-secret"
  local legacy_path="runtime/secrets/${name}.txt"

  if dune_secrets_backend_configured; then
    local enc_path marker_path migrated=0
    enc_path="$(dune_secrets_encrypted_path "$name" 2>/dev/null || true)"
    marker_path="$(dune_secrets_migration_marker_path "$name" 2>/dev/null || true)"
    # Readable, not merely existing -- matches the exact predicate
    # dune_secrets_read_secret itself uses internally. Using a looser
    # check here (e.g. -e) would let the two functions disagree about
    # what "migrated" means, silently defeating the fail-loud guarantee
    # below whenever the .enc file exists but isn't readable by the
    # current user (permission drift, a restore run as a different
    # UID than the one that migrated it, etc.).
    if [ -n "$enc_path" ] && [ -r "$enc_path" ]; then
      migrated=1
    # Belt-and-suspenders: the marker alone (readable) is also treated
    # as "this secret has migration history," so a lost/corrupted .enc
    # file still forces fail-loud instead of silently regenerating a
    # brand-new secret once cleanup-legacy has already removed the one
    # remaining fallback. See finding 3 in [R2] above.
    elif [ -n "$marker_path" ] && [ -r "$marker_path" ]; then
      migrated=1
    fi

    if [ "$migrated" = "1" ]; then
      # Migrated (by either signal). Must succeed or fail loudly --
      # never fall through to generating a new legacy secret.
      dune_secrets_read_secret "$name" "$legacy_path"
      return $?
    fi
    # Backend configured but this specific secret was never migrated
    # yet (neither signal present) -- fall through to legacy behavior
    # below, exactly as today.
  fi

  ensure_secret_file "$legacy_path" 32
  tr -d '\r\n' < "$legacy_path"
}
```

Same pattern, mirrored exactly, for `resolve_username_server_login_secret()` (substitute `name="username-server-login-secret"`).

**`ensure_secret_file`'s role is unchanged** — it remains the generator for a *new* legacy secret when neither the encrypted nor legacy form exists yet (fresh install, backend not configured). It is never called once either migration signal (`.enc` file or marker) is present and readable for that secret.

**`[R2]` — resolves a LOW finding (Security Architect, Finding 1b): a TOCTOU window exists between this check and the subsequent read** (e.g. the documented §4 manual rollback `rm` of the `.enc` file, run concurrently in a second terminal, between the `-r` check and the `dune_secrets_read_secret` call). This requires local filesystem write access to `runtime/secrets/` (not a remote attack surface) and is the *documented* rollback mechanism executed at an unlucky moment. **Accepted as a residual risk, not fixed**: the worst outcome is falling through to legacy behavior one call earlier than intended during an already-in-progress manual rollback, which is the rollback's own intended end state anyway — this is not a new failure mode, just a slightly-early transition to one. No code change required.

**`[R2]` — resolves a MEDIUM finding (Software Architect, Finding 3): both `name` values above are hardcoded string literals, never derived from configuration or user input.** This matters because `_dune_secrets_validate_name()` (library-internal) is a generic filesystem-safety allow-list, not a Stage-2-specific one — the library's own comments warn that this exact function becomes a real path-traversal/RCE-adjacent concern the moment a caller derives `name` from anything less than a compile-time literal. Both call sites in this design pass a hardcoded string; this pattern must not be copied to a future caller that derives `name` dynamically without carrying this reasoning forward explicitly.

---

## 3. New CLI Surface: `dune secrets`

No `dune secrets` subcommand exists today (confirmed via grep — zero matches for `dune secrets` or `dune-secrets` anywhere in `runtime/scripts/`). The parent design (`unified-age-secrets-management-l1-design-2026-08-13.md` §7.2) specifies `dune secrets setup`/`verify`/`cleanup-legacy`/`rotate`. Stage 2 needs a real, working minimum subset of this — not the full command surface, since most of it (KEK rotation, `age` binary provisioning via `dune doctor`, break-glass QR/Shamir setup) is out of scope for "wire two low-blast-radius secrets" and belongs to a later stage once more secrets justify the operational surface.

**`[R2]` — File naming corrected (Software Architect, Finding 5): revision 1 proposed `runtime/scripts/secrets.sh` as the new CLI wrapper's filename, which collides in basename with the existing library at `runtime/scripts/lib/secrets.sh` — the first-ever use of this project's `lib/` sourcing pattern from a top-level script, combined with near-identical names, makes grep-based reasoning and the `tests/security-pr-checks.sh` shellcheck file list error-prone (both files must be added by full path; easy to add one and believe both are covered).** Resolved: the new CLI wrapper is named `runtime/scripts/secrets-cli.sh`, matching this repo's own existing `db.sh`/`db-manager.sh` precedent for "two related-but-distinct scripts in the same functional area get distinguishable names."

**`[R2]` — Scope restriction added (Security Architect, Finding 2, CRITICAL): revision 1 never stated that the new CLI commands must reject any secret name outside this stage's own 2-secret allow-list.** The library's generic `_dune_secrets_validate_name()` accepts *any* filesystem-safe name, not just these two — meaning, as originally scoped, `dune secrets migrate rmq-command-auth-token` or `dune secrets migrate postgres-password` would have silently succeeded, encrypting that secret's current value into an orphaned `.enc` file no resolver reads, which could then silently go stale the moment that secret is later rotated through its still-authoritative legacy path. This directly conflicts with upstream's own explicit instruction to keep "PostgreSQL, Funcom, and RMQ... out of this first integration" — a CLI that can silently touch them (even if unread) is a real scope violation, not just a hypothetical one. **Resolved: every mutating command below validates `<name>` against a literal, hardcoded 2-item allow-list specific to this stage** (`server-login-password-secret`, `username-server-login-secret`), refusing any other name — including otherwise-valid ones — with an explicit "not in scope for this stage" error, in addition to (not instead of) the library's own generic path-safety check.

**Minimum viable subset for Stage 2, added as `runtime/scripts/secrets-cli.sh` + a `secrets)` case in `runtime/scripts/dune`** (matching the existing `shift || true; runtime/scripts/<name>.sh "$@"` dispatch convention exactly, per resolved Open Question 4 below):

- **`dune secrets status [<name>]`** — for each of the 2 wired secrets (or just the named one): reports `not migrated (legacy plaintext)` / `migrated (encrypted)` / `backend not configured`, plus **`[R2]` (UI Design/Architect, Finding F-UI-3) a one-line "Next:" recommendation per state** (`Next: run 'dune secrets migrate <name>'` / `Next: set DUNE_KEK_FILE and DUNE_AGE_IDENTITY_FILE -- see docs/security/secrets-management.md`). Read-only, always safe to run, no side effects.
- **`dune secrets verify [<name>]`** — **`[R2]` new command, resolves a MEDIUM finding (Security Architect, Finding 4): revision 1 folded verification directly into `cleanup-legacy`'s internal preflight, meaning the only way to check "is my migrated secret's KEK/identity still working" was to run the one command that, on success, immediately deletes the safety net.** Performs a real decrypt (via `dune_secrets_read_secret`) without any destructive follow-up, exactly matching the parent design's own §7.3 requirement that `cleanup-legacy` "should refuse to run unless `dune secrets verify` has passed within the same session." Exit 0 and a clear message on success; exit 1 and the library's own diagnostic on failure. This is the exact same check `cleanup-legacy` already needs internally — exposing it standalone costs nothing beyond removing the destructive step, and directly closes the gap.
- **`dune secrets migrate <name> [--dry-run]`** — migrates exactly one named secret from its legacy flat file to the encrypted form, using the write-ordering discipline already specified in the parent design (§7.4: write `.enc` to temp, fsync, atomic rename, only then write the per-secret marker — already implemented inside `dune_secrets_write_secret()`, so this command is a thin wrapper, not new crypto logic). Refuses to run if `dune_secrets_backend_configured` is false, or if `<name>` is outside the 2-item allow-list above. **Does not delete the legacy flat file** — see §4 rollback. **`[R2]` adds `--dry-run` (Software Architect, Finding 4): every other credential/data-mutating command in this same CLI (`dune db transfer`, `dune admin kick`, `dune admin repair-login-queue`) already supports `--dry-run`/`--yes` — this design's own two new mutating commands should not be the first exception.** `--dry-run` prints what would happen (`would write <enc_path>`, `would write marker at <marker_path>`, `would NOT touch <legacy_path>`) without touching the filesystem. **`[R2]` resolves a MEDIUM finding (QA/Test, Finding Q3): re-running `migrate` on an already-migrated secret is explicitly idempotent-in-effect, not merely idempotent-in-exit-code** — it always re-reads the *original plaintext legacy file* (never the existing ciphertext) and re-encrypts from that source, so a second run produces a new DEK/ciphertext for the same plaintext (different bytes, same recovered value) rather than double-wrapping already-encrypted data. This is a stated design decision, not an accidental emergent behavior.
- **`dune secrets cleanup-legacy <name>`** — deletes the legacy flat file for a named secret, but **only** after re-running the same real-decrypt check `verify` performs, immediately before deleting (not relying on a stale earlier check, and not merely checking existence — see the `-r`, not `-e`, predicate in §2's `[R2]` resolution, applied identically here). Refuses otherwise, with a distinct message if the failure is "not migrated yet" vs. "migrated but currently unreadable/broken."

**Deliberately NOT built in Stage 2** (named explicitly, so this isn't mistaken for an oversight): `dune secrets setup` (full first-time wizard, age-keygen, KEK generation, break-glass), `dune secrets rotate` (KEK rotation), any `dune doctor`/`dune init` integration. An operator wiring these two secrets in this stage is expected to have already run `age-keygen`/generated a KEK manually — see §6 Open Question 2's resolution below for how this is tested without manual steps despite no setup wizard existing yet.

**`[R2]` — explicit argv/process-exposure constraint added (Security Architect, Finding 7): the plaintext value read from the legacy file during `migrate` MUST be passed to `dune_secrets_write_secret()` as a plain bash function argument in the same process; it must never be interpolated into a `python3 -c`/`eval`/subprocess command string or appear in any `-e`/positional argv anywhere in `secrets-cli.sh`'s own code.** This matches the project's own GHSA-fc89-h24v-6j3x precedent (the exact reason these two secrets' argv exposure was fixed in #252) and the library's own already-verified stdin-only protocol for `secrets_aead.py`. Stated here as an explicit Definition-of-Done constraint for the Layer 2 audit to check against, not left as an inference from "it's a thin wrapper."

---

## 4. Rollback Path

Directly inherited from the parent design's own §7.3, restated concretely for this stage's exact 2 secrets: because `dune secrets migrate` never deletes the legacy flat file, rollback is trivial by construction. An operator who migrates a secret and then wants to go back:

1. Unset `DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` (or leave them set — doesn't matter, see next point).
2. Delete (or simply ignore) the `.enc` file for that secret.
3. The very next `resolve_server_login_password_secret()`/`resolve_username_server_login_secret()` call falls through to the unchanged legacy-flat-file branch, because `dune_secrets_backend_configured` is false (step 1) or the `.enc` file no longer exists (step 2) — no code path change needed, no manual file restoration needed, since the legacy file was never touched.

**No destructive step exists anywhere in this flow except `dune secrets cleanup-legacy`**, which is the one command an operator must explicitly, separately invoke, and which re-verifies decryption immediately before deleting anything (the same check now also independently available, non-destructively, via `dune secrets verify` — see §3's `[R2]` resolution).

---

## 5. Answering Upstream's 6 Named Requirements Directly

**`[R2]` — risk classification added (GRC, Finding G4): Medium.** Blast radius limited to the game server's own login-credential handshake for exactly 2 secrets, consumed by 4 launcher scripts (verified: neither `start-postgres.sh` nor `start-rabbitmq.sh` reference either secret — §1). A bug can, at worst, prevent the game server process from starting or cause it to start with a wrong/stale credential — it cannot affect Postgres availability, the Funcom API relationship, or RabbitMQ/matchmaking. Rated Medium rather than Low specifically because a fail-open bug in the "migrated but broken → hard stop" logic (§2) could take down 100% of a server's ability to start (a real availability impact) — not Low, because "can't start the game server" is a real outage from the operator's perspective, and not High, because it cannot cascade into database, matchmaking, or credential-relationship damage.

| Requirement | Answer | Grade |
|---|---|---|
| **Fresh installation** | Zero behavior change unless `DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` are both set. A fresh install that does nothing described in this stage gets exactly today's `ensure_secret_file`-generates-a-random-32-byte-secret behavior, verified by the unchanged final `else` branch in §2's new resolver code. | ADEQUATE |
| **Plaintext migration** | `dune secrets migrate <name>` (§3), built directly on `dune_secrets_write_secret()`'s already-audited write-ordering (temp → fsync → rename → marker). Legacy file read once, encrypted, never re-read as an input after that (the *resolver* still knows how to fall back to it, but the migrate command itself only writes, never mutates the legacy file). | ADEQUATE |
| **Missing or incorrect age identity** | `dune_secrets_load_kek` (already implemented and tested in the library itself) fails cleanly with a specific stderr message for both "binary missing" and "wrong identity/corrupted KEK" cases. This stage's new code (§2) additionally ensures that once a secret is migrated (by either signal, per `[R2]`), a load failure is a **hard stop** (non-zero exit propagated all the way up through the resolver into the calling launcher script), not silently absorbed. | ADEQUATE |
| **Backup and restore** | Mechanically correct claim, independently verified: `dune db backup-system` (already shipped, PR #159) stages `runtime/secrets/` verbatim via `tar` (`db.sh:924-932`), confirmed to include any `.enc` files with zero changes needed. **`[R2]` (GRC Finding G1, Security Architect Finding 5): this claim is downgraded from "confirmed" to a required, tracked test** — no existing test (`tests/db-system-backup-test.sh`) currently stages a `.enc` file, only plain `.txt` secrets, so the round-trip is unverified by any automated test today. §9 below adds this as a required Layer 2 deliverable, and extends coverage to `runtime/generated/.secrets-migrated/` (the marker directory), not just `.enc` files, per the belt-and-suspenders fix in §2. | **NEEDS MORE EVIDENCE — tracked in §9, not deferred silently** |
| **Recovery and rollback** | §4 above, now including the standalone `dune secrets verify` command (§3 `[R2]`). Since the age identity itself is explicitly out of scope for this stage's CLI surface, "recovery" for *this* stage means the rollback path in §4 (go back to plaintext), not a full break-glass identity-recovery procedure — correctly deferred to the parent design's later, dedicated work. | ADEQUATE |
| **Preservation of existing installations when encryption is not configured** | Directly verified by the `dune_secrets_backend_configured` check being the very first branch in both modified resolvers (§2) — an installation that has never heard of this feature takes the exact same code path it does today, with no new required env var, no new required file, no new required binary on the critical path. | ADEQUATE |

---

## 6. Open Questions — Resolved by the Layer 1 Audit

Each question from revision 1, now with the audit's actual answer rather than a leaning:

1. **One-at-a-time `migrate <name>`, no `--all`.** Confirmed correct by both Architect and Security Architect hats — a fixed 2-item scope doesn't need batch tooling, and per §3's `[R2]` CRITICAL fix, `--all` would need the same hardcoded allow-list validation as everything else, adding complexity for zero real benefit at this scale.
2. **`[R2]` — resolved differently than revision 1 proposed (QA/Test, Finding Q1, HIGH): a manual/documentation-only testing bridge was found insufficient.** The precedent revision 1 cited (`test-secrets-lib.sh`) is actually **fully self-contained** — it generates its own throwaway `age-keygen` identity and KEK inside a `mktemp -d` sandbox, no manual step at all. CI already has everything needed (`age`+`age-keygen` ship together via `apt-get install age`; `cryptography`/`pytest` already installed) to do the same for Stage 2's new code at zero additional CI cost. **Resolved: `runtime/tests/test-secrets-stage2.sh` follows the exact same self-contained pattern** — manual testing is reserved only for the one thing that's genuinely hard to automate (a live-instance verification against `dune-dev`, §9), not for CLI/resolver unit-level behavior.
3. **Confirmed by Security Architect: `dune secrets status`/`verify` never print a secret value, even redacted, and there is no timing side-channel** between "wrong KEK" and "not migrated" (neither code path invokes `age`/AEAD decryption from `status`, only from `verify`/`migrate`/the resolvers themselves, all of which already only emit diagnostic *messages*, never values — inherited unchanged from the already-twice-audited library).
4. **Confirmed: `secrets)` dispatch matches the existing `shift || true; runtime/scripts/<name>.sh "$@"` pattern exactly** (Architect hat: consistency here is boilerplate dispatch, not the credential-handling logic itself, and matching it is correct). Resolved separately (see §3 `[R2]`, Finding 5): the wrapper's own filename is `secrets-cli.sh`, not `secrets.sh`, to avoid the basename collision with the library.
5. **Confirmed as a required implementation step, not just a flag**: `secrets-cli.sh` must be added to `tests/security-pr-checks.sh`'s shellcheck invocation list. Tracked explicitly in §9's Definition of Done below so it can't be silently dropped.

---

## 7. What This Document Deliberately Does Not Re-Litigate

Per this project's own established practice (see the parent design's §0 boundary statement), the following are treated as already-decided, upstream-accepted, or explicitly out of scope, and are not reopened here:
- The KEK/DEK envelope-encryption mechanism itself, the `enc:v2:` format, AAD binding, atomic-write discipline — all already implemented, audited (2 rounds), and upstream-reviewed in the library PR (#160/#286). This document only adds two call sites and a CLI wrapper on top.
- Postgres/Funcom/RMQ integration — explicitly excluded by upstream's own instruction, tracked as separate, later, unscheduled stages.
- Full `dune secrets setup`/break-glass/KEK-rotation UX — correctly deferred to a later stage per §3's explicit scoping, once more secrets exist to justify that operational surface.
- Web-console visibility — explicitly deferred, tracked as issue #320 (mirrors #276's identical deferral for `dune db backup-system`), per the UI Design/Architect hat's Finding F-UI-1. CLI-only is accepted for this stage because the operator audience for Stage 2 specifically has already had to hand-run `age-keygen` (§6 Q2) — not because this repo's users are assumed to be CLI-native in general (its own README explicitly says the opposite: "you do not need to be a Linux expert").

---

## 8. Layer 1 Eight-Hats Audit — Findings Register

Dispatched 2026-08-17 as 8 independent Task-tool workers against revision 1 of this document (5 dispatches covering all 8 hats, some combined). Every CRITICAL/HIGH finding is resolved inline above, marked `[R2]`. This section is the evidence artifact Requirement 20 requires.

| # | Hat | Severity | Finding | Resolution |
|---|---|---|---|---|
| 1 | Software Architect | CRITICAL | Revision 1 was scoped against a stale/orphaned branch (`feat/281-secrets-library`); the real upstream PR #160 head had independently diverged. | **Resolved outside this document**: both branches rebased onto current `main` (twice — once for the #316 merge, again for #314), verified byte-identical library content, confirmed via `git diff` before continuing design work. |
| 2 | Security Architect | HIGH | `-e` vs `-r` predicate mismatch between the resolver's pre-check and the library's internal check silently defeats fail-closed on a permissions-drift scenario. | Resolved in §2 — both checks now use `-r`. |
| 3 | Security Architect | HIGH | CLI commands had no allow-list restricting them to this stage's 2 secrets — could silently touch Postgres/Funcom/RMQ secrets, violating upstream's explicit instruction. | Resolved in §3 — hardcoded 2-item allow-list on every mutating command. |
| 4 | Security Architect | HIGH | `.enc`-file existence was the only migration signal; losing both the `.enc` file and the legacy file (post-cleanup) leaves no artifact forcing fail-loud behavior. | Resolved in §2 — marker file consulted as a second, independent signal. |
| 5 | Security Architect | MEDIUM | No standalone, non-destructive way to verify a migrated secret still decrypts before running the one destructive command (`cleanup-legacy`). | Resolved in §3 — new standalone `dune secrets verify` command. |
| 6 | Software Architect | MEDIUM | `dune secrets migrate`/`cleanup-legacy` omitted `--dry-run`, inconsistent with every other destructive command in this CLI. | Resolved in §3 — `--dry-run` added to `migrate`. |
| 7 | Software Architect | MEDIUM | New CLI wrapper's proposed filename (`secrets.sh`) collides in basename with the existing library (`lib/secrets.sh`). | Resolved in §3 — renamed to `secrets-cli.sh`. |
| 8 | QA/Test | HIGH | Revision 1's manual/documentation-only testing bridge (§6 Q2) was unnecessary — a fully self-contained, CI-automatable equivalent to the library's own test pattern was available at zero extra cost. | Resolved in §6 — `test-secrets-stage2.sh` follows the self-contained pattern; §9 makes this a Definition-of-Done item. |
| 9 | QA/Test | MEDIUM | `dune secrets migrate` run twice had no stated idempotency decision. | Resolved in §3 — explicit design decision (re-encrypts from source plaintext, not double-wraps). |
| 10 | GRC | HIGH | The findings-register precedent this design leans on lives only on an unmerged branch — not yet durable evidence. | **Accepted as a named dependency risk, not fixed by this document**: stated explicitly that Stage 2's own audit evidence shares this same non-durability until PR #160/#286 actually merges to `main`. Tracked via issue #318, not silently assumed. |
| 11 | GRC | MEDIUM | Backup/restore requirement (§5) was graded "confirmed" from a code read alone, with no actual test covering `.enc` files. | Resolved in §5 — downgraded to NEEDS MORE EVIDENCE, made a required Layer 2 deliverable in §9. |
| 12 | GRC | MEDIUM | No explicit risk classification (Critical/High/Medium/Low + blast-radius statement) stated, per this account's own PR-body convention. | Resolved in §5 — Medium, with blast-radius statement. |
| 13 | UI Design/Architect | MEDIUM | Console-visibility gap was real but unacknowledged, unlike its own precedent (#276). | Resolved — filed issue #320, referenced in §7. |
| 14 | UI Design/Architect | LOW | `dune secrets status` gave state but no "recommended next step." | Resolved in §3 — added "Next:" line per state. |
| 15 | DBA | LOW/informational | None blocking — confirmed zero Postgres/SQL surface; filesystem write-ordering independently verified to meet or exceed schema-migration-grade atomicity. | No fix needed; noted as a confirmed strength. |
| — | Network Engineer | — (confirmed clean) | Zero new network calls/ports/DNS; `age`/AEAD path is purely local. | No finding. |
| — | Cloud Security Engineer | — (confirmed clean, 1 doc gap) | No cloud-provider surface at all (explicit non-finding). One LOW doc-completeness gap: design didn't cross-reference that at-rest encryption doesn't close the separate `docker inspect`/#121 in-memory exposure path. | Noted here explicitly: **Stage 2's scope is at-rest-only.** It does not and cannot close the `docker inspect --format '{{.Config.Env}}'` exposure path for a running container's environment — that is issue #121's architectural scope (Docker socket + host networking), entirely separate from this design. An operator with Docker-socket access can still read either secret's decrypted value for the lifetime of the container, regardless of this stage shipping. |

**Not run as a full independent dispatch a second time for this revision** — all CRITICAL/HIGH findings are resolved with concrete code/design changes above, not just reasoned about; a Layer 2 (implementation) audit against the actual merged code is still required per Requirement 20 before this is presented upstream (tracked in §9).

---

## 9. Layer 2 Implementation — Required Deliverables (Definition of Done)

Concrete, per the QA/Test hat's own prescriptive findings (Finding Q2) and the GRC hat's escalation of "needs more evidence" items (§5) into tracked work rather than prose:

| # | Requirement | Test | File | Assertion |
|---|---|---|---|---|
| 1 | Fresh installation | Unit | `runtime/tests/test-secrets-stage2.sh` | With `DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` unset, both resolvers produce identical behavior to the pre-change code (same generated-secret shape, same path, `ensure_secret_file` invoked). Also asserts the resolver never calls `command -v age` when the backend isn't configured (proves "no new binary on the critical path," not just "same output"). |
| 2 | Plaintext migration | Integration | Same file | Seed a legacy `.txt` secret with a known value → `dune secrets migrate server-login-password-secret` → assert `.enc` file exists, legacy file byte-for-byte unchanged, and the resolver now returns the original value via the encrypted path (verified via a PATH-shadowed `age` call counter, mirroring `test-secrets-lib.sh`'s own existing pattern). |
| 3 | Missing/incorrect age identity | Unit | Same file | Migrate a secret, swap `DUNE_AGE_IDENTITY_FILE` to a different identity → resolver call returns non-zero **and** a calling launcher-script-level wrapper also propagates that non-zero exit (the specific new claim Stage 2 adds beyond the library's own already-covered fail-closed behavior). |
| 4 | Backup and restore | Integration | Extend `tests/db-system-backup-test.sh`'s existing happy-path case (do not create a new file) | Add a `.enc` file AND a marker file (not just `.txt` secrets) to the seeded fixture before running `backup_db`; assert both are byte-identical after extraction. Closes the NEEDS-MORE-EVIDENCE grade in §5. |
| 5 | Recovery and rollback | Integration | `runtime/tests/test-secrets-stage2.sh` | Migrate a secret → delete the `.enc` file (or unset `DUNE_KEK_FILE`) → resolver call returns the **original legacy value unchanged**, not a newly-generated one. |
| 6 | Preservation when not configured | Unit | Same as #1 | Covered by #1's assertion set. |
| 7 | `cleanup-legacy` adversarial case | Integration | Same file | Migrate a secret, corrupt the `.enc` file's ciphertext bytes directly (bit rot / bad restore simulation) without touching the marker → `dune secrets cleanup-legacy` must **refuse**, and the legacy `.txt` file must still exist afterward. This is the one command in this design capable of permanent data loss and needs a direct adversarial test. |
| 8 | Migrate re-run idempotency | Unit | Same file | Run `dune secrets migrate server-login-password-secret` twice in a row; assert the resolver still returns correct plaintext after the second run (per §3's stated design decision — re-encrypt-from-source, not double-wrap). |
| 9 | CLI wrapper failure propagation | Unit | Same file | Stub `dune_secrets_write_secret` to return 1; assert `dune secrets migrate` propagates non-zero and does not print a success message. |
| 10 | Shellcheck coverage | N/A | `tests/security-pr-checks.sh` | Add `runtime/scripts/secrets-cli.sh` to the existing shellcheck invocation list. |
| 11 | CI wiring | N/A | `.github/workflows/ci.yml` | Add `test-secrets-stage2.sh` to the same `runtime-script-unit` job step that already runs `test-secrets-lib.sh`/`test-secrets-aead-cross-language.sh` — no new CI dependencies needed (age/cryptography/pytest already installed for the library's own tests). |
| 12 | Live verification | Manual, one-time | N/A (operational, not a repo test) | Exercise the full migrate → restart → verify → cleanup-legacy flow against `dune-dev` (non-disruptive, non-production), per issue #318's own process requirement. |

All CRITICAL/HIGH findings from §8 are resolved in this document's design (§2-§6). Items 1-11 above are code/test deliverables for implementation; item 12 is the live-verification step. A Layer 2 (implementation) audit against the actual merged code — not just this design — is still required before presenting to upstream, per Requirement 20.
