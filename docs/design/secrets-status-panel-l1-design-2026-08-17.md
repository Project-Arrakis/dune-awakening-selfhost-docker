# Secrets Status Panel (Web Console) — L1 Design

**Date:** 2026-08-17
**Status:** L1 design, revision 2. Layer 1 eight-hats audit against revision 1 is complete (8 hats dispatched as 3 independent Task-tool worker groups: Software Architect + Security Architect; GRC + QA/Test + UI Design/Architect; Network Engineer + Cloud Security Engineer + DBA). Findings register is §7. One CRITICAL finding (independently confirmed by all 3 dispatches) required a real architecture change, resolved below and marked `[R2]`.
**Tracking issue:** `dune-awakening-selfhost-docker#320`
**Parent:** Stage 2 of the age-based secrets library rollout (issue #318, merged upstream PR #160/fork PR #286). This document implements the deferred web-console visibility gap that Stage 2's own Layer 1 audit flagged (UI Design/Architect hat, Finding F-UI-1) and issue #320 tracks explicitly.

---

## 1. Scope

**In scope — read-only status display, exactly matching `dune secrets status`'s output for the same 2 secrets Stage 2 already wires:**
- `server-login-password-secret`
- `username-server-login-secret`

Four possible states per secret, identical wording to the CLI: `backend not configured` / `not migrated (legacy plaintext)` / `migrated (encrypted)` / `migrated but currently unreadable/broken`.

**Explicitly out of scope — per issue #320's own body and this project's established precedent (#276, the identical deferral for `dune db backup-system`):**
- **No secret value is ever exposed**, redacted or otherwise.
- **No `migrate` or `cleanup-legacy` action is exposed through the browser.** Both remain deliberately CLI-only — matching the operator-driven `age-keygen`/KEK setup this whole feature already assumes, and matching #276's own explicit instruction ("Do NOT expose any decrypt/restore action through the web console").
- `verify` (real decrypt-and-check) is **also excluded from this first pass** — see §6 Open Question 1 for why, and the explicit recommendation to defer it.

**Why exactly this scope:** issue #320's body already specifies "a read-only status panel... No secret value ever exposed. No migrate/cleanup action exposed through the browser" — this document implements that spec, not a broader one. The parent design doc's own Phase-2-vision sketch (`docs/security/secrets-management.md`, a much larger "Secrets Vault" CRUD/reveal/rotate UI) is explicitly **not** what's being built here — that remains aspirational, undesigned-in-detail future work, not conflated with this narrow, already-scoped panel.

---

## 2. Architecture Decision: No Process Spawn for `status`

**Decision:** the `status` display is reimplemented natively in the Node API layer as pure filesystem-metadata checks (`fs.existsSync`/readable checks on 4 fixed paths), **not** by shelling out to `dune secrets status` via `runDune`/`buildDuneArgs` (the pattern `BackupsPanel` uses for `db list`/`db auto status`).

**Why this deviates from the established `runDune` pattern for CLI-wrapping panels**, stated explicitly rather than silently done differently:

The `_dune_secrets_stage2_state()` function in `secrets-cli.sh` that produces this exact 4-state result is a display-layer concern, not a safety-critical one — it only checks file existence/readability (`[ -r ... ]`/`[ -e ... ]`), never decrypts anything. This is different from `dune_secrets_read_secret()`'s fail-closed logic, which the Stage 2 design explicitly requires to have exactly one source of truth (the bash library) after a real CRITICAL bug (Stage 2 Layer 2 audit, **Finding 1** — corrected citation from revision 1, which mis-attributed this to Finding 5; Finding 5 documents the accepted *remaining* duplication after Finding 1's fix, not the CRITICAL bug itself) was found from having two independent copies of that *specific* logic drift out of sync.

Reimplementing the **4-state existence/readability check only** (not the decrypt logic) in two languages is therefore an accepted, already-blessed exception, not a new risk in principle — but see `[R2]` below: this reasoning does not, by itself, guarantee the two implementations stay in sync in practice, and revision 1 under-specified how that's enforced.

