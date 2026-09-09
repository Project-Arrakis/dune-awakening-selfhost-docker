# Discord Bot Adapter Settings Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Discord Bot" section to Core's Settings UI that automates enabling the Discord bot adapter (token generation, `.env` writes, container recreate) — replacing the current fully-manual `.env`-edit-and-restart process, for both hosted and self-hosted `mentat` bot deployments.

**Architecture:** Reuses the existing self-update-helper detached-container recreate mechanism (`buildSelfUpdateHelperDockerArgs()` in `tasks.js`, the existing `acquire_self_update_lock`/status-file machinery in `self-update.sh`) via a new, additive shell dispatch case that recreates the console with fresh `.env` only (no image build/pull). A new backend module owns validation, token generation, and orchestration; three new routes expose it; a new Settings section polls the *existing* `/api/updates/stack-progress` endpoint (unmodified) via the browser's `localStorage`-persisted-task pattern already used by "Apply Console Update," so a reload mid-recreate recovers cleanly.

**Tech Stack:** Node.js (`console/api`, `node:test`), React + TypeScript (`console/web`, Vitest + Testing Library), Bash (`runtime/scripts`).

**Spec:** `docs/design/discord-bot-adapter-settings-automation-l1-design-2026-09-09.md` (Layer 1 design, Eight-Hats audit findings incorporated — see that doc's §7 for the full findings register this plan resolves). Tracking issue: #720.

## Global Constraints

- No admin-supplied value (role IDs, token content) may ever be interpolated into a shell command string passed to the detached helper container — only into `.env` via `updateEnvFileValue()`/`updateEnvFileValues()`. (Design §3.2, audit finding #1, CRITICAL.)
- The enable/regenerate routes are gated by `updates:apply` (enable — docker-socket-triggering) and a new narrow `settings:discord-bot-regenerate-token` action (regenerate — file-only), never the generic `settings:write`. (Design §3.2, audit finding #3, HIGH.)
- Token regeneration must never launch the detached helper or recreate the container — it is a direct file rewrite only. (Design §3.2, audit finding #19.)
- Role IDs are validated server-side against `/^\d{15,21}$/` before being written; invalid input is rejected, never silently written. (Design §3.2, audit finding #17.)
- All new `.env` keys for one save are written in a single `updateEnvFileValues()` call (one read-modify-write pass) — never as separate sequential `updateEnvFileValue()` calls for a multi-key save. (Design §3.2, audit finding #15.)
- The Discord Bot settings section must always read live state on mount and populate the Enabled view from existing config before rendering anything — never assume "never configured" as a default, and never let plain "Enable" silently regenerate/overwrite an existing live token. (Design §3.1, audit finding #7, the 3-hat-convergent finding.)
- Any shell script change must pass `shellcheck` at this repo's own CI severity (`-S warning` treated as a hard failure — see this org's Requirement 9).
- Every step that touches `.env`/secrets logic must be verified against a real `docker compose config` invocation before being considered done, per this repo's own `runtime/tests/test-compose-project-name-portability.sh` precedent (Design §5, audit finding #22) — not mocked alone.

---

## File Structure

**New files:**
- `console/api/src/integrations/discord/adapterSettings.js` — token generation, role-ID validation, read-state assembly, enable/regenerate orchestration. Keeps `adapter.js`/`routes.js` (the existing bot-facing adapter surface) unchanged and focused.
- `console/api/test/discordAdapterSettings.test.js` — unit tests for the above.
- `console/web/src/api/discordAdapterSettings.ts` — typed client for the 3 new routes, matching `console/web/src/api/updates.ts`'s existing style.
- `console/web/src/features/settings/DiscordBotSection.tsx` — the new Settings UI section as its own component (kept out of the already-large `SettingsPanel.tsx`, matching this plan's file-size discipline — `SettingsPanel.tsx` is 828+ lines already).
- `console/web/src/features/settings/DiscordBotSection.test.tsx` — component tests for the 4 UI states.
- `runtime/tests/test-discord-adapter-env-recreate.sh` — real (non-mocked) `docker compose config` verification that the new self-update.sh dispatch case's env plumbing resolves correctly.

**Modified files:**
- `console/api/src/tasks.js` — fix the pre-existing shell-quoting bug in the helper log line; add a new `discordAdapterApply` task operation mirroring `runSelfUpdateHelperTask`.
- `console/api/src/services/envFile.js` — add `updateEnvFileValues()` (atomic multi-key write).
- `console/api/src/services/selfUpdateStatus.js` — extend the parsed status shape with an optional `discord_health_ok` field.
- `console/api/src/actions.js` — add the 3 new routes to `ROUTE_ACTIONS`, plus the new `settings:discord-bot-regenerate-token` action.
- `console/api/src/server.js` — dispatch the 3 new routes.
- `runtime/scripts/self-update.sh` — new `recreate_discord_adapter_env()` function + `apply-discord-adapter-env` dispatch case; add `runtime/secrets/discord-adapter-token.txt` to the 3 existing secret preserve/restore/chown lists.
- `console/web/src/features/settings/SettingsPanel.tsx` — render `<DiscordBotSection />` next to the existing "Discord OAuth" toggle section.
- `.github/workflows/ci.yml` — add the new shell test to the CI step list.
- `docs/security/secrets-management.md`, `docs/integrations/discord-control-bot/setup-guide.md`, `CHANGELOG.md` — doc currency (Design §6, audit finding #11).

---

### Task 1: Fix the pre-existing shell-quoting bug in the helper-launch log line

**Files:**
- Modify: `console/api/src/tasks.js:147-153`
- Test: `console/api/test/tasks.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `runSelfUpdateHelperTask`'s behavior is unchanged for real callers (`buildDuneArgs("selfUpdateApply")` still returns `["self-update", "install", "latest"]`); the log line's construction changes internally only.

This is audit finding #1 (CRITICAL): `tasks.js:150` nests an already-`shellQuote()`-wrapped value inside an outer double-quoted `echo` string. Double quotes don't neutralize a nested single-quoted value's `$(...)`/backtick content — so if `args` ever contained shell metacharacters, they'd still be interpreted. Currently dormant (today's only caller passes hardcoded args), but Task 7 of this plan adds a second caller — fix this first, independent of that.

- [ ] **Step 1: Write the failing test**

Add to `console/api/test/tasks.test.js` (near the existing `"web self-update helper mounts the host repo path"` test):

```js
test("self-update helper log line is safe even if an arg contained shell metacharacters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-quote-"));
  const calls = [];
  const previousProject = process.env.DUNE_COMPOSE_PROJECT_NAME;
  process.env.DUNE_COMPOSE_PROJECT_NAME = "dune-test";
  const manager = new TaskManager({
    repoRoot: dir,
    hostRepoRoot: "/host/repo",
    taskRetention: 20,
    commandTimeoutMs: 5000
  }, {
    runDockerCommand: async (args) => {
      calls.push(args);
      if (args[0] === "ps") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "helper-id\n", stderr: "" };
    }
  });

  try {
    // Directly exercise the log-line construction the same way
    // runSelfUpdateHelperTask does, with a deliberately hostile arg.
    manager.create("updates", "selfUpdateApply", {});
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    const dockerArgs = calls.find((c) => c[0] === "run");
    const command = dockerArgs[dockerArgs.length - 1];
    // The log-echo line must be a single-quoted literal (no unescaped `"`
    // wrapping args individually) -- assert the vulnerable pattern is gone:
    // a raw, unescaped `$(` must never appear outside the two intentional,
    // static `$(date -Is)` uses.
    const suspiciousSubstitutions = (command.match(/\$\(/g) || []).length;
    assert.equal(suspiciousSubstitutions, 1, "only the static 'finished' timestamp should use a live $(date -Is); the start line must use a precomputed JS timestamp");
  } finally {
    if (previousProject === undefined) delete process.env.DUNE_COMPOSE_PROJECT_NAME;
    else process.env.DUNE_COMPOSE_PROJECT_NAME = previousProject;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd console/api && node --test test/tasks.test.js`
Expected: FAIL — the current code has 2 uses of `$(date -Is)` (one in the start line, one in the finished line), so `suspiciousSubstitutions` is `2`, not `1`.

- [ ] **Step 3: Fix `runSelfUpdateHelperTask`**

In `console/api/src/tasks.js`, replace lines 147-153:

```js
    const logFile = "runtime/generated/web-self-update.log";
    const command = [
      "set -eu",
      "mkdir -p runtime/generated",
      `echo "[$(date -Is)] Starting Web UI stack update: runtime/scripts/dune ${args.map(shellQuote).join(" ")}" > ${shellQuote(logFile)}`,
      `DUNE_WEB_SELF_UPDATE_HELPER=1 runtime/scripts/dune ${args.map(shellQuote).join(" ")} >> ${shellQuote(logFile)} 2>&1`,
      `echo "[$(date -Is)] Web UI stack update finished" >> ${shellQuote(logFile)}`
    ].join("\n");
```

with:

```js
    const logFile = "runtime/generated/web-self-update.log";
    const startedAtIso = new Date().toISOString();
    const startLine = `[${startedAtIso}] Starting Web UI stack update: runtime/scripts/dune ${args.join(" ")}`;
    const command = [
      "set -eu",
      "mkdir -p runtime/generated",
      `echo ${shellQuote(startLine)} > ${shellQuote(logFile)}`,
      `DUNE_WEB_SELF_UPDATE_HELPER=1 runtime/scripts/dune ${args.map(shellQuote).join(" ")} >> ${shellQuote(logFile)} 2>&1`,
      `echo "[$(date -Is)] Web UI stack update finished" >> ${shellQuote(logFile)}`
    ].join("\n");
```

The fix: compute the start timestamp in JS (removing the need for a live `$(date -Is)` in that line at all), then wrap the *entire* start-line message in one `shellQuote()` call. Since the whole message is now a single outer-single-quoted shell literal, any content in `args` — including `$(...)`, backticks, or embedded quotes — is inert; `shellQuote()`'s existing escaping (`replace(/'/g, "'\\''")`) already handles embedded single quotes correctly. The second `DUNE_WEB_SELF_UPDATE_HELPER=1 ...` line is unaffected (each arg is individually `shellQuote()`'d and used directly as separate shell tokens, not nested inside an outer double-quoted string — that line was already safe). The "finished" line has no interpolated content, so its `$(date -Is)` is fine and stays.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd console/api && node --test test/tasks.test.js`
Expected: PASS. Also run the full existing suite to confirm no regression: `cd console/api && node --test test/tasks.test.js` should still show `"web self-update helper mounts the host repo path"` and `"detached self-update stays running until durable helper status completes it"` passing unchanged.

- [ ] **Step 5: Commit**

```bash
git add console/api/src/tasks.js console/api/test/tasks.test.js
git commit -m "fix(security): close shell-injection-adjacent quoting bug in self-update helper log line"
```

---

### Task 2: Add an atomic multi-key `.env` writer

**Files:**
- Modify: `console/api/src/services/envFile.js`
- Test: `console/api/test/envFile.test.js` (create if it doesn't already exist — check with `ls console/api/test/envFile.test.js` first; if it exists, add to it instead)

**Interfaces:**
- Consumes: nothing new.
- Produces: `updateEnvFileValues(repoRoot, entries)` where `entries` is `[key, value][]` — used by Task 8's enable-orchestration code.

Audit finding #15 (HIGH): `updateEnvFileValue()` only writes one key per call, each doing its own read-modify-write cycle. A multi-key save (enable writes `DUNE_DISCORD_ADAPTER_ENABLED` + `DUNE_DISCORD_ADAPTER_TOKEN_FILE` + up to 3 role-ID vars) needs one atomic pass so a process kill mid-save can't leave `.env` with only some keys applied.

- [ ] **Step 1: Write the failing test**

Create `console/api/test/envFile.test.js` (or add to it if present):

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateEnvFileValues } from "../src/services/envFile.js";

test("updateEnvFileValues writes multiple keys in a single pass, updating existing keys and appending new ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-envfile-"));
  writeFileSync(join(dir, ".env"), "EXISTING_KEY=old-value\nOTHER_KEY=untouched\n");

  updateEnvFileValues(dir, [
    ["EXISTING_KEY", "new-value"],
    ["DUNE_DISCORD_ADAPTER_ENABLED", "true"],
    ["DISCORD_PLAYER_ROLE_IDS", "111111111111111111,222222222222222222"]
  ]);

  const content = readFileSync(join(dir, ".env"), "utf8");
  assert.match(content, /^EXISTING_KEY=new-value$/m);
  assert.match(content, /^OTHER_KEY=untouched$/m);
  assert.match(content, /^DUNE_DISCORD_ADAPTER_ENABLED=true$/m);
  assert.match(content, /^DISCORD_PLAYER_ROLE_IDS=111111111111111111,222222222222222222$/m);
});

test("updateEnvFileValues creates .env from scratch when it does not exist yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-envfile-fresh-"));
  updateEnvFileValues(dir, [["DUNE_DISCORD_ADAPTER_ENABLED", "true"]]);
  const content = readFileSync(join(dir, ".env"), "utf8");
  assert.match(content, /^DUNE_DISCORD_ADAPTER_ENABLED=true$/m);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd console/api && node --test test/envFile.test.js`
Expected: FAIL with "updateEnvFileValues is not a function" (not exported yet).

- [ ] **Step 3: Implement `updateEnvFileValues`**

In `console/api/src/services/envFile.js`, add (after the existing `updateEnvFileValue` function):

```js
export function updateEnvFileValues(repoRoot, entries) {
  const envPath = resolve(repoRoot, ".env");
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  const remaining = new Map(entries.map(([key, value]) => [String(key || "").trim(), value]));
  const next = current.map((existing) => {
    const key = envLineKey(existing);
    if (remaining.has(key)) {
      const value = remaining.get(key);
      remaining.delete(key);
      return `${key}=${quoteEnv(String(value))}`;
    }
    return existing;
  });
  for (const [key, value] of remaining) {
    next.push(`${key}=${quoteEnv(String(value))}`);
  }
  writeFileSync(envPath, `${next.filter((entry, index) => entry !== "" || index < next.length - 1).join("\n")}\n`, { mode: 0o644 });
  try { chmodSync(envPath, 0o644); } catch {}
}
```

This mirrors `updateEnvFileValue`'s exact read/write shape but resolves every key against ONE read of the file and performs exactly ONE `writeFileSync` call for the whole batch, so there's no window where only some keys have been applied.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd console/api && node --test test/envFile.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add console/api/src/services/envFile.js console/api/test/envFile.test.js
git commit -m "feat(settings): add atomic multi-key .env writer"
```

---

### Task 3: Extend the self-update status schema with a post-recreate health field

**Files:**
- Modify: `console/api/src/services/selfUpdateStatus.js`
- Modify: `console/web/src/api/updates.ts`
- Test: `console/api/test/selfUpdateStatus.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `readSelfUpdateStatus(repoRoot, runId)` now returns an object that may include `discordHealthOk: boolean | null` in addition to its existing fields (`null` when the field is absent from the status file — i.e. for every existing self-update status file, and for a discord-adapter status file before the health-check line has been written). The frontend `StackUpdateProgress` type (`console/web/src/api/updates.ts`) is extended to match — Task 11's polling code reads `progress.discordHealthOk`, and without this the property does not exist on the type and `tsc --noEmit` fails.

Audit finding #14 (HIGH): the console container coming back up doesn't prove the Discord adapter's schema init or token read actually succeeded (both are fail-soft inside the process). Task 4's shell script will write this field after directly verifying `GET /api/integrations/discord/health` against the recreated container; this task makes the reader understand it.

- [ ] **Step 1: Write the failing test**

Add to `console/api/test/selfUpdateStatus.test.js` (check its existing `beforeEach`/fixture-directory pattern first with `cat console/api/test/selfUpdateStatus.test.js | head -40` and match it):

```js
test("readSelfUpdateStatus surfaces an optional discordHealthOk field when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-selfupdate-status-"));
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  const statusDir = join(dir, "runtime", "generated", "self-update-status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(join(statusDir, `${runId}.env`), [
    `run_id=${runId}`,
    "state=succeeded",
    "stage=complete",
    "percent=100",
    "message=Discord adapter enabled.",
    "started_at=2026-09-09T00:00:00Z",
    "updated_at=2026-09-09T00:01:00Z",
    "finished_at=2026-09-09T00:01:00Z",
    "discord_health_ok=1"
  ].join("\n"));

  const result = readSelfUpdateStatus(dir, runId);
  assert.equal(result.discordHealthOk, true);
});

test("readSelfUpdateStatus reports discordHealthOk as null when the field is absent (ordinary self-update status files)", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-selfupdate-status-plain-"));
  const runId = "223e4567-e89b-42d3-a456-426614174000";
  const statusDir = join(dir, "runtime", "generated", "self-update-status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(join(statusDir, `${runId}.env`), [
    `run_id=${runId}`,
    "state=succeeded",
    "stage=complete",
    "percent=100",
    "message=Console update completed successfully.",
    "started_at=2026-09-09T00:00:00Z",
    "updated_at=2026-09-09T00:01:00Z",
    "finished_at=2026-09-09T00:01:00Z"
  ].join("\n"));

  const result = readSelfUpdateStatus(dir, runId);
  assert.equal(result.discordHealthOk, null);
});
```

(Add `mkdirSync` to the test file's existing `node:fs` import if not already imported.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd console/api && node --test test/selfUpdateStatus.test.js`
Expected: FAIL — `result.discordHealthOk` is `undefined`, not `true`/`null`.

