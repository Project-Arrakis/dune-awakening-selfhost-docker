import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateDiscordRoleIds,
  readDiscordBotSettingsState,
  enableDiscordBotAdapter,
  updateDiscordBotRoleIds,
  regenerateDiscordBotToken,
  applyDiscordBotEnableRequest,
  discordAdminRoleIdsChanged
} from "../src/integrations/discord/adapterSettings.js";
import { readDiscordBotApiToken } from "../src/integrations/discord/routes.js";

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

test("regenerateDiscordBotToken overwrites the token file with fresh random bytes, and (idempotently) writes the token FILE PATH in .env to the canonical default (Finding 2)", () => {
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
  // Finding 2 (IMPORTANT, final review): regenerate must (re-)write the
  // token FILE PATH key to the canonical default, idempotently -- see the
  // dedicated Finding 2 test below for the exact scenario this closes (an
  // operator with only the legacy DUNE_BOT_API_TOKEN_FILE set). This
  // assertion previously required the opposite (no rewrite at all); that
  // was the bug -- see this test's git history for the pre-fix version.
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_TOKEN_FILE="runtime\/secrets\/discord-adapter-token\.txt"$/m, "regenerate must ensure the token FILE PATH key in .env points at the canonical default, so it can never lose precedence to a legacy DUNE_BOT_API_TOKEN_FILE");
});

// Finding 2 (IMPORTANT, final review): regenerateDiscordBotToken() rewrote
// the token file's CONTENT but never wrote the token FILE PATH
// (DUNE_DISCORD_ADAPTER_TOKEN_FILE) key to .env or process.env. An operator
// whose .env has ONLY the legacy DUNE_BOT_API_TOKEN_FILE set (no
// DUNE_DISCORD_ADAPTER_TOKEN_FILE at all -- a real, documented manual-setup
// path that predates this feature) clicks Regenerate Token, is shown a
// fresh token, but readDiscordBotApiToken()'s precedence chain
// (DUNE_DISCORD_ADAPTER_TOKEN_FILE || DUNE_BOT_API_TOKEN_FILE) still falls
// through to the untouched legacy var, which still points at the OLD file
// -- the new token is never actually used to authenticate.
test("regenerateDiscordBotToken makes the fresh token authoritative even when only the legacy DUNE_BOT_API_TOKEN_FILE was previously configured (Finding 2)", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE;
  delete process.env.DUNE_DISCORD_ADAPTER_TOKEN;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-regen-legacy-file-"));
  const legacyTokenFile = join(dir, "old-manual-token.txt");
  writeFileSync(legacyTokenFile, "old-manual-token-value\n");
  writeFileSync(join(dir, ".env"), `DUNE_BOT_API_TOKEN_FILE=${legacyTokenFile}\n`);
  process.env.DUNE_BOT_API_TOKEN_FILE = legacyTokenFile;

  const result = regenerateDiscordBotToken({ repoRoot: dir });
  assert.equal(result.ok, true);

  // The exact scenario that was silently broken: read the token back
  // through the SAME function the live adapter route uses to authenticate
  // requests, in the SAME process, with no restart in between.
  const resolvedToken = readDiscordBotApiToken({ repoRoot: dir });
  assert.equal(resolvedToken, result.token, "the freshly-minted token must be authoritative, not the stale value at the legacy DUNE_BOT_API_TOKEN_FILE path");

  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_TOKEN_FILE="runtime\/secrets\/discord-adapter-token\.txt"$/m, "regenerate must write the token FILE PATH key so it takes precedence over the legacy var on a future restart too, not just in this process");
});

// Audit finding #4 (HIGH): readDiscordBotApiToken() (routes.js) checks the
// direct DUNE_DISCORD_ADAPTER_TOKEN env var BEFORE the token file. If an
// operator set that var directly (a real, documented manual-setup path),
// Enable/Regenerate must clear it -- otherwise the UI shows a fresh,
// plausible-looking token that the live adapter never actually uses to
// authenticate, because the untouched direct env var keeps winning.
test("enableDiscordBotAdapter clears a direct DUNE_DISCORD_ADAPTER_TOKEN value in .env so the file-based token becomes authoritative", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-enable-clears-direct-"));
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_TOKEN=some-direct-manual-value\n");

  const result = enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] });
  assert.equal(result.ok, true);

  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_TOKEN=""$/m, "the direct token env var must be cleared, not left pointing at a now-dead credential");
});

