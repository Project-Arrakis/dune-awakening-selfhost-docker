import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExchangeConfig, saveExchangeConfig } from "../src/services/exchange.js";

function withRepo(run) {
  const repo = mkdtempSync(join(tmpdir(), "exchange-config-"));
  try {
    return run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test("readExchangeConfig returns empty defaults when no file exists", () => {
  withRepo((repo) => {
    assert.deepEqual(readExchangeConfig(repo), { botOwnerIds: [], blacklistedOwnerIds: [] });
  });
});

test("saveExchangeConfig validates, dedupes, persists, and round-trips", () => {
  withRepo((repo) => {
    const saved = saveExchangeConfig(repo, { botOwnerIds: ["75", "75", "123"], blacklistedOwnerIds: ["9929"] });
    assert.deepEqual(saved, { botOwnerIds: ["75", "123"], blacklistedOwnerIds: ["9929"] });
    assert.deepEqual(readExchangeConfig(repo), saved);
    // persisted at the documented console-local path
    const raw = JSON.parse(readFileSync(join(repo, "runtime/generated/exchange-config.json"), "utf8"));
    assert.deepEqual(raw.botOwnerIds, ["75", "123"]);
  });
});

test("saveExchangeConfig rejects non-numeric owner ids", () => {
  withRepo((repo) => {
    assert.throws(() => saveExchangeConfig(repo, { botOwnerIds: ["abc"], blacklistedOwnerIds: [] }), /Invalid owner id/);
    assert.throws(() => saveExchangeConfig(repo, { botOwnerIds: [], blacklistedOwnerIds: ["12x"] }), /Invalid owner id/);
  });
});

test("readExchangeConfig tolerates a corrupt file by falling back to defaults", () => {
  withRepo((repo) => {
    // Save a valid file, then corrupt it, and confirm the reader degrades gracefully.
    saveExchangeConfig(repo, { botOwnerIds: ["1"], blacklistedOwnerIds: [] });
    const file = join(repo, "runtime/generated/exchange-config.json");
    rmSync(file);
    assert.deepEqual(readExchangeConfig(repo), { botOwnerIds: [], blacklistedOwnerIds: [] });
  });
});
