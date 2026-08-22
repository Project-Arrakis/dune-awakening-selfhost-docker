import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(here, "../src/server.js"), "utf8");

function functionBody(name) {
  const start = serverSource.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const brace = serverSource.indexOf("{", start);
  let depth = 1;
  for (let index = brace + 1; index < serverSource.length; index += 1) {
    if (serverSource[index] === "{") depth += 1;
    if (serverSource[index] === "}") depth -= 1;
    if (depth === 0) return serverSource.slice(brace + 1, index);
  }
  throw new Error(`${name} has no closing brace`);
}

test("deleted-character recovery backs up and runs only while the affected Sietch is stopped", () => {
  const body = functionBody("playerCharacterRecoveryRoute");
  const diagnose = body.indexOf("inspectDeletedCharacterRecovery");
  const backup = body.indexOf('buildDuneArgs("backupCreate")');
  const stop = body.indexOf('buildDuneArgs("sietchesRestartStop"');
  const recover = body.indexOf("await duneDb.recoverDeletedCharacter");
  const start = body.indexOf('buildDuneArgs("sietchesRestartStart"');
  assert.ok(diagnose >= 0 && backup > diagnose && stop > backup && recover > stop && start > recover);
  assert.match(body, /DB_BACKUP_ORIGIN:\s*"restore-safety"/);
  assert.match(body, /"RECOVER DELETED CHARACTER"/);
  assert.match(body, /if \(recoveryError\) throw recoveryError/);
});