test("regenerateDiscordBotToken clears a direct DUNE_DISCORD_ADAPTER_TOKEN value in .env for the same reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-regen-clears-direct-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = tokenFile;
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_TOKEN=some-direct-manual-value\n");
  writeFileSync(tokenFile, "old-token-value\n");

  const result = regenerateDiscordBotToken({ repoRoot: dir });
  assert.equal(result.ok, true);

  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_TOKEN=""$/m, "the direct token env var must be cleared on regenerate too, or the freshly-shown token would never actually be used");
});

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

// Audit finding #1 (CRITICAL): a bare POST to /enable must not silently
// re-mint the live token once the adapter is already enabled -- that
// would let an admin (updates:apply) achieve the exact effect the
// owner-only settings:discord-bot-regenerate-token gate exists to
// restrict. Repeat calls to /enable, once already enabled, must behave
// exactly like /role-ids: token-safe and idempotent.
test("applyDiscordBotEnableRequest mints a token on a genuine first enable (from disabled)", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-apply-first-enable-"));

  const result = applyDiscordBotEnableRequest({ repoRoot: dir }, { player: ["111111111111111111"], moderator: [], admin: [] });
  assert.equal(result.ok, true);
  assert.equal(result.tokenMinted, true, "a genuine first enable must mint a token");
  assert.equal(result.token.length, 64);

  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_ENABLED=true$/m);
  assert.match(envContent, /^DISCORD_PLAYER_ROLE_IDS=111111111111111111$/m);
});

test("applyDiscordBotEnableRequest does NOT mint a new token when the adapter is already enabled -- it only updates role IDs, exactly like updateDiscordBotRoleIds", () => {
  process.env.DUNE_DISCORD_ADAPTER_ENABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-apply-reenable-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_ENABLED=true\nDUNE_DISCORD_ADAPTER_TOKEN_FILE=runtime/secrets/discord-adapter-token.txt\n");
  writeFileSync(tokenFile, "token-a-must-be-unchanged\n");

  const result = applyDiscordBotEnableRequest({ repoRoot: dir }, { player: ["222222222222222222"], moderator: [], admin: [] });
  assert.equal(result.ok, true);
  assert.equal(result.tokenMinted, false, "re-POSTing /enable on an already-enabled adapter must not mint a new token");
  assert.equal(result.token, undefined, "the response must carry no token field when none was minted");

  const tokenContent = readFileSync(tokenFile, "utf8").trim();
  assert.equal(tokenContent, "token-a-must-be-unchanged", "the live token file must be untouched");
  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DISCORD_PLAYER_ROLE_IDS=222222222222222222$/m, "role IDs must still be applied");
});

// Audit finding #1 residual gap (Important, second review round): writing
// a new value to .env on disk does NOT update the RUNNING process's own
// process.env -- that only happens when the container restarts and
// re-reads env vars fresh. discordAdapterEnabled() reads
// process.env.DUNE_DISCORD_ADAPTER_ENABLED directly, so between a first
// successful Enable (which writes .env and queues a container-recreate
// task that finishes asynchronously) and that recreate actually
// completing, a second /enable call landing in this SAME, not-yet-
// recreated process must still see enabled:true -- otherwise it
// re-evaluates as "not yet enabled" and mints a SECOND fresh token,
// reproducing finding #1's original bug inside a race window instead of
// closing it. This simulates that exact scenario: two sequential calls
// into the real business-logic layer against ONE persistent process
// state (no resetting process.env between calls, no separate pre-set
// .env per call), not two independent pure-function invocations.
test("applyDiscordBotEnableRequest: a second call before the container recreate completes must not mint a second token (in-process staleness)", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-double-enable-"));

  const first = applyDiscordBotEnableRequest({ repoRoot: dir }, { player: ["111111111111111111"], moderator: [], admin: [] });
  assert.equal(first.tokenMinted, true, "the genuine first enable must mint a token");

  // Nothing has restarted this process -- simulate the second /enable POST
  // landing before the queued recreate task finishes.
  const second = applyDiscordBotEnableRequest({ repoRoot: dir }, { player: ["222222222222222222"], moderator: [], admin: [] });
  assert.equal(second.tokenMinted, false, "a second enable call before the recreate completes must not mint a second token");
  assert.equal(second.token, undefined);

  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  const tokenContent = readFileSync(tokenFile, "utf8").trim();
  assert.equal(tokenContent, first.token, "the live token file must still hold the first-minted token, unchanged by the second call");
});