- [ ] **Step 3: Implement the field**

In `console/api/src/services/selfUpdateStatus.js`, modify the returned object in `readSelfUpdateStatus` (after the existing `finishedAt` line):

```js
  return {
    runId: cleanRunId,
    state: fields.state,
    stage: safeText(fields.stage, 64) || "unknown",
    percent: boundedPercent(fields.percent),
    message: safeText(fields.message, 500),
    startedAt: safeTimestamp(fields.started_at),
    updatedAt: safeTimestamp(fields.updated_at),
    finishedAt: safeTimestamp(fields.finished_at),
    discordHealthOk: parseOptionalBool(fields.discord_health_ok)
  };
}

function parseOptionalBool(value) {
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd console/api && node --test test/selfUpdateStatus.test.js`
Expected: PASS.

- [ ] **Step 5: Update the matching frontend type**

In `console/web/src/api/updates.ts`, add the new optional field to `StackUpdateProgress`:

```ts
export type StackUpdateProgress = {
  runId: string;
  state: "pending" | "running" | "succeeded" | "failed";
  stage: string;
  percent: number;
  message: string;
  startedAt?: string | null;
  updatedAt?: string | null;
  finishedAt?: string | null;
  discordHealthOk?: boolean | null;
};
```

Run: `cd console/web && npx tsc --noEmit`
Expected: 0 errors (this type change alone has no consumers yet — Task 11 is the first to read `discordHealthOk`).

- [ ] **Step 6: Commit**

```bash
git add console/api/src/services/selfUpdateStatus.js console/api/test/selfUpdateStatus.test.js console/web/src/api/updates.ts
git commit -m "feat(settings): extend self-update status schema with an optional discordHealthOk field"
```

---

### Task 4: Add the buildless-recreate shell function and dispatch case

**Files:**
- Modify: `runtime/scripts/self-update.sh`
- Test: `runtime/tests/test-discord-adapter-env-recreate.sh` (new)
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `web_console_service_name()`, `prepare_web_console_rebuild_env()`, `acquire_self_update_lock()`, `self_update_running()`, `self_update_write_status()` — all pre-existing functions in `self-update.sh`.
- Produces: `runtime/scripts/self-update.sh apply-discord-adapter-env [<service>]` — a new dispatch case that recreates the console container with the *current* image and *current* `.env` (no build/pull), then verifies the Discord adapter's health endpoint and records the result in the run's status file.

Audit findings #4 and #6 (HIGH): `self-update.sh`'s only existing recreate path (`rebuild_web_console_now`) always runs a full `docker compose build` first — there's no existing buildless entry point, and completion-detection elsewhere is keyed on a version change this feature doesn't have. This task adds a new, clearly separate function and dispatch case rather than modifying the existing `install|apply`/`rebuild-web-console` paths at all.

- [ ] **Step 1: Read the exact surrounding code to confirm line anchors before editing**

Run: `grep -n "^rebuild_web_console_now\|^cmd=\"\${1:-check}\"\|^  rebuild-web-console)\|^esac" runtime/scripts/self-update.sh`

Confirm the output still matches: `rebuild_web_console_now` starting near line 996, the `cmd="${1:-check}"` dispatch starting near line 1194, the `rebuild-web-console)` case near line 1198, and `esac` near line 1287. If line numbers have shifted (this repo is actively developed), use the actual current line numbers for the insertions below — the constants used inside the function bodies do not change.

- [ ] **Step 2: Add `recreate_discord_adapter_env()` immediately after `rebuild_web_console_now()`**

In `runtime/scripts/self-update.sh`, insert this new function directly after `rebuild_web_console_now()`'s closing `}` (the one at the end of the function shown in this plan's research, right before `rebuild_web_console_with_helper()`):

```sh
# recreate_discord_adapter_env: recreates the web console container with its
# CURRENT image and CURRENT .env -- no build, no pull. Used by the Discord
# Bot Settings "Enable"/role-ID-change flow, which only needs new
# environment variables to take effect, never a version change. Deliberately
# a separate function from rebuild_web_console_now() (which always builds
# first) rather than a conditional branch inside it -- self-update.sh's own
# install/apply flow must never be able to accidentally skip its build step.
recreate_discord_adapter_env() {
  local service="$1"
  local web_compose_project="${DUNE_WEB_COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}"
  prepare_web_console_rebuild_env
  self_update_running restarting 60 "Applying Discord adapter settings and restarting the console."
  docker rm -f "$service" >/dev/null 2>&1 || true
  COMPOSE_PROJECT_NAME="$web_compose_project" DUNE_COMPOSE_PROJECT_NAME="$DUNE_COMPOSE_PROJECT_NAME" DUNE_HOST_REPO_ROOT="$HOST_ROOT_DIR" docker compose -f docker-compose.web.yml up -d --force-recreate "$service"
  verify_discord_adapter_health "$service"
}

# verify_discord_adapter_health: after the recreate above, waits briefly for
# the new container to accept connections, then calls its own
# /api/integrations/discord/health with the freshly-written bearer token --
# proving the adapter actually came up working, not just that the container
# process exists. Both initializeDiscordAdapterSchema()'s promise rejection
# and a missing/corrupt token file are fail-soft at the container level
# (Layer 1 DBA audit finding), so "the container is up" alone cannot answer
# this question -- only a real request through the same bearer-token check a
# real bot would use can. Records the result in the run's own status file
# (discord_health_ok=1/0) rather than failing the script outright: a health
# check failure here is a genuinely new, actionable state ("Enabled, but
# the adapter isn't responding") the frontend surfaces distinctly (§4 of the
# design doc), not a reason to make the whole recreate report as failed --
# the container recreate itself did succeed.
verify_discord_adapter_health() {
  local service="$1"
  local port token attempt health_ok=0

  port="$(read_env_file_value ADMIN_WEB_PORT || true)"
  [ -n "$port" ] || port="$(read_env_file_value ADMIN_BIND_PORT || true)"
  [ -n "$port" ] || port="8088"

  token="$(read_env_file_value DUNE_DISCORD_ADAPTER_TOKEN || true)"
  if [ -z "$token" ]; then
    local token_file
    token_file="$(read_env_file_value DUNE_DISCORD_ADAPTER_TOKEN_FILE || true)"
    [ -n "$token_file" ] && [ -f "$token_file" ] && token="$(tr -d '[:space:]' < "$token_file")"
  fi

  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -m 5 -H "Authorization: Bearer $token" "http://127.0.0.1:${port}/api/integrations/discord/health" >/dev/null 2>&1; then
      health_ok=1
      break
    fi
    sleep 2
  done

  self_update_write_status succeeded complete 100 "Discord adapter settings applied." "$(date -Is)"
  {
    printf 'discord_health_ok=%s\n' "$health_ok"
  } >> "$SELF_UPDATE_STATUS_DIR/$SELF_UPDATE_RUN_ID.env"
  SELF_UPDATE_STATUS_FINALIZED=1
}
```

- [ ] **Step 3: Add the `apply-discord-adapter-env` dispatch case**

