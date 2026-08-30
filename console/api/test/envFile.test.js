import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateEnvFileValue } from "../src/services/envFile.js";

// Real bug found via live-testing: dune-dev's .env showed a blank line before
// every Discord OAuth key the guided setup wizard writes, except the first.
// discordSetupFinalize (server.js) calls updateEnvFileValue once per key in a
// loop -- each call reads the current file, splits on newline, and appends
// the new key. A normally-newline-terminated file splits into a trailing ""
// entry (the position right before EOF); the new key was pushed AFTER that
// entry instead of replacing it, so the write preserved a blank line in front
// of every newly-added key, and the NEXT sequential call saw the freshly
// blank-line-prefixed file and repeated the same mistake.

function readEnvLines(path) {
  return readFileSync(path, "utf8").split("\n");
}

test("updateEnvFileValue: appending a new key to a normally-newline-terminated file adds no blank line before it", () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "EXISTING_KEY=1\n"); // the normal case: ends in a single trailing newline
  updateEnvFileValue(dir, "NEW_KEY", "2");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, ["EXISTING_KEY=1", "NEW_KEY=2", ""]);
  rmSync(dir, { recursive: true, force: true });
});

test("updateEnvFileValue: sequential calls (the guided setup wizard's per-key loop shape) never insert a blank line between keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "DISCORD_OAUTH_CLIENT_ID=abc\n");
  // Mirrors server.js's `for (const [key, value] of Object.entries(fields)) updateEnvFileValue(key, value);`
  updateEnvFileValue(dir, "DISCORD_HOME_GUILD_ID", "1");
  updateEnvFileValue(dir, "DISCORD_CONSOLE_ADMIN_ROLE_IDS", "2");
  updateEnvFileValue(dir, "DISCORD_CONSOLE_MODERATOR_ROLE_IDS", "3");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, [
    "DISCORD_OAUTH_CLIENT_ID=abc",
    "DISCORD_HOME_GUILD_ID=1",
    "DISCORD_CONSOLE_ADMIN_ROLE_IDS=2",
    "DISCORD_CONSOLE_MODERATOR_ROLE_IDS=3",
    "",
  ]);
  rmSync(dir, { recursive: true, force: true });
});

// #641 (guided Discord app-creation flow) design's §4.3: the connect step's
// sequential write of exactly the 2 keys it manages is the coldest possible
// .env state this loop shape will ever see -- a brand-new install, before
// ANY Discord config (or .env file at all) exists. Distinct from the test
// above, which starts from a file that already has one key.
test("updateEnvFileValue: the guided setup wizard's connect step (write DISCORD_OAUTH_CLIENT_ID then DISCORD_OAUTH_REDIRECT_URI) against a .env that doesn't exist yet inserts no blank lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  // No writeFileSync at all -- .env genuinely does not exist yet.
  updateEnvFileValue(dir, "DISCORD_OAUTH_CLIENT_ID", "123456789012345678");
  updateEnvFileValue(dir, "DISCORD_OAUTH_REDIRECT_URI", "example-redirect-uri");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, [
    "DISCORD_OAUTH_CLIENT_ID=123456789012345678",
    "DISCORD_OAUTH_REDIRECT_URI=example-redirect-uri",
    "",
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("updateEnvFileValue: updating an EXISTING key in place still adds no stray blank line", () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "A=1\nB=2\n");
  updateEnvFileValue(dir, "B", "22");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, ["A=1", "B=22", ""]);
  rmSync(dir, { recursive: true, force: true });
});

test("updateEnvFileValue: a deliberate blank line BETWEEN existing keys (not at EOF) is preserved, not collapsed", () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "# Section one\nA=1\n\n# Section two\nB=2\n");
  updateEnvFileValue(dir, "C", "3");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, ["# Section one", "A=1", "", "# Section two", "B=2", "C=3", ""]);
  rmSync(dir, { recursive: true, force: true });
});

test("updateEnvFileValue: a file with multiple stray trailing blank lines is normalized to exactly one on write", () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "A=1\n\n\n");
  updateEnvFileValue(dir, "B", "2");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, ["A=1", "B=2", ""]);
  rmSync(dir, { recursive: true, force: true });
});