// Audit finding #4 residual gap (Important, second review round): the
// same in-process-vs-.env-file staleness applies to the direct
// DUNE_DISCORD_ADAPTER_TOKEN var. regenerateDiscordBotToken() deliberately
// never triggers a container recreate (the token file's content is read
// fresh per request, so no recreate should be needed) -- which means
// nothing will EVER refresh process.env for this specific path. An
// operator who previously set DUNE_DISCORD_ADAPTER_TOKEN directly (the
// documented manual-setup path) has that value already loaded into the
// running process's process.env; clearing it in .env alone leaves
// readDiscordBotApiToken() -- which reads process.env directly -- still
// returning the stale direct value forever, in the exact same process,
// with no restart to ever fix it.
// Finding 5 (LOW, Layer 3 test-coverage audit): enableDiscordBotAdapter()
// and regenerateDiscordBotToken() both write the token file with
// { mode: 0o600 } plus a belt-and-braces chmodSync -- but nothing asserted
// this. A future refactor that accidentally dropped the mode option would
// silently regress to a more permissive default (whatever the process
// umask allows) with nothing catching it.
test("enableDiscordBotAdapter writes the token file with mode 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-enable-mode-"));

  const result = enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] });

  const stat = statSync(join(dir, "runtime", "secrets", "discord-adapter-token.txt"));
  assert.equal(stat.mode & 0o777, 0o600, "the freshly minted token file must be owner-read/write only");
  assert.equal(result.ok, true);
});

test("regenerateDiscordBotToken writes the token file with mode 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-regen-mode-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = tokenFile;
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(tokenFile, "old-token-value\n", { mode: 0o644 });

  const result = regenerateDiscordBotToken({ repoRoot: dir });

  const stat = statSync(tokenFile);
  assert.equal(stat.mode & 0o777, 0o600, "the regenerated token file must be owner-read/write only, even if the pre-existing file had a looser mode");
  assert.equal(result.ok, true);
});

test("regenerateDiscordBotToken clears the direct token in the RUNNING process too, so readDiscordBotApiToken() immediately returns the new file token in the same process", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-regen-inprocess-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(tokenFile, "old-token-value\n");
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = tokenFile;
  // Simulate an already-running process that loaded a direct manual token
  // at container start -- .env may get rewritten by the time we get here,
  // but THIS process's own process.env still has the old value until
  // something explicitly clears it.
  process.env.DUNE_DISCORD_ADAPTER_TOKEN = "stale-direct-value-loaded-at-container-start";

  const result = regenerateDiscordBotToken({ repoRoot: dir });
  assert.equal(result.ok, true);

  // The exact scenario that was silently broken: read the token back
  // through the SAME function the live adapter route uses to authenticate
  // requests, in the SAME process, with no restart in between.
  const resolvedToken = readDiscordBotApiToken({ repoRoot: dir });
  assert.equal(resolvedToken, result.token, "the running process must immediately see the freshly-minted file token, not the stale direct value");
});

test("enableDiscordBotAdapter also clears DUNE_DISCORD_ADAPTER_TOKEN in the RUNNING process, not just in .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-enable-inprocess-clear-"));
  process.env.DUNE_DISCORD_ADAPTER_TOKEN = "stale-direct-value-loaded-at-container-start";

  enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] });

  assert.equal(process.env.DUNE_DISCORD_ADAPTER_TOKEN, "", "the running process's own env var must be cleared immediately, not just the .env file on disk");
});