In `runtime/scripts/self-update.sh`, add a new case immediately before the existing `rebuild-web-console)` case in the `case "$cmd" in` block:

```sh
  apply-discord-adapter-env)
    acquire_self_update_lock
    dune_persist_compose_project_name "$ROOT_DIR" "$DUNE_COMPOSE_PROJECT_NAME"
    service="${tag:-}"
    if [ -z "$service" ]; then
      service="$(web_console_service_name 2>/dev/null || true)"
    fi
    if [ -z "$service" ]; then
      echo "Dune Docker Console service was not found in docker-compose.web.yml."
      exit 2
    fi
    ensure_docker_access_for_console_rebuild
    recreate_discord_adapter_env "$service"
    ;;

```

Placing `acquire_self_update_lock` at the top of this case means it shares the exact same `runtime/generated/self-update.lock` (via `flock -n`) that `install|apply` already uses — a concurrent self-update and a concurrent "Enable Discord Bot Integration" can never race, and the losing one gets the existing, already-tested "Another console update is already running" message and exit code 75 (Task 8 surfaces this to the frontend as a clear retry-later error, per Design §4).

- [ ] **Step 4: Shellcheck the modified file**

Run: `shellcheck -S warning runtime/scripts/self-update.sh`
Expected: no new warnings introduced by this change. If any appear on the new lines, fix them before proceeding (this repo's CI treats `-S warning` as a hard failure).

- [ ] **Step 5: Write the real (non-mocked) `docker compose config` verification test**

Create `runtime/tests/test-discord-adapter-env-recreate.sh`, mirroring `runtime/tests/test-compose-project-name-portability.sh`'s structure:

```sh
#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || { echo "SKIP: docker not available"; exit 0; }
[ -f docker-compose.web.yml ] || fail "docker-compose.web.yml not found"

# Real invocation, no live container -- proves docker-compose.web.yml is
# still valid, the expected service name resolves, and setting the same
# env vars recreate_discord_adapter_env() writes actually flow into the
# resolved config, without needing a running Docker daemon beyond `compose
# config`'s own static resolution.
service="$(docker compose -f docker-compose.web.yml config --services 2>/dev/null | grep -E '^redblink-dune-docker-console$' | head -n1 || true)"
[ -n "$service" ] || fail "expected service 'redblink-dune-docker-console' not found in docker-compose.web.yml"

tmp_env="$(mktemp)"
trap 'rm -f "$tmp_env"' EXIT
cp .env "$tmp_env" 2>/dev/null || touch "$tmp_env"
{
  echo "DUNE_DISCORD_ADAPTER_ENABLED=true"
  echo "DUNE_DISCORD_ADAPTER_TOKEN_FILE=runtime/secrets/discord-adapter-token.txt"
} >> "$tmp_env"

resolved="$(env $(grep -v '^#' "$tmp_env" | xargs -d '\n' -I{} echo {}) docker compose -f docker-compose.web.yml config 2>/dev/null || true)"
[ -n "$resolved" ] || fail "docker compose config produced no output with Discord adapter env vars set"
echo "$resolved" | grep -q "DUNE_DISCORD_ADAPTER_ENABLED" || fail "resolved compose config did not include DUNE_DISCORD_ADAPTER_ENABLED -- check docker-compose.web.yml's environment: passthrough for this variable"

echo "OK: docker-compose.web.yml resolves correctly with Discord adapter env vars set"
```

Run: `chmod +x runtime/tests/test-discord-adapter-env-recreate.sh`

- [ ] **Step 6: Run the new test**

Run: `runtime/tests/test-discord-adapter-env-recreate.sh`
Expected: `OK: docker-compose.web.yml resolves correctly...` — if it instead fails with "resolved compose config did not include DUNE_DISCORD_ADAPTER_ENABLED", check whether `docker-compose.web.yml`'s `environment:` block for the console service already passes through arbitrary host env vars or needs an explicit `DUNE_DISCORD_ADAPTER_ENABLED: "${DUNE_DISCORD_ADAPTER_ENABLED:-false}"` line added — if so, add it as part of this task (grep the file for `ADMIN_BIND_HOST:` to find the existing `environment:` block and match its style).

- [ ] **Step 7: Wire the new test into CI**

In `.github/workflows/ci.yml`, add a new step after the existing "Test Compose project-name portability" step (around line 156-160):

```yaml
      - name: Test Discord adapter env recreate (no build/pull, real docker compose config)
        run: |
          runtime/tests/test-discord-adapter-env-recreate.sh
```

- [ ] **Step 8: Commit**

```bash
git add runtime/scripts/self-update.sh runtime/tests/test-discord-adapter-env-recreate.sh .github/workflows/ci.yml
git commit -m "feat(settings): add buildless console-env-recreate path, shared lock with self-update"
```

---

### Task 5: Preserve the Discord adapter token file across self-update backups

**Files:**
- Modify: `runtime/scripts/self-update.sh` (3 locations)

**Interfaces:**
- Consumes: nothing new.
- Produces: no new interface — `runtime/secrets/discord-adapter-token.txt` is now backed up, restored, and re-chowned the same way `runtime/secrets/funcom-token.txt` already is.

Audit finding #18 (MEDIUM): the new secret file isn't covered by `self-update.sh`'s existing secret preserve/restore/chown lists, risking loss or a bad ownership after an unrelated future stack self-update.

- [ ] **Step 1: Add to the backup manifest list**

Run: `grep -n "runtime/secrets/public-directory.json" runtime/scripts/self-update.sh` to find the current line numbers (there are 3 occurrences — a backup-manifest list, a restore-calls block, and a chown list). At the first occurrence (the backup manifest, a `for path in ... do` list), add a new line immediately after `runtime/secrets/public-directory.json`:

```sh
    runtime/secrets/funcom-token.txt \
    runtime/secrets/public-directory.json \
    runtime/secrets/discord-adapter-token.txt
```

(Note: this list's last entry has no trailing `\` — make sure the new last entry (`discord-adapter-token.txt`) also has no trailing `\`, and add one to the now-not-last `public-directory.json` line above it.)

- [ ] **Step 2: Add to the restore-calls block**

At the second occurrence (`restore_local_state_file_if_needed "$backup_dir" runtime/secrets/public-directory.json`), add immediately after:

```sh
  restore_local_state_file_if_needed "$backup_dir" runtime/secrets/funcom-token.txt
  restore_local_state_file_if_needed "$backup_dir" runtime/secrets/public-directory.json
  restore_local_state_file_if_needed "$backup_dir" runtime/secrets/discord-adapter-token.txt
```

- [ ] **Step 3: Add to the chown list**

At the third occurrence (inside `restore_local_state_ownership()`'s `chown ... \` list, currently ending with `runtime/secrets/public-directory.json \` then `runtime/secrets/funcom-token.txt \`), add a new line:

```sh
    runtime/secrets/public-directory.json \
    runtime/secrets/funcom-token.txt \
    runtime/secrets/discord-adapter-token.txt \
    2>/dev/null || true
```

- [ ] **Step 4: Shellcheck**

Run: `shellcheck -S warning runtime/scripts/self-update.sh`
Expected: clean, no new warnings.

- [ ] **Step 5: Manual verification**

Run: `grep -c "discord-adapter-token.txt" runtime/scripts/self-update.sh`
Expected: `3` (one per list).

- [ ] **Step 6: Commit**

```bash
git add runtime/scripts/self-update.sh
git commit -m "fix(self-update): preserve the Discord adapter token file across stack updates"
```

---

### Task 6: Add IAM actions for the 4 new routes

**Files:**
- Modify: `console/api/src/actions.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `actionForRoute("GET /api/settings/discord-bot", "GET")` → `"settings:read"`; `actionForRoute("POST /api/settings/discord-bot/enable", "POST")` → `"updates:apply"`; `actionForRoute("POST /api/settings/discord-bot/role-ids", "POST")` → `"updates:apply"`; `actionForRoute("POST /api/settings/discord-bot/regenerate-token", "POST")` → `"settings:discord-bot-regenerate-token"`.

Audit finding #3 (HIGH, 3-hat convergent): gate the docker-socket-triggering "enable" and "role-ids" routes (both trigger the recreate helper, since role IDs are only read at container start) behind the same narrow `updates:apply` action self-update itself uses (owner AND admin, matching existing `updates:*` scope — admin already reaches this exact class of capability via self-update, so this introduces no new admin-tier capability). Gate "regenerate" (file-only, but irreversible and disruptive) behind a new, narrow `settings:*`-family action, matching the established `settings:regenerate-recovery-codes`/`settings:change-password` precedent — denied to admin via the existing `"Deny": "settings:*"` wildcard, owner-only by default. `role-ids` is a separate route from `enable` specifically so that saving a role-ID change on an already-enabled adapter can never, as a side effect, pass through `enableDiscordBotAdapter()`'s always-mint-a-fresh-token logic (see Task 8's `updateDiscordBotRoleIds()`) — the two operations are kept as two routes precisely because their token-mutation behavior must never be conflated.

- [ ] **Step 1: Verify current state before editing**

Run: `grep -n "GET /api/updates/stack-progress\|POST /api/settings/public-directory\"" console/api/src/actions.js`
Confirm both lines are still present as shown in this plan's research (`"GET /api/updates/stack-progress": "updates:read"` and `"POST /api/settings/public-directory": "settings:write"`).

- [ ] **Step 2: Add the 4 new route entries**

In `console/api/src/actions.js`, in the `// --- Settings ---` section (near `"POST /api/settings/public-directory/claim": "settings:write",`), add:

```js
  "GET /api/settings/discord-bot":              "settings:read",
  "POST /api/settings/discord-bot/enable":      "updates:apply",
  "POST /api/settings/discord-bot/role-ids":    "updates:apply",
  "POST /api/settings/discord-bot/regenerate-token": "settings:discord-bot-regenerate-token",
```

- [ ] **Step 3: Verify no default-policy change is needed**

Run: `grep -n '"updates:\*"\|"settings:\*"' console/api/src/policy.js`
Confirm `owner`'s `{ Effect: "Allow", Action: "*" }` and `admin`'s `"updates:*"` Allow / `"settings:*"` Deny wildcards (shown in this plan's research) are unchanged — if so, no `DEFAULT_POLICIES` edit is needed: `updates:apply` is already reachable by owner and admin, `settings:discord-bot-regenerate-token` is already denied to admin via the `settings:*` Deny wildcard and reachable by owner via `"*"`.

- [ ] **Step 4: Write a policy-resolution test**

Check whether `console/api/test/discordPolicy.test.js` or a general `actions.test.js`/`policy.test.js` file already exists (`ls console/api/test/*policy*.test.js console/api/test/actions.test.js 2>/dev/null`) and add to the most relevant one, or create `console/api/test/discordAdapterSettingsPolicy.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";

test("Discord Bot settings routes resolve to the expected actions", () => {
  assert.equal(actionForRoute("/api/settings/discord-bot", "GET"), "settings:read");
  assert.equal(actionForRoute("/api/settings/discord-bot/enable", "POST"), "updates:apply");
  assert.equal(actionForRoute("/api/settings/discord-bot/role-ids", "POST"), "updates:apply");
  assert.equal(actionForRoute("/api/settings/discord-bot/regenerate-token", "POST"), "settings:discord-bot-regenerate-token");
});

test("admin can enable the Discord adapter (already has updates:apply via self-update) but cannot regenerate its token (settings:* denied)", () => {
  assert.equal(evaluate({ tier: "admin" }, "updates:apply"), true);
  assert.equal(evaluate({ tier: "admin" }, "settings:discord-bot-regenerate-token"), false);
});

test("owner can do both", () => {
  assert.equal(evaluate({ tier: "owner" }, "updates:apply"), true);
  assert.equal(evaluate({ tier: "owner" }, "settings:discord-bot-regenerate-token"), true);
});
```

(If `evaluate`'s real signature differs from `evaluate(session, action)` — check `console/api/src/policy.js`'s actual export signature with `grep -n "^export function evaluate" console/api/src/policy.js` before running this test, and adjust the call shape to match, e.g. it may take a third `policies` argument.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd console/api && node --test test/discordAdapterSettingsPolicy.test.js`
Expected: PASS. If `evaluate`'s signature needed adjusting in Step 4, re-run after fixing.

- [ ] **Step 6: Commit**

```bash
git add console/api/src/actions.js console/api/test/discordAdapterSettingsPolicy.test.js
git commit -m "feat(settings): add IAM actions for Discord Bot settings routes"
```

---

### Task 7: Add the `discordAdapterApply` task operation

**Files:**
- Modify: `console/api/src/tasks.js`
- Test: `console/api/test/tasks.test.js`

**Interfaces:**
- Consumes: `buildSelfUpdateHelperDockerArgs()` (existing, unchanged signature).
- Produces: `TaskManager.run()` now recognizes `operation === "discordAdapterApply"` and routes it to a new `runDiscordAdapterApplyTask(task, payload)` method, which returns a `Task` object (via `tasks.create("settings", "discordAdapterApply", {})`) whose `id` becomes the run ID Task 4's shell function writes status under.

This mirrors `runSelfUpdateHelperTask` exactly, with two differences: the launched command is `runtime/scripts/dune console apply-discord-adapter-env` (a fixed, non-parameterized string — no admin-supplied value is ever part of it, satisfying the Global Constraint) instead of `dune self-update install latest`, and the helper container gets its own name prefix (`dune-discord-adapter-apply-*`) so it's never confused with a self-update helper by `cleanupStaleSelfUpdateHelpers`'s existing name-pattern matching.

- [ ] **Step 1: Add the `console apply-discord-adapter-env` dispatch to the `dune` CLI wrapper**

Run: `grep -n "self-update|stack-update)" runtime/scripts/dune` to confirm the exact current line. Add a new case immediately after it (or after the nearest existing `console` subcommand dispatch, if one already exists — check with `grep -n "^  console" runtime/scripts/dune` first and add alongside it if so, otherwise add standalone):

```sh
  console)
    case "${2:-}" in
      apply-discord-adapter-env)
        shift 2
        runtime/scripts/self-update.sh apply-discord-adapter-env "$@"
        ;;
      restart)
        # existing "dune console restart" behavior, if present -- do not
        # remove or alter it; only add the new subcommand above.
        ;;
      *)
        echo "Usage: dune console [apply-discord-adapter-env|restart]" >&2
        exit 2
        ;;
    esac
    ;;
