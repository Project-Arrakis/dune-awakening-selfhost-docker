import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaUpdates, readQaChannel } from "../src/services/qaUpdates.js";

const SHA = "a".repeat(40);

test("QA authorization stays pending until the broker approves the Discord role", async () => {
  const root = mkdtempSync(join(tmpdir(), "dune-qa-"));
  let approved = false;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/device")) return response({ requestId: "request_1234567890123456", token: "t".repeat(48), authorizeUrl: "https://dunedocker.app/api/v1/qa/authorize?request=test" });
    if (String(url).endsWith("/session")) return response(approved
      ? { status: "authorized", expiresAt: "2099-01-01T00:00:00Z", user: { id: "123456789012345678", username: "Tester", role: "Core Contributor" } }
      : { status: "pending" });
    if (String(url).endsWith("/build")) return response({ sha: SHA, ready: true, status: "Checks Passed", commitsAheadOfRelease: 2, commitUrl: `https://github.com/example/repo/commit/${SHA}` });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const qa = createQaUpdates({ repoRoot: root }, { fetchImpl, brokerUrl: "https://dunedocker.app/api/v1/qa" });
  const started = await qa.start("console-session");
  assert.equal(started.status, "pending");
  assert.equal((await qa.status("console-session", { refresh: true })).authenticated, false);
  approved = true;
  const status = await qa.status("console-session", { refresh: true });
  assert.equal(status.authenticated, true);
  assert.equal(status.user.username, "Tester");
  assert.equal(status.user.role, "Core Contributor");
  const build = await qa.build("console-session");
  assert.equal(build.sha, SHA);
  assert.equal(build.updateAvailable, true);
});

test("QA channel state is read from the persistent generated marker", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-qa-state-"));
  mkdirSync(join(root, "runtime", "generated"), { recursive: true });
  writeFileSync(join(root, "runtime", "generated", "qa-update-channel.env"), `channel=qa\ncommit_sha=${SHA}\ninstalled_at=2026-08-24T10:00:00Z\n`);
  assert.deepEqual(readQaChannel(root), { channel: "qa", label: "QA Pre-Release", commitSha: SHA, shortSha: "aaaaaaaa", installedAt: "2026-08-24T10:00:00.000Z" });
});

test("a public release does not offer QA when main has no unreleased commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "dune-qa-current-"));
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/device")) return response({ requestId: "request_1234567890123456", token: "u".repeat(48), authorizeUrl: "https://dunedocker.app/authorize" });
    if (String(url).endsWith("/session")) return response({ status: "authorized", expiresAt: "2099-01-01T00:00:00Z", user: { id: "1", username: "Tester" } });
    return response({ sha: SHA, ready: true, status: "Checks Passed", commitsAheadOfRelease: 0, commitUrl: `https://github.com/example/repo/commit/${SHA}` });
  };
  const qa = createQaUpdates({ repoRoot: root }, { fetchImpl, brokerUrl: "https://dunedocker.app/api/v1/qa" });
  await qa.start("console-session");
  assert.equal((await qa.build("console-session")).updateAvailable, false);
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}