// Found while adding Layer 3 route-level integration coverage
// (discordAdapterSettingsRoutes.integration.test.js): enableDiscordBotAdapter()
// already mirrors `enabled` and the cleared direct token into the RUNNING
// process's env (see the two tests above) for the exact same reason --
// writing .env to disk does not change what an already-running process sees.
// It never mirrored DUNE_DISCORD_ADAPTER_TOKEN_FILE the same way, so
// readDiscordBotSettingsState() -> readDiscordBotApiToken() (which reads
// process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE directly) kept reporting
// tokenConfigured:false in the SAME process immediately after a genuine
// first enable, even though the token file had just been written to disk --
// an operator viewing the settings page right after enabling would see "no
// token configured" until the console itself restarted.
test("enableDiscordBotAdapter mirrors the token file path into the RUNNING process too, so a read immediately after enable in the same process reports tokenConfigured:true", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  delete process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-enable-mirrors-tokenfile-"));

  const result = enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] });
  assert.equal(result.ok, true);

  const state = readDiscordBotSettingsState({ repoRoot: dir });
  assert.equal(state.tokenConfigured, true, "the freshly minted token must be visible in this same process immediately, not only after a restart");
});

// Same class of gap as the token-file mirroring test above, for the 3
// role-ID env keys: discordRoleMappingFromEnv() (adapter.js) reads
// DISCORD_PLAYER_ROLE_IDS/DISCORD_MODERATOR_ROLE_IDS/DISCORD_ADMIN_ROLE_IDS
// from process.env directly. enableDiscordBotAdapter() writes them to .env
// on disk but, before this fix, never mirrored them into the RUNNING
// process -- a GET of the settings state in the same process, in the window
// before the queued console restart completes, would report the role IDs
// that were configured BEFORE this enable call, not what was just submitted.
test("enableDiscordBotAdapter mirrors the role-ID env keys into the RUNNING process too, so a read immediately after enable reflects what was just submitted", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  delete process.env.DISCORD_PLAYER_ROLE_IDS;
  delete process.env.DISCORD_MODERATOR_ROLE_IDS;
  delete process.env.DISCORD_ADMIN_ROLE_IDS;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-enable-mirrors-roleids-"));

  enableDiscordBotAdapter({ repoRoot: dir }, { player: ["111111111111111111"], moderator: ["222222222222222222"], admin: [] });

  const state = readDiscordBotSettingsState({ repoRoot: dir });
  assert.deepEqual(state.roleIds.player, ["111111111111111111"], "the freshly submitted player role IDs must be visible in this same process immediately");
  assert.deepEqual(state.roleIds.moderator, ["222222222222222222"]);
});

// Same gap, for updateDiscordBotRoleIds() (the /role-ids route, and the
// "already enabled" branch of applyDiscordBotEnableRequest) -- this is the
// function an admin editing role IDs on an already-live adapter actually
// goes through, so this is the more commonly hit path in practice.
test("updateDiscordBotRoleIds mirrors the role-ID env keys into the RUNNING process too, so a read immediately after saving reflects what was just submitted", () => {
  process.env.DISCORD_PLAYER_ROLE_IDS = "111111111111111111";
  delete process.env.DISCORD_MODERATOR_ROLE_IDS;
  delete process.env.DISCORD_ADMIN_ROLE_IDS;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-roleids-mirrors-"));

  updateDiscordBotRoleIds({ repoRoot: dir }, { player: ["333333333333333333"], moderator: ["444444444444444444"], admin: [] });

  const state = readDiscordBotSettingsState({ repoRoot: dir });
  assert.deepEqual(state.roleIds.player, ["333333333333333333"], "the newly saved player role IDs must be visible in this same process immediately, not the pre-save value");
  assert.deepEqual(state.roleIds.moderator, ["444444444444444444"]);
});