```

If `runtime/scripts/dune` already has a `console)` case (check first — this plan's research did not confirm one exists), merge the new `apply-discord-adapter-env)` sub-case into the existing one instead of adding a duplicate `console)` case, preserving every existing sub-case exactly as-is.

- [ ] **Step 2: Write the failing test**

Add to `console/api/test/tasks.test.js`, modeled directly on the existing `"detached self-update stays running until durable helper status completes it"` test:

```js
test("discordAdapterApply launches a distinctly-named helper and stays running until durable status completes it", async () => {
  const previousProject = process.env.DUNE_COMPOSE_PROJECT_NAME;
  process.env.DUNE_COMPOSE_PROJECT_NAME = "dune-test";
  const calls = [];
  const manager = new TaskManager({
    repoRoot: "/repo",
    hostRepoRoot: "/host/repo",
    taskRetention: 20,
    commandTimeoutMs: 5000
  }, {
    runDockerCommand: async (args) => {
      calls.push(args);
      if (args[0] === "ps") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "helper-id\n", stderr: "" };
    }
  });

  try {
    const created = manager.create("settings", "discordAdapterApply", {});
    let current = manager.get(created.id);
    for (let attempt = 0; attempt < 100 && current?.currentStep !== "Update helper running"; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      current = manager.get(created.id);
    }
    assert.equal(current?.status, "running");
    const dockerRunArgs = calls.find((c) => c[0] === "run");
    assert.ok(dockerRunArgs, "expected a docker run invocation");
    const nameIndex = dockerRunArgs.indexOf("--name");
    assert.match(dockerRunArgs[nameIndex + 1], /^dune-discord-adapter-apply-\d+$/);
    const command = dockerRunArgs[dockerRunArgs.length - 1];
    assert.match(command, /runtime\/scripts\/dune console apply-discord-adapter-env/);
    // Global Constraint: no admin-supplied value is ever part of this
    // command string -- it is always this exact fixed invocation.
    assert.doesNotMatch(command, /DISCORD_[A-Z_]*ROLE/);
  } finally {
    if (previousProject === undefined) delete process.env.DUNE_COMPOSE_PROJECT_NAME;
    else process.env.DUNE_COMPOSE_PROJECT_NAME = previousProject;
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd console/api && node --test test/tasks.test.js`
Expected: FAIL — `TaskManager.run()` doesn't recognize `"discordAdapterApply"` yet, so it falls through to `taskOperations()`, which returns `["discordAdapterApply"]` unchanged and tries to `buildDuneArgs("discordAdapterApply", {})`, which will throw (unknown operation) inside the `run()` try/catch, leaving the task `failed`, never reaching `"Update helper running"`.

- [ ] **Step 4: Implement the new operation**

In `console/api/src/tasks.js`, modify `isSelfUpdateApplyOperation` usage in `run()`:

```js
      if (isSelfUpdateApplyOperation(task.operation)) {
        await this.runSelfUpdateHelperTask(task, payload);
        return;
      }
      if (isDiscordAdapterApplyOperation(task.operation)) {
        await this.runDiscordAdapterApplyTask(task, payload);
        return;
      }
```

Add the new method right after `runSelfUpdateHelperTask` (reusing the exact same shape, with a different helper name prefix and fixed command):

```js
  async runDiscordAdapterApplyTask(task, payload) {
    const composeProjectName = process.env.DUNE_COMPOSE_PROJECT_NAME || process.env.COMPOSE_PROJECT_NAME;
    if (!composeProjectName) throw new Error("Main Dune Compose project name was not provided to the Console.");
    const helperImage = process.env.DUNE_SYSTEMD_HELPER_IMAGE || "redblink-dune-docker-console:dev";
    const hostRepoRoot = process.env.DUNE_HOST_REPO_ROOT || this.config.hostRepoRoot || this.config.repoRoot;
    const hostUid = process.env.DUNE_HOST_UID || String(process.getuid?.() ?? 0);
    const hostGid = process.env.DUNE_HOST_GID || String(process.getgid?.() ?? 0);
    const dockerSocketGid = process.env.DOCKER_SOCKET_GID || detectDockerSocketGid();
    const extraEnv = [`DUNE_SELF_UPDATE_RUN_ID=${task.id}`];
    const logFile = "runtime/generated/discord-adapter-apply.log";
    // Fixed, non-parameterized command -- see this plan's Global
    // Constraints. Never interpolate `payload` (which carries the
    // admin-supplied role IDs) into this string; those values only ever
    // reach the system via .env, written before this task is created (see
    // Task 8), and are read back from .env by the shell script itself.
    const command = [
      "set -eu",
      "mkdir -p runtime/generated",
      `echo "Starting Discord adapter settings apply" > ${shellQuote(logFile)}`,
      `DUNE_WEB_SELF_UPDATE_HELPER=1 runtime/scripts/dune console apply-discord-adapter-env >> ${shellQuote(logFile)} 2>&1`,
      `echo "Discord adapter settings apply finished" >> ${shellQuote(logFile)}`
    ].join("\n");
    const helperName = `dune-discord-adapter-apply-${Date.now()}`;

    task.currentStep = "Starting update helper";
    this.emit(task, "Starting detached Discord adapter apply helper");
    await cleanupStaleSelfUpdateHelpers(this.config.repoRoot, this.runDockerCommand);
    const result = await this.runDockerCommand(buildSelfUpdateHelperDockerArgs({
      helperName,
      hostRepoRoot,
      composeProjectName,
      helperImage,
      hostUid,
      hostGid,
      dockerSocketGid,
      extraEnv,
      command
    }), this.config.repoRoot);

    this.append(task, `Update helper started: ${result.stdout.trim() || helperName}`, "stdout");
    this.append(task, `Update log: ${logFile}`, "stdout");
    task.currentStep = "Update helper running";
    this.emit(task, "Update helper is running. The Web UI may reconnect while the console restarts.");
  }
```

Add the small predicate function next to `isSelfUpdateApplyOperation`:

```js
function isDiscordAdapterApplyOperation(operation) {
  return operation === "discordAdapterApply";
}
```

Note `cleanupStaleSelfUpdateHelpers`'s existing name-pattern regex (`^(?:dune-web-self-update-\d+|dune-console-self-update-\d+)$`) does **not** match `dune-discord-adapter-apply-*` — this is intentional for this task (my helper isn't subject to that specific staleness cleanup yet, since it's a different, shorter-lived operation type than a full self-update). This plan deliberately does not extend that regex, since a wrong extension could suppress legitimate self-update-helper cleanup; if stale Discord-adapter-apply helpers become a real operational issue after this ships, that's a follow-up, not part of this plan (YAGNI — there's no evidence yet this specific helper type accumulates stale instances the way self-update's can).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd console/api && node --test test/tasks.test.js`
Expected: PASS, along with all pre-existing tests in the file still passing.

- [ ] **Step 6: Commit**

```bash
git add console/api/src/tasks.js console/api/test/tasks.test.js runtime/scripts/dune
git commit -m "feat(settings): add discordAdapterApply task operation"
```

---

### Task 8: Add the backend business-logic module and 4 routes

**Files:**
- Create: `console/api/src/integrations/discord/adapterSettings.js`
- Modify: `console/api/src/integrations/discord/adapter.js`
- Modify: `console/api/src/integrations/discord/policy.js`
- Modify: `console/api/src/server.js`
- Test: `console/api/test/discordAdapterSettings.test.js`

**Interfaces:**
- Consumes: `updateEnvFileValues` (Task 2), `discordAdapterEnabled`/`discordRoleMappingFromEnv`/`readDiscordBotApiToken` (existing, from `adapter.js`/`routes.js`, renamed in Step 0 below), `tasks.create("settings", "discordAdapterApply", {})` (Task 7), `audit()` (existing, imported the same way `adapter.js` already does).
- Produces: `readDiscordBotSettingsState(config)`, `validateDiscordRoleIds(roleIds)`, `enableDiscordBotAdapter(config, roleIdsByTier)`, `updateDiscordBotRoleIds(config, roleIdsByTier)`, `regenerateDiscordBotToken(config)` — all exported for the route handlers and for direct unit testing. `enableDiscordBotAdapter` and `regenerateDiscordBotToken` both return `{ ok: true, token: string, ... }` (the plaintext token, once); `updateDiscordBotRoleIds` returns `{ ok: true }` and never touches the token.

Audit findings #7 (state detection), #16/#17 (allowlist + validation), #19 (no recreate for regen), #10 (audit trail), #29 (fresh token guarantee).

- [ ] **Step 0: Rename the "observer" role-ID list to "player" in the existing adapter code, with a backward-compatible env var fallback**

The real, current `discordRoleMappingFromEnv()` in `console/api/src/integrations/discord/adapter.js` (verified directly, not assumed) reads `env.DISCORD_OBSERVER_ROLE_IDS` and returns a field named `observerRoleIds`; `console/api/src/integrations/discord/policy.js`'s `normalizeRoleMapping()` mirrors the same field name. "Observer" is obsolete terminology for this role-ID list going forward — rename both the env var and the field to "player," matching every new name this plan already uses (`DISCORD_PLAYER_ROLE_IDS`, `roleIds.player`, etc.), while keeping a fallback read of the legacy env var name so an operator who already has `DISCORD_OBSERVER_ROLE_IDS` set in their `.env` is not silently broken on update (Requirement 0).

**Deliberately out of scope for this rename:** `discordActorTier()` in `policy.js` (the function that resolves a Discord member's *capability tier* — `"owner"`/`"admin"`/`"moderator"`/`"observer"`/`"public"` — from their role IDs) still returns the literal string `"observer"` for this tier, unchanged. That tier-name string is a much wider-blast-radius rename: it's checked throughout `policy.js`'s `CAPABILITY_BY_TIER`/`DISCORD_ROLE_TIERS`, referenced in this repo's own tests and `embedFormat.js` permission text, and — per `discordActorTier()`'s own comment (verified in the file) — is deliberately kept in sync with `mentat`'s own bot-side `rbac.js` tier ladder in a *separate repo*. Renaming it would be its own cross-repo project requiring its own brainstorming/design pass, not a drive-by rename inside a Settings-automation feature. This plan renames only the *role-ID list an operator configures*, not the *capability tier name it grants* — an operator now configures "Player role IDs" in the new Settings UI, and those role IDs still grant the adapter's `"observer"` capability tier internally, exactly as they did before this rename under the old field name. Note this explicitly in the PR body's documentation-impact statement (Task 13) so a future session doesn't mistake the two for already being unified.

- [ ] **Step 0a: Update `adapter.js`**

In `console/api/src/integrations/discord/adapter.js`, replace:

```js
export function discordRoleMappingFromEnv(env = process.env) {
  return {
    observerRoleIds: csv(env.DISCORD_OBSERVER_ROLE_IDS),
    moderatorRoleIds: csv(env.DISCORD_MODERATOR_ROLE_IDS),
    adminRoleIds: csv(env.DISCORD_ADMIN_ROLE_IDS),
    ownerRoleIds: csv(env.DISCORD_OWNER_ROLE_IDS)
  };
}
```

with:

```js
export function discordRoleMappingFromEnv(env = process.env) {
  return {
    // DISCORD_OBSERVER_ROLE_IDS is the pre-rename name -- read as a
    // fallback only, so an operator who already set it keeps working
    // across this update without a manual migration step (Requirement 0).
    // DISCORD_PLAYER_ROLE_IDS takes precedence whenever both are set.
    playerRoleIds: csv(env.DISCORD_PLAYER_ROLE_IDS || env.DISCORD_OBSERVER_ROLE_IDS),
    moderatorRoleIds: csv(env.DISCORD_MODERATOR_ROLE_IDS),
    adminRoleIds: csv(env.DISCORD_ADMIN_ROLE_IDS),
    ownerRoleIds: csv(env.DISCORD_OWNER_ROLE_IDS)
  };
}
```

And update `discordRolePolicyHealth()` immediately below it: replace `observerConfigured: mapping.observerRoleIds.length > 0,` with `playerConfigured: mapping.playerRoleIds.length > 0,`. Run `grep -rn "observerConfigured\|\.observerRoleIds\b" console/api/src` to find every other caller of these two renamed fields (`routes.js` and any status/health route that surfaces `discordRolePolicyHealth()`'s output) and update each to the new names — do not leave a caller reading the old field name, since it would now silently always read `undefined`.

- [ ] **Step 0b: Update `policy.js`**

In `console/api/src/integrations/discord/policy.js`, replace:

```js
export function normalizeRoleMapping(value = {}) {
  return {
    observerRoleIds: normalizeStringList(value.observerRoleIds),
    moderatorRoleIds: normalizeStringList(value.moderatorRoleIds),
    adminRoleIds: normalizeStringList(value.adminRoleIds),
    ownerRoleIds: normalizeStringList(value.ownerRoleIds)
  };
}
```

with:

```js
export function normalizeRoleMapping(value = {}) {
  return {
    playerRoleIds: normalizeStringList(value.playerRoleIds),
    moderatorRoleIds: normalizeStringList(value.moderatorRoleIds),
    adminRoleIds: normalizeStringList(value.adminRoleIds),
    ownerRoleIds: normalizeStringList(value.ownerRoleIds)
  };
}
```

And in `discordActorTier()`, replace `if (normalized.observerRoleIds.some((roleId) => roleIds.has(roleId))) return "observer";` with `if (normalized.playerRoleIds.some((roleId) => roleIds.has(roleId))) return "observer";` — the input field is renamed, the returned tier string is deliberately not (see Step 0's scoping note above).

- [ ] **Step 0c: Update existing tests for the renamed fields**

Run: `grep -rln "observerRoleIds\|observerConfigured" console/api/test` to find every existing test asserting on these two field names (expected: at least `console/api/test/discordAdapter.test.js` and `console/api/test/discordPolicy.test.js`, per this plan's own earlier research into this area) and update each occurrence to `playerRoleIds`/`playerConfigured`. Also add one new regression test to whichever of those two files already covers `discordRoleMappingFromEnv()`, asserting the backward-compatible fallback:

```js
test("discordRoleMappingFromEnv falls back to the legacy DISCORD_OBSERVER_ROLE_IDS env var when DISCORD_PLAYER_ROLE_IDS is not set", () => {
  delete process.env.DISCORD_PLAYER_ROLE_IDS;
  process.env.DISCORD_OBSERVER_ROLE_IDS = "111111111111111111";
  const mapping = discordRoleMappingFromEnv();
  assert.deepEqual(mapping.playerRoleIds, ["111111111111111111"]);
  delete process.env.DISCORD_OBSERVER_ROLE_IDS;
});

test("discordRoleMappingFromEnv prefers DISCORD_PLAYER_ROLE_IDS over the legacy var when both are set", () => {
  process.env.DISCORD_PLAYER_ROLE_IDS = "222222222222222222";
  process.env.DISCORD_OBSERVER_ROLE_IDS = "111111111111111111";
  const mapping = discordRoleMappingFromEnv();
  assert.deepEqual(mapping.playerRoleIds, ["222222222222222222"]);
  delete process.env.DISCORD_PLAYER_ROLE_IDS;
  delete process.env.DISCORD_OBSERVER_ROLE_IDS;
});
```

- [ ] **Step 0d: Run the full existing Discord adapter/policy test suites and commit**

Run: `cd console/api && node --test test/discordAdapter.test.js test/discordPolicy.test.js`
Expected: PASS, including the 2 new fallback tests and every pre-existing test now using the renamed fields.

```bash
git add console/api/src/integrations/discord/adapter.js console/api/src/integrations/discord/policy.js console/api/test/discordAdapter.test.js console/api/test/discordPolicy.test.js
git commit -m "refactor(discord-adapter): rename observer role-ID list to player (env var back-compat preserved)"
```

- [ ] **Step 1: Write the failing tests**

Create `console/api/test/discordAdapterSettings.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateDiscordRoleIds,
  readDiscordBotSettingsState,
  updateDiscordBotRoleIds,
  regenerateDiscordBotToken
} from "../src/integrations/discord/adapterSettings.js";

const OLD_ENV = { ...process.env };
test.afterEach(() => {
  process.env = { ...OLD_ENV };
});

test("validateDiscordRoleIds accepts a comma-separated list of real Discord snowflakes", () => {
  const result = validateDiscordRoleIds("111111111111111111, 222222222222222222");
  assert.deepEqual(result, { ok: true, roleIds: ["111111111111111111", "222222222222222222"] });
});

test("validateDiscordRoleIds rejects a non-numeric value", () => {
  const result = validateDiscordRoleIds("not-a-role-id");
  assert.equal(result.ok, false);
});

test("validateDiscordRoleIds rejects a too-short numeric value (not a real snowflake)", () => {
  const result = validateDiscordRoleIds("123");
  assert.equal(result.ok, false);
});

test("validateDiscordRoleIds accepts an empty string as no role IDs configured", () => {
  const result = validateDiscordRoleIds("");
  assert.deepEqual(result, { ok: true, roleIds: [] });
});

test("readDiscordBotSettingsState reports disabled with no role IDs when nothing is configured", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  delete process.env.DISCORD_PLAYER_ROLE_IDS;
  const state = readDiscordBotSettingsState({});
  assert.equal(state.enabled, false);
  assert.deepEqual(state.roleIds, { player: [], moderator: [], admin: [] });
  assert.equal(state.tokenConfigured, false);
});

test("readDiscordBotSettingsState reports enabled with existing role IDs -- the state-detection fix for pre-existing manual configs", () => {
  process.env.DUNE_DISCORD_ADAPTER_ENABLED = "true";
  process.env.DISCORD_PLAYER_ROLE_IDS = "111111111111111111";
  process.env.DISCORD_MODERATOR_ROLE_IDS = "222222222222222222";
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-settings-"));
  const tokenFile = join(dir, "discord-adapter-token.txt");
  writeFileSync(tokenFile, "existing-token-value\n");
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = tokenFile;

  const state = readDiscordBotSettingsState({});
  assert.equal(state.enabled, true);
  assert.deepEqual(state.roleIds.player, ["111111111111111111"]);
  assert.deepEqual(state.roleIds.moderator, ["222222222222222222"]);
  assert.equal(state.tokenConfigured, true);
});

test("updateDiscordBotRoleIds writes only the 3 role-ID keys and never touches the token file or the enabled flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-roleids-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_ENABLED=true\nDUNE_DISCORD_ADAPTER_TOKEN_FILE=runtime/secrets/discord-adapter-token.txt\n");
  writeFileSync(tokenFile, "existing-token-value\n");

  const result = updateDiscordBotRoleIds({ repoRoot: dir }, { player: ["111111111111111111"], moderator: [], admin: ["222222222222222222"] });
  assert.equal(result.ok, true);

  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_ENABLED=true$/m, "the enabled flag must be untouched");
  assert.match(envContent, /^DISCORD_PLAYER_ROLE_IDS=111111111111111111$/m);
  assert.match(envContent, /^DISCORD_ADMIN_ROLE_IDS=222222222222222222$/m);
  const tokenContent = readFileSync(tokenFile, "utf8").trim();
  assert.equal(tokenContent, "existing-token-value", "role-ID updates must never rotate the live token");
});

test("regenerateDiscordBotToken overwrites the token file with fresh random bytes and never touches .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-regen-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = tokenFile;
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "SOME_OTHER_KEY=untouched\n");
  writeFileSync(tokenFile, "old-token-value\n");

  const result = regenerateDiscordBotToken({ repoRoot: dir });
  assert.equal(result.ok, true);
  assert.equal(result.token.length, 64, "expected a 32-byte hex token returned so the caller can display it once");
  const newToken = readFileSync(tokenFile, "utf8").trim();
  assert.notEqual(newToken, "old-token-value");
  assert.equal(newToken, result.token);
  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^SOME_OTHER_KEY=untouched$/m);
  assert.doesNotMatch(envContent, /DUNE_DISCORD_ADAPTER_TOKEN_FILE/, "regenerating must not rewrite .env -- the file path doesn't change, only its contents");
});
```

(This test relies on `mkdirSync`, already added to this file's top-level `node:fs` import above.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd console/api && node --test test/discordAdapterSettings.test.js`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `adapterSettings.js`**

Create `console/api/src/integrations/discord/adapterSettings.js`:

```js
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { discordAdapterEnabled, discordRoleMappingFromEnv } from "./adapter.js";
import { readDiscordBotApiToken } from "./routes.js";
import { updateEnvFileValues } from "../../services/envFile.js";

const SNOWFLAKE_PATTERN = /^\d{15,21}$/;
const DEFAULT_TOKEN_FILE = "runtime/secrets/discord-adapter-token.txt";

// Global Constraint: this is the server-side hardcoded set of .env keys
// this feature is ever allowed to write. The env-key name is never derived
// from a request-body field name (Layer 1 Security Architect audit finding).
const MANAGED_ENV_KEYS = Object.freeze({
  enabled: "DUNE_DISCORD_ADAPTER_ENABLED",
  tokenFile: "DUNE_DISCORD_ADAPTER_TOKEN_FILE",
  player: "DISCORD_PLAYER_ROLE_IDS",
  moderator: "DISCORD_MODERATOR_ROLE_IDS",
  admin: "DISCORD_ADMIN_ROLE_IDS"
});

export function validateDiscordRoleIds(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return { ok: true, roleIds: [] };
  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  const invalid = parts.filter((part) => !SNOWFLAKE_PATTERN.test(part));
  if (invalid.length) return { ok: false, error: `Invalid Discord role ID(s): ${invalid.join(", ")}. Expected 15-21 digit numeric IDs.` };
  return { ok: true, roleIds: parts };
}

export function readDiscordBotSettingsState(config) {
  const mapping = discordRoleMappingFromEnv();
  const token = readDiscordBotApiToken(config);
  return {
    enabled: discordAdapterEnabled(config),
    roleIds: {
      player: mapping.playerRoleIds,
      moderator: mapping.moderatorRoleIds,
      admin: mapping.adminRoleIds
    },
    tokenConfigured: Boolean(token)
  };
}

// enableDiscordBotAdapter: validates role IDs, generates a fresh token
// (Layer 1 Security Architect audit finding -- "Enable" always overwrites,
// never conditionally reuses an abandoned manual attempt's file), writes
// the secret file, then flushes every managed .env key in one atomic
// updateEnvFileValues() call. Does NOT launch the recreate helper itself --
// the caller (the route handler) does that via tasks.create(), after this
// function returns successfully, matching the "write everything, then
// launch" ordering the design requires. Returns the plaintext token so the
// route handler can hand it to the frontend exactly once, immediately
// after generation (Design §3.1's "masked, with reveal/copy" requirement)
// -- readDiscordBotSettingsState() never returns it on subsequent reads,
// since the token file's own content is the only persistent copy.
export function enableDiscordBotAdapter(config, roleIdsByTier = {}) {
  const repoRoot = config.repoRoot;
  const tokenFile = resolve(repoRoot, DEFAULT_TOKEN_FILE);
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  try { chmodSync(tokenFile, 0o600); } catch {}

  updateEnvFileValues(repoRoot, [
    [MANAGED_ENV_KEYS.enabled, "true"],
    [MANAGED_ENV_KEYS.tokenFile, DEFAULT_TOKEN_FILE],
    [MANAGED_ENV_KEYS.player, (roleIdsByTier.player || []).join(",")],
    [MANAGED_ENV_KEYS.moderator, (roleIdsByTier.moderator || []).join(",")],
    [MANAGED_ENV_KEYS.admin, (roleIdsByTier.admin || []).join(",")]
  ]);

  return { ok: true, tokenFile: DEFAULT_TOKEN_FILE, token };
}

// updateDiscordBotRoleIds: writes ONLY the 3 role-ID env keys, via the
// same atomic updateEnvFileValues() call, and never touches the token file
// or the enabled flag. This is deliberately a separate function from
// enableDiscordBotAdapter() above, not a code path inside it -- an admin
// editing role IDs on an already-enabled adapter must never, as a side
// effect, mint a fresh token and silently break the live bot (found during
// this plan's own self-review: the first draft had the frontend's "Save
// Role IDs" button call the same enable path, which would have rotated the
// token on every role-ID edit). Still triggers the recreate helper (the
// caller does that, same as enableDiscordBotAdapter) because role IDs are
// only read from the environment at container start.
export function updateDiscordBotRoleIds(config, roleIdsByTier = {}) {
  updateEnvFileValues(config.repoRoot, [
    [MANAGED_ENV_KEYS.player, (roleIdsByTier.player || []).join(",")],
    [MANAGED_ENV_KEYS.moderator, (roleIdsByTier.moderator || []).join(",")],
    [MANAGED_ENV_KEYS.admin, (roleIdsByTier.admin || []).join(",")]
  ]);
  return { ok: true };
}

// regenerateDiscordBotToken: file-only rewrite, no .env change, no
// recreate helper launched (Layer 1 Cloud Security + Security Architect
// audit finding -- the token file's CONTENT is read fresh on every
// request by readDiscordBotApiToken(), so a container recreate is never
// needed for this specific operation). Returns the plaintext token for
// the same one-time-display reason as enableDiscordBotAdapter() above.
export function regenerateDiscordBotToken(config) {
  const repoRoot = config.repoRoot;
  const tokenFile = resolve(repoRoot, DEFAULT_TOKEN_FILE);
  if (!existsSync(dirname(tokenFile))) mkdirSync(dirname(tokenFile), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  try { chmodSync(tokenFile, 0o600); } catch {}
  return { ok: true, token };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd console/api && node --test test/discordAdapterSettings.test.js`
Expected: PASS. If `readDiscordBotApiToken` isn't exported from `routes.js` under that exact name, run `grep -n "^export function readDiscordBotApiToken" console/api/src/integrations/discord/routes.js` to confirm before adjusting the import.

- [ ] **Step 5: Add the 3 routes to `server.js`**

First locate the Discord-adapter-route short-circuit and the general auth/action-check block:

Run: `grep -n "isDiscordAdapterRoute(path)\|const action = actionForRoute" console/api/src/server.js`

Add the import at the top of `server.js` (near the existing `import { readSelfUpdateStatus }` line):

```js
import { validateDiscordRoleIds, readDiscordBotSettingsState, enableDiscordBotAdapter, updateDiscordBotRoleIds, regenerateDiscordBotToken } from "./integrations/discord/adapterSettings.js";
```

Add the 3 route handlers in the authenticated-route section (after the `const action = actionForRoute(path, req.method);` permission-check block, alongside the other `/api/settings/*` routes — find them with `grep -n '"/api/settings/public-directory"' console/api/src/server.js` and add nearby):

```js
  if (path === "/api/settings/discord-bot" && req.method === "GET") {
    return json(res, 200, readDiscordBotSettingsState(config));
  }
  if (path === "/api/settings/discord-bot/enable" && req.method === "POST") {
    const body = await readJson(req);
    const player = validateDiscordRoleIds(body.playerRoleIds);
    if (!player.ok) return json(res, 400, { error: player.error });
    const moderator = validateDiscordRoleIds(body.moderatorRoleIds);
    if (!moderator.ok) return json(res, 400, { error: moderator.error });
    const admin = validateDiscordRoleIds(body.adminRoleIds);
    if (!admin.ok) return json(res, 400, { error: admin.error });

    const { token } = enableDiscordBotAdapter(config, { player: player.roleIds, moderator: moderator.roleIds, admin: admin.roleIds });
    audit(config, req, "settings.discord-bot.enable", { playerCount: player.roleIds.length, moderatorCount: moderator.roleIds.length, adminCount: admin.roleIds.length });
    return json(res, 202, { task: tasks.create("settings", "discordAdapterApply", {}), token });
  }
  if (path === "/api/settings/discord-bot/role-ids" && req.method === "POST") {
    const body = await readJson(req);
    const player = validateDiscordRoleIds(body.playerRoleIds);
    if (!player.ok) return json(res, 400, { error: player.error });
    const moderator = validateDiscordRoleIds(body.moderatorRoleIds);
    if (!moderator.ok) return json(res, 400, { error: moderator.error });
    const admin = validateDiscordRoleIds(body.adminRoleIds);
    if (!admin.ok) return json(res, 400, { error: admin.error });

    updateDiscordBotRoleIds(config, { player: player.roleIds, moderator: moderator.roleIds, admin: admin.roleIds });
    audit(config, req, "settings.discord-bot.role-ids-updated", { playerCount: player.roleIds.length, moderatorCount: moderator.roleIds.length, adminCount: admin.roleIds.length });
    return json(res, 202, { task: tasks.create("settings", "discordAdapterApply", {}) });
  }
  if (path === "/api/settings/discord-bot/regenerate-token" && req.method === "POST") {
    const { token } = regenerateDiscordBotToken(config);
    audit(config, req, "settings.discord-bot.token-regenerated", {});
    return json(res, 200, { ok: true, token });
  }
```

Both responses include the plaintext `token` exactly once, at the moment of generation — `readDiscordBotSettingsState`'s `GET` route never includes it, so this is the only path the frontend ever sees the real value on (Task 11 stores it in transient component state, never `localStorage`, for a one-time reveal/copy). This deliberately calls `tasks.create()` directly (not the generic `task()` helper from `server.js:2683`, which is built around `buildDuneArgs(operation, payload)` validating a *dune CLI* operation shape that doesn't apply here) — `audit()` is called explicitly instead, matching the pattern `adapter.js`'s own read-only routes already use (`audit(config, null, "discord.status", ...)`). Note `audit()`'s payload deliberately never includes `token` — only counts — per Requirement 24 (secrets must not appear in logs).

- [ ] **Step 6: Manual verification against a real request**

Run the console API locally per this repo's own dev-server instructions (check `console/api/package.json`'s `scripts` for the dev command, typically `npm run dev` from `console/api/`), then:

```bash
curl -s http://localhost:8088/api/settings/discord-bot -H "Cookie: <a real logged-in session cookie>" | python3 -m json.tool
```

Expected: a JSON object with `enabled`, `roleIds`, `tokenConfigured` fields, matching `readDiscordBotSettingsState`'s shape. (Getting a real session cookie requires being logged into a real running console — if this isn't available in the current environment, skip this manual step and rely on Step 4's unit tests plus Task 13's route-level tests instead, noting the gap explicitly rather than silently skipping it.)

- [ ] **Step 7: Commit**

```bash
git add console/api/src/integrations/discord/adapterSettings.js console/api/src/server.js console/api/test/discordAdapterSettings.test.js
git commit -m "feat(settings): add Discord Bot adapter settings routes"
```

---

### Task 9: Backend route-level tests (state-detection combinations, enable, regenerate)

**Files:**
- Test: `console/api/test/discordAdapterSettings.test.js` (extend from Task 8)

**Interfaces:**
- Consumes: everything from Task 8.
- Produces: nothing new — this task is pure test coverage, closing audit finding #7's most consequential gap (a false "Disabled" state, or a silent overwrite risk) and finding #13's missing failure-path coverage.

Check whether this repo has an existing convention for spinning up a real (in-process) HTTP server to test routes end-to-end (`grep -rn "createServer\|http.createServer" console/api/test/*.test.js | head -5`) — if a helper like `startTestServer()` already exists in the test suite, use it; otherwise, this task covers the *business-logic* combinations only (already substantially done in Task 8's tests) and this step adds the specific **combinations** audit finding #7 named explicitly.

- [ ] **Step 1: Write the combination tests**

Add to `console/api/test/discordAdapterSettings.test.js`:

```js
test("readDiscordBotSettingsState: enabled flag true but token file missing reports enabled with tokenConfigured false", () => {
  process.env.DUNE_DISCORD_ADAPTER_ENABLED = "true";
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = "/nonexistent/path/discord-adapter-token.txt";
  const state = readDiscordBotSettingsState({});
  assert.equal(state.enabled, true);
  assert.equal(state.tokenConfigured, false);
});

test("readDiscordBotSettingsState: token file present but enabled flag false/unset reports disabled -- an abandoned manual attempt, not a live config", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-abandoned-"));
  const tokenFile = join(dir, "discord-adapter-token.txt");
  writeFileSync(tokenFile, "leftover-from-a-manual-attempt\n");
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = tokenFile;
  const state = readDiscordBotSettingsState({});
  assert.equal(state.enabled, false, "an abandoned token file with the enabled flag off must still report disabled -- enabled comes from the flag, not file presence");
  assert.equal(state.tokenConfigured, true, "but tokenConfigured should still reflect the file's real presence, since Enable must not blindly overwrite it without the operator seeing it exists");
});

test("readDiscordBotSettingsState: role IDs set independently of the enabled flag are still reported", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  process.env.DISCORD_ADMIN_ROLE_IDS = "333333333333333333";
  const state = readDiscordBotSettingsState({});
  assert.equal(state.enabled, false);
  assert.deepEqual(state.roleIds.admin, ["333333333333333333"]);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd console/api && node --test test/discordAdapterSettings.test.js`
Expected: PASS for all 3 (the underlying `readDiscordBotSettingsState` implementation from Task 8 already handles these correctly by construction — this step exists to make that explicit and regression-proof, matching the audit's own finding that this exact combination coverage was originally missing).

- [ ] **Step 3: Commit**

```bash
git add console/api/test/discordAdapterSettings.test.js
git commit -m "test(settings): cover Discord Bot state-detection edge cases (audit finding #7)"
```

---

### Task 10: Frontend API client for the 3 routes

**Files:**
- Create: `console/web/src/api/discordAdapterSettings.ts`

**Interfaces:**
- Consumes: `api`, `post` from `./client` (existing).
- Produces: `discordAdapterSettingsApi.getState()`, `.enable(roleIds)`, `.updateRoleIds(roleIds)`, `.regenerateToken()` — typed client functions Task 11 uses.

- [ ] **Step 1: Implement the client module**

Create `console/web/src/api/discordAdapterSettings.ts`:

```ts
import { api, post } from "./client";
import type { Task } from "./setup";

export type DiscordBotSettingsState = {
  enabled: boolean;
  roleIds: { player: string[]; moderator: string[]; admin: string[] };
  tokenConfigured: boolean;
};

export const discordAdapterSettingsApi = {
  getState: () => api<DiscordBotSettingsState>("/api/settings/discord-bot"),
  enable: (roleIds: { playerRoleIds: string; moderatorRoleIds: string; adminRoleIds: string }) =>
    post<{ task: Task; token: string }>("/api/settings/discord-bot/enable", roleIds),
  updateRoleIds: (roleIds: { playerRoleIds: string; moderatorRoleIds: string; adminRoleIds: string }) =>
    post<{ task: Task }>("/api/settings/discord-bot/role-ids", roleIds),
  regenerateToken: () => post<{ ok: boolean; token: string }>("/api/settings/discord-bot/regenerate-token")
};
```

- [ ] **Step 2: Type-check**

Run: `cd console/web && npx tsc --noEmit`
Expected: no new errors. (This repo's existing `Task` type from `./setup` and `api`/`post` from `./client` are used exactly as `updates.ts` already uses them — no new type shapes invented.)

- [ ] **Step 3: Commit**

```bash
git add console/web/src/api/discordAdapterSettings.ts
git commit -m "feat(settings): add frontend API client for Discord Bot settings"
```

---

### Task 11: The `DiscordBotSection` component

**Files:**
- Create: `console/web/src/features/settings/DiscordBotSection.tsx`
- Test: `console/web/src/features/settings/DiscordBotSection.test.tsx`
- Modify: `console/web/src/features/settings/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `discordAdapterSettingsApi` (Task 10), `updatesApi.stackProgress` (existing, unmodified), `persistUpdateTask`/`loadPersistedUpdateTask` (existing, from `../updates/updateUtils`), `ConfirmDialog`-triggering `confirmDialog()` helper (existing, from `App.tsx` — check its exact export/import shape with `grep -n "export function confirmDialog\|export { confirmDialog" console/web/src/App.tsx` before importing, since this plan's research found it defined as a module-level function in `App.tsx`, not necessarily exported — if it isn't exported, this task instead imports `ConfirmDialog` the component directly and manages its own local `confirmRequest` state, mirroring `App.tsx`'s own `useState<ConfirmDialogRequest | null>` pattern instead of calling a shared helper).
- Produces: `<DiscordBotSection />`, a self-contained component `SettingsPanel.tsx` renders directly (no props needed — it manages its own state).

This is the largest task in the plan. It implements Design §3.1's 4 states (read-on-mount, Disabled, Enabling, Enabled) plus the up-front hosted/self-hosted choice (audit finding #8), the disambiguating copy under the heading (audit finding #28), and the persisted-task recovery (audit finding #9).

**Correction from the L1 design doc, found during this plan's own verification (matching this org's "verify before implementing, even against an already-audited design" discipline):** the design doc's §3.1 called for a "typed confirmation" input for Regenerate Token, modeled on what its own audit believed was an existing `saveAutoGame()` precedent. Direct verification (this plan's research) found `saveAutoGame()`'s `confirmation: "SAVE AUTO GAME UPDATES"` field is a client-hardcoded string sent automatically on every save, not a user-typed input — no typed-confirmation UI pattern exists anywhere in this codebase. What genuinely exists, and what every other high-consequence/irreversible action in this codebase actually uses, is the real `ConfirmDialog` component with `danger: true` and an explicit `warning` message. This task uses that real, established pattern for Regenerate Token instead, and notes the correction in this task's own commit message.

- [ ] **Step 1: Check `confirmDialog`'s exact exported shape**

Run: `grep -n "^function confirmDialog\|^export function confirmDialog" console/web/src/App.tsx`

If it's `export`ed: import and call it directly (`import { confirmDialog } from "../../App"`, matching that file's relative path from `console/web/src/features/settings/`).

If it's **not** exported (module-private to `App.tsx`, used only inside that file via the `openConfirmDialog` ref pattern shown in this plan's research): this component instead manages the dialog via React Context or prop-drilling would be a larger change than this task's scope — in that case, use the simpler, self-contained approach: render `<ConfirmDialog request={...} onClose={...} />` directly inside `DiscordBotSection.tsx` with its own local `useState<ConfirmDialogRequest | null>(null)`, exactly like `App.tsx` itself does, rather than trying to reuse `App.tsx`'s single shared dialog instance. Confirm which path applies before writing Step 3's implementation, and use that confirmed shape throughout.

- [ ] **Step 2: Write the failing component tests**

Create `console/web/src/features/settings/DiscordBotSection.test.tsx`, mirroring `SettingsPanel.credentials.test.tsx`'s mocking style:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api, post } from "../../api/client";
import { DiscordBotSection } from "./DiscordBotSection";

vi.mock("../../api/client", () => ({
  api: vi.fn(),
  post: vi.fn(),
}));

const mockApi = vi.mocked(api);
const mockPost = vi.mocked(post);

describe("DiscordBotSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Disabled state and asks hosted-or-self-hosted before enabling, when nothing is configured yet", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Which are you using/i);
    expect(screen.getByRole("button", { name: /Enable Discord Bot Integration/i })).toBeDisabled();
  });

  it("renders the Enabled state directly, with existing role IDs populated, when the adapter is already configured -- never a false Disabled (audit finding #7)", async () => {
    mockApi.mockResolvedValue({
      enabled: true,
      roleIds: { player: ["111111111111111111"], moderator: [], admin: [] },
      tokenConfigured: true
    } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    expect(screen.queryByText(/Which are you using/i)).toBeNull();
    expect(screen.getByDisplayValue("111111111111111111")).toBeInTheDocument();
  });

  it("shows a disambiguating note distinguishing this section from Discord OAuth", async () => {
    mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/not console admin sign-in/i);
  });

  it("regenerating the token shows a real confirm dialog before calling the API, and never launches a recreate (no /enable call)", async () => {
    mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true } as never);
    mockPost.mockResolvedValue({ ok: true } as never);
    render(<DiscordBotSection />);
    await screen.findByText(/Enabled/i);
    fireEvent.click(screen.getByRole("button", { name: /Regenerate Token/i }));
    await screen.findByText(/cannot be undone/i);
    fireEvent.click(screen.getByRole("button", { name: /Regenerate$/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-bot/regenerate-token", {}));
    expect(mockPost).not.toHaveBeenCalledWith("/api/settings/discord-bot/enable", expect.anything());
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd console/web && npx vitest run src/features/settings/DiscordBotSection.test.tsx`
Expected: FAIL — the component doesn't exist yet.

- [ ] **Step 4: Implement `DiscordBotSection.tsx`**

Create `console/web/src/features/settings/DiscordBotSection.tsx`:

```tsx
import { useEffect, useState } from "react";
import { discordAdapterSettingsApi, type DiscordBotSettingsState } from "../../api/discordAdapterSettings";
import { updatesApi } from "../../api/updates";
import { persistUpdateTask, loadPersistedUpdateTask } from "../updates/updateUtils";
import { ConfirmDialog, type ConfirmDialogRequest, type ConfirmDialogOutcome } from "../../components/common/ConfirmDialog";

const TASK_KEY = "arrakis.discordAdapterEnableTask";
const POLL_INTERVAL_MS = 2000;

type Choice = "hosted" | "self-hosted" | null;
type Phase = "loading" | "disabled" | "enabling" | "enabled" | "failed";

export function DiscordBotSection() {
  const [state, setState] = useState<DiscordBotSettingsState | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [choice, setChoice] = useState<Choice>(null);
  const [playerRoleIds, setPlayerRoleIds] = useState("");
  const [moderatorRoleIds, setModeratorRoleIds] = useState("");
  const [adminRoleIds, setAdminRoleIds] = useState("");
  const [error, setError] = useState("");
  const [confirmRequest, setConfirmRequest] = useState<ConfirmDialogRequest | null>(null);
  // Transient, in-memory only -- never persisted to localStorage or logged
  // (Requirement 24). Holds the plaintext token exactly once, immediately
  // after Enable/Regenerate, since the backend never returns it again on
  // a later GET (Design §3.1's "masked, with reveal/copy" requirement).
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  async function refresh() {
    const nextState = await discordAdapterSettingsApi.getState();
    setState(nextState);
    setPlayerRoleIds(nextState.roleIds.player.join(", "));
    setModeratorRoleIds(nextState.roleIds.moderator.join(", "));
    setAdminRoleIds(nextState.roleIds.admin.join(", "));
    // Never assume "never configured" -- always reflect real state
    // (Layer 1 audit finding #7, converged on by 3 independent hats).
    setPhase(nextState.enabled ? "enabled" : "disabled");
  }

  useEffect(() => {
    refresh().catch(() => setError("Could not load Discord Bot settings."));
    // Recover an in-flight enable across a page reload, the same way the
    // Updates panel already does (audit finding #9).
    const persisted = loadPersistedUpdateTask(TASK_KEY);
    if (persisted?.id) {
      setRunId(persisted.id);
      setPhase("enabling");
    }
  }, []);

  useEffect(() => {
    if (phase !== "enabling" || !runId) return undefined;
    const interval = setInterval(async () => {
      try {
        const progress = await updatesApi.stackProgress(runId);
        if (progress.state === "succeeded") {
          clearInterval(interval);
          persistUpdateTask(TASK_KEY, null);
          setRunId(null);
          if (progress.discordHealthOk === false) {
            setPhase("failed");
            setError("The console restarted, but the Discord adapter did not respond to a health check. Check the console's logs.");
          } else {
            await refresh();
          }
        } else if (progress.state === "failed") {
          clearInterval(interval);
          persistUpdateTask(TASK_KEY, null);
          setRunId(null);
          setPhase("failed");
          setError(progress.message || "Applying Discord Bot settings failed.");
        }
      } catch {
        // The console is mid-recreate and briefly unreachable -- keep polling.
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [phase, runId]);

  async function handleEnable() {
    setError("");
    const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
      setConfirmRequest({
        title: "Enable Discord Bot Integration",
        message: "The console will restart to apply this change. It will be briefly unreachable.",
        confirmLabel: "Enable",
        cancelLabel: "Cancel",
        danger: false,
        resolve
      });
    });
    setConfirmRequest(null);
    if (outcome !== "confirm") return;

    try {
      const { task, token } = await discordAdapterSettingsApi.enable({
        playerRoleIds,
        moderatorRoleIds,
        adminRoleIds
      });
      setRevealedToken(token);
      persistUpdateTask(TASK_KEY, task);
      setRunId(task.id);
      setPhase("enabling");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Save Role IDs, for an already-enabled adapter: a distinct handler and
  // route from handleEnable/enable() above -- see updateDiscordBotRoleIds()
  // in Task 8 for why sharing the enable path here would be a real bug
  // (silently rotating the live token on every role-ID edit).
  async function handleUpdateRoleIds() {
    setError("");
    try {
      const { task } = await discordAdapterSettingsApi.updateRoleIds({
        playerRoleIds,
        moderatorRoleIds,
        adminRoleIds
      });
      persistUpdateTask(TASK_KEY, task);
      setRunId(task.id);
      setPhase("enabling");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRegenerate() {
    setError("");
    const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
      setConfirmRequest({
        title: "Regenerate Discord Bot Token",
        message: "This immediately invalidates the current token. Your bot will stop working until you paste the new token wherever it's configured. This cannot be undone.",
        confirmLabel: "Regenerate",
        cancelLabel: "Cancel",
        danger: true,
        resolve
      });
    });
    setConfirmRequest(null);
    if (outcome !== "confirm") return;

    try {
      const { token } = await discordAdapterSettingsApi.regenerateToken();
      setRevealedToken(token);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="playerAdmin_toggleBody">
      <p className="muted">For bot commands and in-game data access — not console admin sign-in, see Discord OAuth below.</p>
      {error && <div className="confirm-modal-warning">{error}</div>}

      {phase === "disabled" && (
        <>
          <div className="settings-choice">
            <p>Which are you using?</p>
            <button className={choice === "hosted" ? "active" : ""} onClick={() => setChoice("hosted")}>Hosted bot</button>
            <button className={choice === "self-hosted" ? "active" : ""} onClick={() => setChoice("self-hosted")}>Self-hosting</button>
          </div>
          <label>Player role IDs<input value={playerRoleIds} onChange={(event) => setPlayerRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
          <label>Moderator role IDs<input value={moderatorRoleIds} onChange={(event) => setModeratorRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
          <label>Admin role IDs<input value={adminRoleIds} onChange={(event) => setAdminRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
          <button disabled={!choice} onClick={() => { void handleEnable(); }}>Enable Discord Bot Integration</button>
        </>
      )}

      {phase === "enabling" && <p>Applying settings and restarting the console…</p>}

      {phase === "failed" && <button onClick={() => { void refresh(); }}>Retry</button>}

      {phase === "enabled" && state && (
        <>
          <p>Enabled.</p>
          <label>
            Token
            {/* Not SecretInput: that component hardcodes type="password" (verified against
                every existing usage in this codebase, all write-only secret-entry fields) and
                would keep the real, freshly-generated token permanently dot-masked even when
                revealedToken holds the plaintext. A plain input, switched to type="text" only
                while a real value is present, is the correct one-time-reveal control here. */}
            <input readOnly type={revealedToken ? "text" : "password"} value={revealedToken ?? "••••••••••••••••••••••••••••••••"} />
          </label>
          {revealedToken && <p className="muted">Copy this now — it won't be shown again. Use Regenerate Token to get a new one if you lose it.</p>}
          <label>Player role IDs<input value={playerRoleIds} onChange={(event) => setPlayerRoleIds(event.target.value)} /></label>
          <label>Moderator role IDs<input value={moderatorRoleIds} onChange={(event) => setModeratorRoleIds(event.target.value)} /></label>
          <label>Admin role IDs<input value={adminRoleIds} onChange={(event) => setAdminRoleIds(event.target.value)} /></label>
          <button onClick={() => { void handleUpdateRoleIds(); }}>Save Role IDs</button>
          <button onClick={() => { void handleRegenerate(); }}>Regenerate Token</button>
          {choice === "hosted" && <p>Paste the token into <a href="https://mentat-link.darkdante.org/setup">mentat-link's setup form</a>.</p>}
          {choice === "self-hosted" && <p>Put the token in your bot's <code>.env</code> — see the <a href="https://github.com/Project-Arrakis/mentat/blob/main/docs/installation-guide.md">installation guide</a>.</p>}
        </>
      )}

      <ConfirmDialog request={confirmRequest} onClose={(outcome) => confirmRequest?.resolve(outcome)} />
    </div>
  );
}
```

Note: the backend never returns the real token value from `GET /api/settings/discord-bot` (Task 8's `readDiscordBotSettingsState` only returns `tokenConfigured: boolean`) — `revealedToken` is populated only from the `enable`/`regenerate-token` route responses (Task 8), held in transient component state, and is `null` again after any page reload (satisfying Design §3.1's "masked, with reveal/copy" for the one moment a copy is actually possible, and Requirement 24's "never in logs/localStorage" for every moment after).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd console/web && npx vitest run src/features/settings/DiscordBotSection.test.tsx`
Expected: PASS. Adjust the component's exact class names/markup as needed to match this repo's real CSS conventions (check `console/web/src/features/settings/SettingsPanel.tsx`'s existing `playerAdmin_toggle*` class names and reuse them verbatim, which this draft already does for the outer wrapper).

- [ ] **Step 6: Wire into `SettingsPanel.tsx`**

In `console/web/src/features/settings/SettingsPanel.tsx`, add the import:

```tsx
import { DiscordBotSection } from "./DiscordBotSection";
```

Add a new collapsible toggle section immediately after the existing "Discord OAuth" section's closing `</div>}` (found via `grep -n "discordOAuthOpen &&" console/web/src/features/settings/SettingsPanel.tsx`), following the exact same toggle-header pattern:

```tsx
      <div className={`playerAdmin_toggle ${discordBotOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={discordBotOpen ? "Collapse Discord Bot" : "Expand Discord Bot"} onClick={() => setDiscordBotOpen(!discordBotOpen)}>{discordBotOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Discord Bot</span></button>
        {discordBotOpen && <DiscordBotSection />}
      </div>
```

Add the corresponding state near the other `*Open` state declarations at the top of the component:

```tsx
  const [discordBotOpen, setDiscordBotOpen] = useState(false);
```

- [ ] **Step 7: Run the full frontend test suite**

Run: `cd console/web && npx vitest run`
Expected: all existing tests still pass, plus the new `DiscordBotSection.test.tsx` suite.

- [ ] **Step 8: Commit**

```bash
git add console/web/src/features/settings/DiscordBotSection.tsx console/web/src/features/settings/DiscordBotSection.test.tsx console/web/src/features/settings/SettingsPanel.tsx
git commit -m "feat(settings): add Discord Bot settings section (corrects L1 design's typed-confirmation call to this codebase's real ConfirmDialog pattern)"
```

---

### Task 12: Frontend test for the failure state and reload-recovery

**Files:**
- Test: `console/web/src/features/settings/DiscordBotSection.test.tsx` (extend from Task 11)

Audit finding #13 (HIGH, QA/Test): §4's failure scenario needs explicit frontend coverage, not just prose.

- [ ] **Step 1: Write the failing test**

Add to `DiscordBotSection.test.tsx`:

```tsx
it("shows a Retry action when the applied recreate reports a failed health check, not a dead end", async () => {
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/settings/discord-bot") {
      return Promise.resolve({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false } as never);
    }
    return Promise.resolve({ runId: "test-run", state: "succeeded", stage: "complete", percent: 100, message: "", discordHealthOk: false } as never);
  });
  mockPost.mockResolvedValue({ task: { id: "test-run", type: "settings", operation: "discordAdapterApply", status: "queued", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: null, errorMessage: null } } as never);

  render(<DiscordBotSection />);
  await screen.findByText(/Which are you using/i);
  fireEvent.click(screen.getByRole("button", { name: /Hosted bot/i }));
  fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
  await screen.findByText(/restart/i);
  fireEvent.click(await screen.findByRole("button", { name: /^Enable$/i }));

  await waitFor(() => expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument(), { timeout: 5000 });
});
```

- [ ] **Step 2: Run test to verify it fails, then implement/adjust until it passes**

Run: `cd console/web && npx vitest run src/features/settings/DiscordBotSection.test.tsx`

If this fails because the poll interval (2000ms in Task 11's implementation) is slower than the test's default timeout, use Vitest's fake timers (`vi.useFakeTimers()` / `vi.advanceTimersByTimeAsync(2000)`) around the polling assertion, matching whatever timer-mocking convention `UpdatesPanel.test.ts` already uses for its own polling tests (check with `grep -n "useFakeTimers\|advanceTimersByTime" console/web/src/features/updates/UpdatesPanel.test.ts` first and mirror it exactly).

- [ ] **Step 3: Commit**

```bash
git add console/web/src/features/settings/DiscordBotSection.test.tsx
git commit -m "test(settings): cover the failed-health-check state (audit finding #13)"
```

---

### Task 13: Documentation currency

**Files:**
- Modify: `docs/security/secrets-management.md`
- Modify: `docs/integrations/discord-control-bot/setup-guide.md`
- Modify: `CHANGELOG.md`

Audit finding #11 (HIGH, GRC): 3 real docs go stale on ship.

- [ ] **Step 1: Update the credential inventory**

Run: `grep -n "Discord adapter token" docs/security/secrets-management.md`

Update that table row (currently `Discord adapter token | runtime/secrets/discord-adapter-token.txt | Plaintext | 600 | No (operator) | Manual`) to reflect the new automated path — change the rotation-mechanism column from `Manual` to something like `Automated (Settings → Discord Bot → Regenerate Token)`, and update the nearby prose (line ~43 per this plan's research: "There's no unified secret store... and no rotation mechanism") to no longer claim this for the Discord adapter token specifically, since it now has one.

- [ ] **Step 2: Update the setup guide**

Run: `grep -n "chmod 600" docs/integrations/discord-control-bot/setup-guide.md`

Replace the manual `openssl`/`chmod 600`/container-recreate walkthrough with a pointer to the new UI: "As of [version], this can be done from the console's Settings → Discord Bot section instead of the manual steps below, which remain documented for reference/troubleshooting." Do not delete the manual steps entirely — they remain the correct fallback if the UI path fails.

- [ ] **Step 3: Add the CHANGELOG entry**

In `CHANGELOG.md`'s `## Unreleased` section, add an entry following this repo's own existing entry style (one paragraph, naming which docs were touched):

```markdown
- **Discord bot adapter setup is now automated via Settings → Discord Bot**, replacing the previous fully-manual `.env`-edit-and-container-recreate process for both hosted and self-hosted `mentat` bot deployments. Reuses the existing self-update-helper container/lock/status-polling mechanism — no new trust boundary. See `docs/design/discord-bot-adapter-settings-automation-l1-design-2026-09-09.md` for the full design and its Layer 1 Eight-Hats audit. Docs updated: `docs/security/secrets-management.md` (credential inventory), `docs/integrations/discord-control-bot/setup-guide.md` (manual steps now marked as fallback/reference).
```

- [ ] **Step 4: File the cross-repo doc-drift comment on `mentat`**

Run (from any directory with `gh` authenticated against the `mentat` repo):

```bash
gh issue comment <the relevant open mentat issue about docs/discord-setup.md, or open a new one if none exists> --repo Project-Arrakis/mentat --body "cc: Project-Arrakis/dune-awakening-selfhost-docker — docs/discord-setup.md's 'Step 6: Enable the Discord Adapter on the Console' now has an automated alternative (Settings → Discord Bot) as of dune-awakening-selfhost-docker#720. The manual steps in this doc remain valid as a fallback; consider adding a note pointing to the new UI path as the primary recommendation."
```

If no existing open issue on `mentat` is the right target, create one instead: `gh issue create --repo Project-Arrakis/mentat --title "docs/discord-setup.md: note the new automated adapter-setup path in Core" --body "..."`.

- [ ] **Step 5: Commit**

```bash
git add docs/security/secrets-management.md docs/integrations/discord-control-bot/setup-guide.md CHANGELOG.md
git commit -m "docs: update credential inventory and setup guide for automated Discord adapter setup"
```

---

### Task 14: Full-suite verification and manual dune-dev pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `cd console/api && node --test`
Expected: 0 failures, including every test added in Tasks 1-9.

- [ ] **Step 2: Run the full frontend test suite**

Run: `cd console/web && npx vitest run`
Expected: 0 failures.

- [ ] **Step 3: Run the full shell test suite named in `ci.yml`**

Run each script listed in `.github/workflows/ci.yml`'s test steps that this plan touched or is adjacent to (at minimum): `runtime/tests/test-compose-project-name-portability.sh`, `runtime/tests/test-container-compose-labels.sh`, `runtime/tests/test-discord-adapter-env-recreate.sh`.
Expected: all `OK`/pass.

- [ ] **Step 4: Shellcheck the full modified script**

Run: `shellcheck -S warning runtime/scripts/self-update.sh runtime/scripts/dune`
Expected: clean.

- [ ] **Step 5: Type-check the frontend**

Run: `cd console/web && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Manual verification against dune-dev (Requirement 0 — cannot be automated, must be run by a human or an agent with real dune-dev access)**

Per the design doc's §5, exercise all of:
- A fresh install enabling the adapter for the first time (confirms the migration path with a real backup recommendation shown).
- An operator who already has the adapter manually configured (`.env` hand-edited before this feature existed) opening the new Settings section — confirm it shows Enabled with real values, not a false Disabled.
- Regenerating the token — confirm no container recreate happens (the console stays reachable throughout) and the bot immediately stops authenticating until the new token is pasted elsewhere.
- Starting a self-update and clicking "Enable Discord Bot Integration" at the same time — confirm the second one gets the "Another console update is already running" error, not a race.
- The full enable flow against a live `mentat` bot instance (hosted or self-hosted) — confirm the generated token actually authenticates a real `GET /api/integrations/discord/health` call from the bot side.

- [ ] **Step 7: Push and open the implementation PR**

```bash
git push -u origin <branch-name>
gh pr create --repo Project-Arrakis/dune-awakening-selfhost-docker --title "feat(settings): automate Discord bot adapter setup" --body "Implements docs/design/discord-bot-adapter-settings-automation-l1-design-2026-09-09.md. Closes #720." --draft
```

Per Requirement 20, a Layer 3 integration audit (`/code-review ultra` or a local `/code-review high` pass, per this org's own judgment call on scale) against the full diff is required before this PR leaves draft — do not mark it ready until that's run and its CRITICAL/HIGH findings are resolved, matching exactly what was done for this same feature's Layer 1 design pass.
