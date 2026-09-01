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

test("Landsraad quest repair diagnoses before backup and repairs only after backup", () => {
  const body = functionBody("playerLandsraadQuestRepairRoute");
  const diagnose = body.indexOf("inspectLandsraadQuestRepairs");
  const noRepairReturn = body.indexOf("if (!diagnosis.repairCount) return diagnosis");
  const backup = body.indexOf('buildDuneArgs("backupCreate")');
  const repair = body.indexOf("await duneDb.repairLandsraadQuests");
  assert.ok(diagnose >= 0 && noRepairReturn > diagnose && backup > noRepairReturn && repair > backup);
  assert.match(body, /DB_BACKUP_ORIGIN:\s*"restore-safety"/);
  assert.match(body, /"REPAIR LANDSRAAD QUESTS"/);
});