// Task 2 (hosted-bot console-initiated OAuth registration plan): the
// hosted/self-hosted `choice` toggle in DiscordBotSection.tsx previously
// lived only in browser localStorage -- never sent to or read from the
// backend. Task 6's /register route needs a real, persisted,
// server-readable value to gate against, so this is the one env key this
// feature is allowed to write for it.
test("readDiscordBotSettingsState reports deploymentChoice as null when never set", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE;
  const state = readDiscordBotSettingsState({});
  assert.equal(state.deploymentChoice, null);
});

test("enableDiscordBotAdapter persists deploymentChoice, and readDiscordBotSettingsState reflects it", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-choice-"));
  const result = enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: "hosted" });
  assert.equal(result.ok, true);
  // No manual process.env write needed here -- enableDiscordBotAdapter()
  // already mirrors the normalized choice into process.env itself (the
  // same in-process-staleness mirroring it does for enabled/token/role-ID
  // keys), so readDiscordBotSettingsState() below sees it immediately.
  const state = readDiscordBotSettingsState({});
  assert.equal(state.deploymentChoice, "hosted");
  delete process.env.DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE;
});

// Fix round 1 (reviewer finding, Minor): lock in the silently-ignored-not-
// written behavior for an invalid deploymentChoice, through both mutators
// -- normalizeDeploymentChoice() itself isn't exported, so this exercises
// it via its two real callers.
test("enableDiscordBotAdapter silently ignores an invalid deploymentChoice instead of writing it", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-choice-invalid-enable-"));
  const result = enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: "HOSTED" });
  assert.equal(result.ok, true);
  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.doesNotMatch(envContent, /DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE/, "an invalid deploymentChoice value must never be written to .env");
  const state = readDiscordBotSettingsState({ repoRoot: dir });
  assert.equal(state.deploymentChoice, null);
});

test("updateDiscordBotRoleIds silently ignores an invalid or empty deploymentChoice instead of writing it, and never clobbers an existing valid value", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-choice-invalid-update-"));
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE=self-hosted\n");

  updateDiscordBotRoleIds({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: "" });
  let envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE=self-hosted$/m, "an empty deploymentChoice must not overwrite the existing persisted value");

  updateDiscordBotRoleIds({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: 123 });
  envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE=self-hosted$/m, "a non-string deploymentChoice must not overwrite the existing persisted value either");
});

test("updateDiscordBotRoleIds persists an updated deploymentChoice without touching the token", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-choice-update-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_ENABLED=true\n");
  writeFileSync(tokenFile, "existing-token\n");
  updateDiscordBotRoleIds({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: "self-hosted" });
  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE=self-hosted$/m);
  assert.equal(readFileSync(tokenFile, "utf8").trim(), "existing-token", "role-ID/choice updates must never touch the token file");
});

// Audit finding #2 (HIGH): admin must not be able to grant Discord
// "admin" bot-command tier to an arbitrary role via /enable or
// /role-ids -- the route handler uses this comparison to decide whether
// owner-only gating applies.
test("discordAdminRoleIdsChanged reports false when the admin role ID set is unchanged (order-independent)", () => {
  assert.equal(discordAdminRoleIdsChanged(["111111111111111111", "222222222222222222"], ["222222222222222222", "111111111111111111"]), false);
});

test("discordAdminRoleIdsChanged reports false when neither current nor requested has any admin role IDs", () => {
  assert.equal(discordAdminRoleIdsChanged([], []), false);
});

test("discordAdminRoleIdsChanged reports true when an admin role ID is added", () => {
  assert.equal(discordAdminRoleIdsChanged([], ["111111111111111111"]), true);
});

test("discordAdminRoleIdsChanged reports true when an admin role ID is removed", () => {
  assert.equal(discordAdminRoleIdsChanged(["111111111111111111"], []), true);
});

test("discordAdminRoleIdsChanged reports true when the admin role ID set is swapped for a different one of the same size", () => {
  assert.equal(discordAdminRoleIdsChanged(["111111111111111111"], ["222222222222222222"]), true);
});
