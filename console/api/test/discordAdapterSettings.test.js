import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
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

test("regenerateDiscordBotToken overwrites the token file with fresh random bytes, and never rewrites the token FILE PATH in .env", () => {
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
  assert.doesNotMatch(envContent, /DUNE_DISCORD_ADAPTER_TOKEN_FILE/, "regenerating must not rewrite .env's token FILE PATH -- the file path doesn't change, only its contents");
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