**Concrete benefit of this approach over shelling out:** zero process spawn per status check, no new `runner.js` `buildDuneArgs` entry, no risk of a new argv-construction bug. Also — discovered during this revision, not stated in revision 1 — shelling out via `runDune` would **not actually have avoided the container-environment problem below**, since `runDune` spawns `dune` with `cwd: config.repoRoot`, which is `/repo` **inside the same console container** (`console/api/src/runner.js:372`, `docker-compose.web.yml`'s `DUNE_DOCKER_DIR: /repo`) — not on the host. Both approaches run inside the same container and are equally affected by `[R2]`'s finding; this is not a reason to prefer one approach over the other, but it closes off "just shell out instead" as an easy escape hatch from the real fix below.

**Explicit non-goal:** this decision does NOT apply to `verify` (deferred, §6) or any future write action — those, if ever built, MUST shell out through `dune secrets verify`/`migrate`/`cleanup-legacy` via `runDune`, never reimplement AEAD decrypt/write logic in Node, per the Stage 2 design's own explicit constraint.

---

### `[R2]` CRITICAL fix: the console container cannot see the age identity/KEK at all as designed in revision 1

**Independently confirmed by all 3 Layer 1 audit dispatches** (Software Architect+Security Architect; GRC+QA+UI; Network Engineer+Cloud Security+DBA) — this is the single most important finding from this audit round.

**The problem, in two parts:**

1. **Environment variables don't propagate.** The real, production console (`docker-compose.web.yml`, service `redblink-dune-docker-console`) explicitly allowlists ~35 named environment variables from the host `.env` into the container (lines 23-72 of that file). `DUNE_KEK_FILE` and `DUNE_AGE_IDENTITY_FILE` are **not** in that list — confirmed directly, zero matches. `secretState()`'s very first check (`process.env.DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE`) would therefore always read `undefined` inside the container, regardless of what an operator has genuinely configured on the host or exported for CLI use.

2. **Even with the env vars passed through, the file itself is unreachable.** The parent cross-repo design (`unified-age-secrets-management-l1-design-2026-08-13.md` §5.1) deliberately places the age identity at `~/.config/dune/age-identity.txt` — **outside** the repo, specifically so it survives a `git clean`/re-clone/`dune update`. The console container only bind-mounts `${DUNE_HOST_REPO_ROOT}:/repo` (`docker-compose.web.yml`, `volumes:` section) — it has no visibility into `~/.config/dune/` at all. Passing the env var alone would make the container look for a file path that doesn't exist inside its own filesystem namespace.

**Net effect if unfixed:** the panel would report "Backend not configured" permanently for every real operator, including ones who have genuinely completed the CLI migration flow — not an edge case, the modal path for the feature's actual intended audience.

**Resolved implementation** (`[R2]` revised again after live-testing on `dune-dev`, 2026-08-17, exposed a second bug in the first draft of this fix — see the note below):

1. Add both variables to `docker-compose.web.yml`'s `environment:` block, matching the existing allowlist convention exactly:
   ```yaml
   DUNE_KEK_FILE: "${DUNE_KEK_FILE:-}"
   DUNE_AGE_IDENTITY_FILE: "${DUNE_AGE_IDENTITY_FILE:-}"
   ```
2. Add a new **read-only, explicitly-opt-in** volume mount for the identity directory, since the identity file lives outside `/repo`:
   ```yaml
   volumes:
     - "${DUNE_HOST_REPO_ROOT:-.}:/repo"
     - "${DUNE_AGE_IDENTITY_DIR:-.}:/dune-age-identity:ro"
   ```
   **A new, explicit `DUNE_AGE_IDENTITY_DIR` variable, not `$HOME`**: this container already overrides its own `HOME` to `/tmp/dune-console-home` (numeric host UIDs don't always have a passwd entry in the image, per the existing comment on that override), and an operator's real host `$HOME` is not reliably the same value across every invocation context (systemd, sudo, cron) that might start this compose stack — an explicit variable avoids that ambiguity entirely rather than trying to derive it.

   **The `:-.` fallback (not a placeholder nonexistent path) was chosen only after a real bug in an earlier draft of this fix was caught by live-testing, not just reasoning about it**: an initial version of this fix defaulted to a made-up nonexistent path when `DUNE_AGE_IDENTITY_DIR` was unset, on the theory that a nonexistent bind-mount source would be a harmless no-op for operators who haven't configured age-based secrets. **This was tested directly against real Docker Compose on `dune-dev` and found to be wrong**: Compose silently *creates* a nonexistent bind-mount source directory on the host filesystem rather than skipping the mount (confirmed: a throwaway `docker compose up` with `${VAR:-/nonexistent-test-path}:/mounted:ro` and `VAR` unset produced a real, empty `/nonexistent-test-path` directory at the host filesystem root after the container started). A second attempt (leaving the variable entirely unset, no fallback at all) was also tested and found to **break container startup entirely** (`invalid spec: :/mounted:ro: empty section between colons`) — not a graceful no-op, a hard failure of the whole console. The `.` fallback (the compose file's own directory, i.e. the repo root, already guaranteed to exist) was tested and confirmed to produce neither failure mode: with the variable unset, the container starts normally with a harmless, redundant read-only mount of already-mounted repo content at an unused path (`/dune-age-identity`); with the variable set to a real directory, the real identity file is correctly visible and readable inside the container at that same path. Both cases verified via real `docker compose up`/`down` cycles against disposable test services, not simulated.

   Mounted read-only because the console process only ever needs to check readability/existence for this panel — it must never write to or delete the identity file. (If a future `verify` panel action is added per §6 Open Question 1, the same read-only mount is sufficient — `age --decrypt` only reads the identity file, never writes it.)
3. Add `DUNE_AGE_IDENTITY_DIR` (and the existing `DUNE_KEK_FILE`) to `.env.example` with a comment explaining they're optional and only meaningful once an operator has run the Stage 2 CLI migration (`dune secrets migrate`) at least once, and that `DUNE_AGE_IDENTITY_DIR` should point at the **directory containing** the identity file (typically `~/.config/dune`), not the file itself.

**Why read-only, and why this doesn't expand this design's own stated blast radius:** the container already runs with `network_mode: host` and a Docker-socket mount (per issue #121's existing, tracked architectural concern) — a read-only bind mount of one additional, operator-opted-in config directory does not meaningfully change that container's already-broad trust boundary, and the mounted file is a wrapped/encrypted identity key, not a plaintext secret value itself (the age identity's *own* protection is the operator's host-account file permissions, unchanged by this mount). This fix is scoped exactly to what's needed for `secretState()`'s existence/readability check — no decrypt operation happens through this mount in this revision (§1's scope explicitly excludes `verify`).

**This fix must land in the same PR as the panel itself** — a panel that reports the container's own broken visibility as "backend not configured" with no path to becoming otherwise would be actively misleading, worse than not building the panel at all.

---

## 3. Implementation

### 3.1 New service: `console/api/src/services/secretsStatus.js`

```js
import { existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";

const WIRED_SECRETS = ["server-login-password-secret", "username-server-login-secret"];

function isReadable(path) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// Mirrors secrets-cli.sh's _dune_secrets_stage2_state() exactly -- same
// 4 states, same precedence order. This is a DISPLAY-ONLY reimplementation
// of a filesystem-existence/readability check (see docs/design/
// secrets-status-panel-l1-design-2026-08-17.md §2 for why this specific,
// narrow duplication is accepted) -- it must never be extended to
// reimplement decryption or any write path.
export function secretState(repoRoot, name) {
  const kekConfigured = Boolean(process.env.DUNE_KEK_FILE) && Boolean(process.env.DUNE_AGE_IDENTITY_FILE);
  if (!kekConfigured) return "backend-not-configured";

  const encPath = join(repoRoot, "runtime", "secrets", `${name}.enc`);
  const markerPath = join(repoRoot, "runtime", "generated", ".secrets-migrated", `${name}.done`);

  if (isReadable(encPath)) return "migrated";
  if (isReadable(markerPath)) return "migrated";
  if (existsSync(encPath) || existsSync(markerPath)) return "broken";
  return "not-migrated";
}

export function allSecretStates(repoRoot) {
  return WIRED_SECRETS.map((name) => ({ name, state: secretState(repoRoot, name) }));
}
```

**`[R2]` placeholder for audit findings — none yet, this is revision 1.**

### 3.2 New route in `console/api/src/server.js`

Following the exact `backupAutoStatusRoute`-style pattern (`server.js:1456-1460`), added to the routing chain alongside the Backups block:

```js
if (path === "/api/secrets/status") return secretsStatusRoute(res);
```

```js
function secretsStatusRoute(res) {
  const secrets = allSecretStates(config.repoRoot);
  return json(res, 200, { secrets });
}
```

No `audit()` call — this is a pure read with no side effect, matching the precedent of other read-only status routes (`backupAutoStatusRoute` itself has no audit call either; only mutations are audited in this codebase).

### 3.3 New IAM action

`console/api/src/actions.js`:
```js
export const NAMESPACES = {
  ...
  SECRETS:     "secrets",
};
```
```js
"GET /api/secrets/status": "secrets:read",
```

**`console/api/test/rbacParity.test.js` requires this entry in the same commit** — the parity test statically extracts every route and fails if any authorized route is missing from `ROUTE_ACTIONS`.

### 3.4 Default tier policy

`console/api/src/policy.js` — add `"secrets:read"` to the **admin** tier's existing action list (alongside `"backups:*"`), matching the precedent that `backups:*` (which reveals whether/how credentials are stored, similar sensitivity) is admin+, not moderator/player/observer. Owner already has `Action: "*"`, inherits automatically.

```js
admin: {
  statements: [
    { Effect: "Allow", Action: [
      ...
      "backups:*",
      "secrets:read",
      ...
```

**`[R2]` open question for audit: should `secrets:read` be its own namespace entry, or folded into `settings:*`/`server:*`?** Current design treats it as its own small namespace (`secrets`) rather than overloading an existing one, matching the precedent that `backups` also has its own namespace despite being conceptually part of "server administration" — this keeps future `secrets:verify`/`secrets:migrate` actions (if ever built) cleanly separable, per the base-deletion.md precedent of splitting destructive actions into their own action name rather than a wildcard bucket.

### 3.5 Frontend API client: `console/web/src/api/secrets.ts`

```ts
import { api } from "./client";

export type SecretState = "backend-not-configured" | "not-migrated" | "migrated" | "broken";

export interface SecretStatusEntry {
  name: string;
  state: SecretState;
}

export const secretsApi = {
  status: () => api<{ secrets: SecretStatusEntry[] }>("/api/secrets/status")
};
```

### 3.6 Frontend component: `console/web/src/features/settings/SecretsStatusPanel.tsx`

Mounted in `App.tsx` alongside `IamPolicyEditor` under the existing "Access Control" tab (`App.tsx:865`), per the parent design doc's own suggestion (`docs/security/secrets-management.md`, "IAM Policy Editor and Secrets Manager belong together under Access Control").

```tsx
{!redeploySetupOpen && tab === "Access Control" && (
  <>
    <IamPolicyEditor />
    <SecretsStatusPanel />
  </>
)}
```

**`[R2]` Recorded tradeoff (UI Design/Architect hat, Finding UI-2)**: the alternative mount point — inside the existing "Backups" tab, since issue #276 (the direct precedent this whole feature mirrors) already established that tab as where operators look for credential/backup-adjacent operational health, not just permissions — was considered and rejected, but revision 1 didn't record the rejection's reasoning. Recorded now: Access Control is chosen because `secrets:read`'s admin+-only gate matches that tab's existing audience (server administrators reasoning about who-can-access-what), and `IamPolicyEditor` is already the natural place an admin looks when investigating an access-related question. This is a judgment call, not a settled fact — if operator feedback after shipping suggests Backups is the more discoverable location, moving this component is a one-file change with no data-model implications either way.

Structure closely follows `BackupsPanel`'s auto-status sub-block pattern (`BackupsPanel.tsx:70-78, 254-277`): a `refresh()` on mount, a de-dupe ref to avoid overlapping calls, `KeyValueGrid` (or an equivalent small list) rendering `<name>: <human-readable state>` per secret.

**`[R2]` Corrects a HIGH finding (UI Design/Architect, Finding UI-1): revision 1 cited `commandStatusSummary` as the tone-convention precedent to mirror, but that function only ever returns 2 states (`"Checked"`/`"Check Failed"`) — it has no 3-or-4-way healthy/attention/neutral distinction to actually mirror.** Verified directly: applying this codebase's actual free-text tone classifier (`normalizeStatus()`, `console/web/src/lib/display.ts:10-18`) to the two labels revision 1 proposed (`"Migrated (encrypted)"`, `"Migrated but currently unreadable/broken"`) would classify **both** as the neutral `info` tone — neither contains any of `normalizeStatus`'s pass/fail/warn keyword patterns — producing zero visual differentiation between "healthy" and "needs attention," the opposite of revision 1's own stated intent.

**Resolved: use an explicit small-enum → tone lookup table, not the free-text regex path** — matching the existing precedent set by `PlayerStatusCell` (`DisplayPrimitives.tsx:28-32`, an explicit `online`/`banned`/`offline` → CSS-class mapping for a small fixed enum), which is the correct structural analog for this panel's 4 known states, not `StatusPill`'s free-text `normalizeStatus()` path (correct for arbitrary/dynamic status strings, wrong for a small closed set where two labels happen to collide on tone).

```tsx
const SECRET_STATE_DISPLAY: Record<SecretState, { label: string; tone: "pass" | "fail" | "warn" | "info" }> = {
  "migrated":               { label: "Migrated (encrypted)",                          tone: "pass" },
  "broken":                 { label: "Migrated but currently unreadable/broken",       tone: "fail" },
  "not-migrated":           { label: "Not migrated (legacy plaintext)",                tone: "warn" },
  "backend-not-configured": { label: "Backend not configured",                         tone: "info" },
};
```
Labels are unchanged from revision 1 (still match the CLI's own wording verbatim, so an operator cross-referencing CLI output and the console sees consistent language) — only the tone-derivation mechanism changes, from an implicit regex match to an explicit table matching `PlayerStatusCell`'s own established pattern. Render via the existing `badge badge-${tone}` CSS classes `StatusPill` already uses (`DisplayPrimitives.tsx:17`), just driven by the explicit table above instead of `normalizeStatus()`.

**`[R2]` Corrects a MEDIUM finding (UI Design/Architect, Finding UI-3): revision 1 proposed "no action buttons... on-mount-only, no manual Refresh," but this is inconsistent with `BackupsPanel`'s own established convention for exactly this class of read-only sub-status block** — that panel's auto-status section refreshes on mount **and** exposes a manual "Refresh Backups" button that re-triggers the same fetch (`BackupsPanel.tsx:223`, wired to the same `refresh()`/`refreshAutoBackup()` used on mount). The primary real-world workflow this panel supports — an operator runs `dune secrets migrate <name>` in a separate terminal, then checks the console to confirm it worked — specifically requires a way to re-check without a full page reload. **Resolved: add a small "Refresh" button**, gated behind the same `secrets:read` action (a read action needs no confirmation dialog), matching the muted/small-button styling already used for comparable read-only refresh affordances elsewhere in this codebase.

**No `migrate`/`cleanup-legacy`/`verify` action buttons in revision 1** — purely a status display plus a refresh affordance, gated behind `secrets:read`. This directly matches issue #320's own scope statement.

---

## 4. Security Considerations

- **Never reads or transmits a secret value.** The API route only ever returns a 4-state enum string per secret name — confirmed by design (§3.1's `secretState()` never opens/reads the `.enc` file's contents, only checks existence/readability metadata via `fs.accessSync`/`fs.existsSync`, which are `stat`/`access` syscalls, never `open`/`read`). No path-traversal risk: `WIRED_SECRETS` is a hardcoded, module-level constant array, never derived from request input, and `repoRoot` comes from server-side config, never from the request.
- **Gated behind a new `secrets:read` IAM action**, admin+ tier only (not moderator/player/observer), matching the sensitivity precedent already set for `backups:*`.
- **`[R2]` Corrects a false claim (Security Architect, Finding H-4): revision 1 said this surfaces information "through an already-authenticated, already-audited web session" — the *session* is audited (login/logout), but this specific read is deliberately NOT (no `audit()` call in §3.2, matching the existing, accepted precedent that `backupAutoStatusRoute` and other pure-read routes also skip audit logging).** Stated plainly rather than implied: there is currently no audit trail of *who checked* secrets-migration status, matching (not exceeding) the sensitivity treatment already given to `backups:read`/`database:read`. If a future GRC review decides secrets-posture reads deserve their own audit trail (arguably more security-relevant than a backup list, since it reveals whether an operator's KEK/age setup is broken), that would be a deliberate, separate follow-up — not something this revision silently assumes already exists.
- **`[R2]` Error handling (Security Architect, Finding H-3): `secretsStatusRoute` has no explicit try/catch of its own** — it relies on `handleApi`'s existing outer catch (`server.js`, wraps every route handler) routing any uncaught exception through `apiErrorPayload`/`redact()` before reaching the client. This is consistent with the same pattern `backupAutoStatusRoute` itself uses. Stated here explicitly (not just assumed) because `redact()`'s pattern list is credential-shaped (tokens/passwords/JWTs), not path-shaped — if `isReadable()`'s own internal try/catch (§3.1) were ever removed during a future refactor, a raised `ENOENT`/`EACCES` error's `.message` (which embeds the full absolute filesystem path) would reach `redact()` unmodified and pass through unredacted. **`isReadable()`'s try/catch is therefore security-load-bearing, not just a convenience** — this must be called out in that function's own code comment so a future refactor doesn't remove it without realizing the implication.
- **No new attack surface for the underlying secrets themselves** — this panel cannot decrypt, migrate, or delete anything; it is read-only filesystem metadata, and even that metadata (a boolean-ish migration state) is already visible to anyone with shell access to the host running `dune secrets status` today.
- **`[R2]` IAM policy upgrade path (DBA, MEDIUM finding): operators with an already-customized, persisted `runtime/generated/iam-policies.json` will NOT automatically gain `secrets:read` on their admin tier when this ships** — `loadPolicies()` only falls back to the updated `DEFAULT_POLICIES` (which will include the new action) when no persisted file exists or it fails validation; a real, already-saved custom policy is not retroactively merged. This fails closed (403, not an accidental grant) — safe direction, but a silent post-upgrade UX gap. **Resolution: document this explicitly in the eventual PR/CHANGELOG entry** ("admin-tier operators with a customized IAM policy must manually add `secrets:read` to see the new panel") rather than building an additive-merge mechanism now, which is a larger change than this panel's own scope justifies.

---

## 5. What This Document Deliberately Does Not Build

- `verify` (decrypt-and-check) through the browser — deferred, see §6 Open Question 1.
- `migrate`/`cleanup-legacy` through the browser — permanently out of scope per #320/#276's shared precedent, not just deferred.
- Any UI for secrets Stage 2 hasn't wired yet (Postgres/Funcom/RMQ) — this panel only ever shows the 2 hardcoded names Stage 2 actually wires; it does not need to be generalized ahead of those secrets existing.
- The broader "Secrets Vault" CRUD/reveal/rotate UI sketched in `docs/security/secrets-management.md`'s Phase 2 section — unrelated, larger, undesigned scope.

---

## 6. Open Questions — Resolved by the Layer 1 Audit

1. **`verify` through the browser: confirmed deferred**, unanimous across hats. Ships as a self-contained follow-up only if operator feedback after this panel ships indicates it's actually wanted.
2. **`[R2]` — resolved differently than revision 1 proposed (QA/Test, Finding QA-1/QA-2, HIGH): "a code comment cross-reference" is not a sufficient drift-safety mechanism, and this repo already has an established, stronger pattern for exactly this problem.** `console/api/test/deferredReconcileScript.test.js` already uses `spawnSync` to invoke a real bash script against a fixture and assert the Node-side test's expectations against the actual bash output — direct, load-bearing precedent that a cross-language fixture test is not a disproportionate ask here. **Resolved: a new drift-detection test is a required deliverable** (see §8, item 6) that constructs fixture directories covering every combination of `kekConfigured × encExists × encReadable × markerExists × markerReadable` and asserts `secretState()` (Node) and `_dune_secrets_stage2_state()` (bash) return identical results for each — including the specific adversarial case QA-2 named explicitly: both the `.enc` file and marker exist, but only the marker is readable (correct answer: `"migrated"`, since either independently-readable signal is sufficient — a subtly-wrong implementation requiring both readable would incorrectly return `"broken"`, the exact shape of Stage 2's own past CRITICAL bug).
3. **Admin+-only: confirmed correct**, no dissent from any hat. A required test (§8, item 7) must assert moderator/player/observer are actually denied, not just documented as excluded.
4. **On-mount-only refresh, no timer: confirmed correct** — but `[R2]` (§3.6) adds a manual refresh **button**, which is a different question than periodic polling and was under-specified in revision 1 by conflating the two. No auto-poll timer; yes to an operator-triggered manual refresh.

---

## 7. Layer 1 Eight-Hats Audit — Findings Register

Dispatched 2026-08-17 as 3 independent Task-tool worker groups (covering all 8 hats) against revision 1 of this document. This section is the evidence artifact Requirement 20 requires.

| # | Hat | Severity | Finding | Resolution |
|---|---|---|---|---|
| 1 | Software Architect + Security Architect + Network Engineer (all 3 independently converged on this) | **CRITICAL** | `docker-compose.web.yml` never passes `DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` into the console container, and the container has no filesystem visibility into `~/.config/dune/` (where the parent design places the age identity) at all. As designed, the panel would report "Backend not configured" for every real operator, including ones who have genuinely completed the CLI migration. | Resolved in §2 `[R2]` — env vars added to the compose environment block, new read-only bind mount for `~/.config/dune`, both required in the same PR as the panel itself. |
| 2 | QA/Test | HIGH | No test file list named anywhere in revision 1 — several required tests (RBAC namespace-Set update distinct from the route-coverage test, drift-detection test, component test) entirely unaddressed. | Resolved — full deliverables list added as §8 below. |
| 3 | QA/Test | HIGH | "Inherently simple, unambiguous filesystem metadata" (§2's core justification) was asserted, not verified; no concrete failing-precedence test case was specified. | Resolved — §6 Q2 and §8 item 6 name the exact adversarial fixture (marker readable, `.enc` unreadable) required to prove precedence order is correct, not just "4 states covered." |
| 4 | UI Design/Architect | HIGH | §3.6's tone specification cited `commandStatusSummary` as precedent, but that function has no 3-or-4-way tone distinction to mirror; the two proposed labels would both classify as neutral `info` tone via the codebase's actual free-text classifier (`normalizeStatus()`), producing zero visual differentiation despite the design's own stated intent. | Resolved in §3.6 `[R2]` — explicit small-enum-to-tone lookup table, matching `PlayerStatusCell`'s existing precedent, not the free-text regex path. |
| 5 | GRC | HIGH | Same environment-propagation gap as Finding 1, independently found via a different lens (documented-assumption-verification) — confirms this is a genuine cross-cutting design defect, not a one-hat false positive. | Same resolution as Finding 1. |
| 6 | GRC | MEDIUM | No pre-committed evidence/test-deliverables table before implementation begins, unlike Stage 2's own L1 doc which had one. | Resolved — §8 added. |
| 7 | GRC | LOW | Citation imprecision: §2 attributed the CRITICAL-bug precedent to Stage 2's Finding 5 (which actually documents the *accepted remaining* duplication), when the actual CRITICAL bug was Finding 1. | Corrected in §2. |
| 8 | GRC | LOW | The 4th state ("broken") is a real, beneficial addition beyond issue #320's literal 3-state wording, but revision 1 didn't flag this delta explicitly for a reviewer. | Noted directly in this findings register (see also §1) — the addition is correct and necessary (a fail-closed migrated-but-broken secret must not display as "not migrated," which is what a strict 3-state design would force), not scope creep. |
| 9 | UI Design/Architect | MEDIUM | Mount-point decision (Access Control tab) is defensible but revision 1 didn't record the real counter-argument (Backups tab, per #276's own precedent for exactly this class of feature). | Resolved in §3.6 `[R2]` — tradeoff and counter-argument now recorded explicitly. |
| 10 | UI Design/Architect | MEDIUM | No manual refresh button, inconsistent with `BackupsPanel`'s own established convention for this exact class of status sub-block. | Resolved in §3.6 `[R2]` — refresh button added. |
| 11 | QA/Test | MEDIUM | No named test for the admin-tier RBAC boundary itself (moderator/player/observer must be denied, not just documented as excluded). | Resolved — §8 item 7. |
| 12 | DBA | MEDIUM | New default action (`secrets:read`) won't propagate to operators with an already-persisted, customized `iam-policies.json` — fails closed, but silent. | Resolved in §4 `[R2]` — documented as a required CHANGELOG/PR note, not a code change at this scope. |
| 13 | Security Architect | HIGH | `secretsStatusRoute` (§3.2) has no explicit try/catch; relies entirely on `handleApi`'s outer catch + `redact()`. Consistent with precedent, but the reliance should be stated, not assumed — and `redact()`'s pattern list wouldn't actually catch a leaked filesystem path if `isReadable()`'s own try/catch were ever removed in a future refactor. | Resolved in §4 `[R2]` — explicit note added; `isReadable()`'s try/catch flagged as security-load-bearing in its own future code comment. |
| 14 | Security Architect | HIGH | §4's "already-audited web session" claim overstated what's actually true — the session is audited, this specific read is not, by design (matching precedent). | Resolved in §4 `[R2]` — corrected wording, explicit statement that this is a deliberate, precedent-matching choice, not an oversight. |
| 15 | Network Engineer, Cloud Security Engineer, DBA | — (confirmed clean) | Zero new network calls/ports/DNS; zero cloud-provider surface; zero DB/schema/query touch. | No finding — confirmed accurate as designed, recorded here per the evidence-first standard (non-findings are also evidence). |
| — | Security Architect | LOW (confirmed-clean, 2 items) | "Never reads secret value" and "no path-traversal/user-input risk" — both independently verified true by direct code trace. | No finding. |
| — | Security Architect | MEDIUM | TOCTOU race between the readability and existence checks in `secretState()` — real, but inherited unchanged from the bash version's own equivalent race, not a new risk class introduced by this design. | Accepted as an inherited, already-tolerated risk; not fixed (matches the bash version's own accepted posture, per that function's own "display-layer concern" framing). |

**All CRITICAL and HIGH findings are resolved in this document's design (§2-§6).** A Layer 2 (implementation) audit against the actual merged code is still required before this is considered complete, per Requirement 20 — tracked as §8's own final deliverable.

---

## 8. Layer 2 Implementation — Required Deliverables (Definition of Done)

| # | Requirement | Test | File | Assertion |
|---|---|---|---|---|
| 1 | `docker-compose.web.yml`/`.env.example` updated | N/A (config, not test) | `docker-compose.web.yml`, `.env.example` | `DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` env passthrough added; `~/.config/dune` read-only bind mount added; both verified by actually starting the container and confirming `process.env.DUNE_KEK_FILE` is non-empty when set on the host, and that the mounted identity file is readable from inside the container. |
| 2 | `secretState()`/`allSecretStates()` unit tests | Unit | `console/api/test/secretsStatus.test.js` | All 4 states, using a temp-directory fixture (not the real `runtime/secrets/`) to control existence/readability precisely. |
| 3 | API route integration test | Integration | New test file or added to an existing `server.js` route-test file, matching how comparable routes are tested | `GET /api/secrets/status` end-to-end through `handleApi`; confirms JSON shape `{ secrets: [...] }`; confirms 403 for a caller without `secrets:read`. |
| 4 | RBAC parity — route coverage | N/A | `console/api/test/rbacParity.test.js` | `"GET /api/secrets/status": "secrets:read"` added to `ROUTE_ACTIONS`. |
| 5 | RBAC parity — namespace validity | N/A | `console/api/test/rbacParity.test.js` | **Separate, required edit**: `"secrets"` added to both hardcoded `validNamespaces` Sets (confirmed at 2 distinct locations in the current file) — the route-coverage fix alone does not satisfy this; both edits are needed in the same commit or CI hard-fails on "Unknown namespace in action: secrets:read." |
| 6 | Cross-language drift-detection test | Integration | `runtime/tests/test-secrets-status-panel-parity.sh` (or equivalent, following the `deferredReconcileScript.test.js` precedent for spawning a real script and asserting against Node's own logic) | Constructs fixture directories covering every combination of `kekConfigured × encExists × encReadable × markerExists × markerReadable`; asserts `secretState()` (Node) and `_dune_secrets_stage2_state()` (bash) return identical results for each. **Must include the specific adversarial case**: `.enc` exists-but-unreadable AND marker exists-and-readable → both implementations must return `"migrated"`, not `"broken"`. |
| 7 | RBAC tier-boundary test | Unit/Integration | Wherever this codebase's existing tier-boundary tests for `backups:*` live (locate and follow that exact pattern) | Asserts moderator/player/observer tiers are denied `secrets:read` by the shipped default policy, not just documented as excluded. |
| 8 | Frontend API client test | Unit | `console/web/src/api/secrets.test.ts` | Matches `backups.test.ts`'s pattern; verifies `secretsApi.status()` calls the right endpoint; exercises all 4 `SecretState` values. |
| 9 | Frontend component test | Unit | `console/web/src/features/settings/SecretsStatusPanel.test.tsx` | Renders all 4 states with correct label text and correct tone/class per the `SECRET_STATE_DISPLAY` lookup table (§3.6); confirms the refresh button re-triggers a fetch. |
| 10 | CHANGELOG/PR documentation | N/A | CHANGELOG.md / PR body | Explicit note for admin-tier operators with a customized IAM policy: must manually add `secrets:read` to their persisted policy to see this panel (per §4 `[R2]`'s DBA finding). |
| 11 | Layer 2 implementation audit | N/A (process) | N/A | Full eight-hats dispatch against the actual merged code, per Requirement 20 — required before this is presented for merge, matching the discipline already applied to Stage 2's own CLI feature. |
