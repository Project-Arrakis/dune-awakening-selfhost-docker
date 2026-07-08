import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  characterTransferDefaults,
  characterTransferSettingsPath,
  parseCharacterTransferSettings,
  readCharacterTransferSettings,
  saveCharacterTransferSettings,
  validateCharacterTransferSettings,
  writeCharacterTransferSettingsText
} from "../src/services/characterTransferSettings.js";

function tempConfig() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-transfer-settings-"));
  return { repoRoot };
}

test("parses Battlegroup character transfer settings", () => {
  const parsed = parseCharacterTransferSettings(`
[Battlegroup]
AuthorizationPreset=BattlegroupInternal
ShouldDeleteOriginCharactersDuringTransfers=false
AcceptOutgoingCharacterTransfers=true
IncomingCharacterTransfers=0
ExportCharacterTimeout=1200
ImportCharacterTimeout=1300
FreeToTransferCharactersFrom=true
FreeToTransferCharactersTo=false
ValidateBeforeImportCharacterTimeout=240
ForceIsWorldClosed=false
ForceIsWorldClosingSoon=true

[Server]
IncomingCharacterTransfers=10
`);

  assert.equal(parsed.settings.ShouldDeleteOriginCharactersDuringTransfers, false);
  assert.equal(parsed.settings.IncomingCharacterTransfers, 0);
  assert.equal(parsed.settings.ExportCharacterTimeout, 1200);
  assert.equal(parsed.settings.ForceIsWorldClosingSoon, true);
});

test("writes transfer settings while preserving unrelated Director config", () => {
  const existing = `[Battlegroup]
AuthorizationPreset=BattlegroupInternal
; keep this comment
AcceptOutgoingCharacterTransfers=false

[Server]
PlayerHardCap=40
`;
  const next = writeCharacterTransferSettingsText(existing, {
    ...characterTransferDefaults,
    AcceptOutgoingCharacterTransfers: true,
    IncomingCharacterTransfers: 20,
    FreeToTransferCharactersTo: true
  });

  assert.match(next, /AuthorizationPreset=BattlegroupInternal/);
  assert.match(next, /; keep this comment/);
  assert.match(next, /AcceptOutgoingCharacterTransfers=true/);
  assert.match(next, /IncomingCharacterTransfers=20/);
  assert.doesNotMatch(next, /IncomingCharacterTransferRuleset=/);
  assert.doesNotMatch(next, /TransferOriginRuleset=/);
  assert.match(next, /FreeToTransferCharactersTo=true/);
  assert.match(next, /\[Server\]\nPlayerHardCap=40/);
});

test("rejects invalid incoming transfer enum values", () => {
  assert.throws(() => validateCharacterTransferSettings({
    ...characterTransferDefaults,
    IncomingCharacterTransfers: 15
  }), /IncomingCharacterTransfers must be one of/);
  assert.throws(() => validateCharacterTransferSettings({
    ...characterTransferDefaults,
    IncomingCharacterTransfers: 40
  }), /IncomingCharacterTransfers must be one of/);
});

test("rejects invalid timeout values", () => {
  assert.throws(() => validateCharacterTransferSettings({
    ...characterTransferDefaults,
    ExportCharacterTimeout: 0
  }), /ExportCharacterTimeout must be/);
  assert.throws(() => validateCharacterTransferSettings({
    ...characterTransferDefaults,
    ImportCharacterTimeout: "abc"
  }), /ImportCharacterTimeout must be/);
});

test("boolean values round-trip through the generated override", () => {
  const config = tempConfig();
  try {
    const saved = saveCharacterTransferSettings(config, {
      ...characterTransferDefaults,
      ShouldDeleteOriginCharactersDuringTransfers: false,
      FreeToTransferCharactersFrom: true,
      ForceIsWorldClosed: true
    });
    const readBack = readCharacterTransferSettings(config);
    assert.equal(saved.settings.ShouldDeleteOriginCharactersDuringTransfers, false);
    assert.equal(readBack.settings.FreeToTransferCharactersFrom, true);
    assert.equal(readBack.settings.ForceIsWorldClosed, true);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("restore defaults only resets character transfer settings", () => {
  const config = tempConfig();
  try {
    const path = characterTransferSettingsPath(config);
    mkdirSync(resolve(config.repoRoot, "runtime/generated"), { recursive: true });
    writeFileSync(path, `[Battlegroup]
AuthorizationPreset=BattlegroupInternal
IncomingCharacterTransfers=30
FreeToTransferCharactersTo=true

[Server]
PlayerHardCap=40
`);
    saveCharacterTransferSettings(config, {}, { defaults: true });
    const text = readFileSync(path, "utf8");
    assert.match(text, /IncomingCharacterTransfers=0/);
    assert.doesNotMatch(text, /IncomingCharacterTransferRuleset=/);
    assert.doesNotMatch(text, /TransferOriginRuleset=/);
    assert.match(text, /FreeToTransferCharactersTo=true/);
    assert.match(text, /AuthorizationPreset=BattlegroupInternal/);
    assert.match(text, /\[Server\]\nPlayerHardCap=40/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("accept-all incoming transfer value reads back without rewriting", () => {
  const config = tempConfig();
  try {
    const path = characterTransferSettingsPath(config);
    mkdirSync(resolve(config.repoRoot, "runtime/generated"), { recursive: true });
    writeFileSync(path, `[Battlegroup]
IncomingCharacterTransfers=0
`);
    const readBack = readCharacterTransferSettings(config);
    assert.equal(readBack.settings.IncomingCharacterTransfers, 0);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("generated settings can be injected into Director Battlegroup config", () => {
  const config = tempConfig();
  try {
    saveCharacterTransferSettings(config, {
      ...characterTransferDefaults,
      IncomingCharacterTransfers: 0,
      ExportCharacterTimeout: 1000
    });
    const generated = readFileSync(resolve(config.repoRoot, "runtime/generated/director-character-transfer.ini"), "utf8");
    const directorConfig = `[Battlegroup]
AuthorizationPreset=BattlegroupInternal
${generated}

[InstancingModes]
Overmap=SingleServer
`;
    assert.match(directorConfig, /\[Battlegroup\][\s\S]*IncomingCharacterTransfers=0[\s\S]*ExportCharacterTimeout=1000/);
    assert.doesNotMatch(directorConfig, /IncomingCharacterTransferRuleset=/);
    assert.doesNotMatch(directorConfig, /TransferOriginRuleset=/);
    assert.match(directorConfig, /\[InstancingModes\]/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});
