import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(here, "../src/server.js"), "utf8");
const dbSource = readFileSync(join(here, "../src/duneDb.js"), "utf8");

function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const parameters = source.indexOf("(", start);
  let parentheses = 1;
  let cursor = parameters + 1;
  for (; cursor < source.length && parentheses > 0; cursor += 1) {
    if (source[cursor] === "(") parentheses += 1;
    if (source[cursor] === ")") parentheses -= 1;
  }
  const brace = source.indexOf("{", cursor);
  let depth = 1;
  for (let index = brace + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(brace + 1, index);
  }
  throw new Error(`${name} has no closing brace`);
}

test("vehicle durability repair stops live maps before writing and restarts them afterward", () => {
  const body = functionBody(serverSource, "playerVehicleDecayRepairRoute");
  const inspect = body.indexOf("inspectVehicleDecayRepair");
  const stop = body.indexOf("vehicleRepairRestartCommands(target).stop");
  const repair = body.indexOf("await duneDb.repairVehicleDecay", stop);
  const restart = body.indexOf("restartVehicleRepairTargets", repair);
  assert.ok(inspect >= 0 && stop > inspect && repair > stop && restart > repair);
  assert.match(body, /target\.connected/);
  assert.match(body, /stoppedTargets\.push\(target\)/);
  assert.match(body, /if \(operationError\)/);
});

test("vehicle repair preflight uses the same durability eligibility rules as the repair", () => {
  const inspect = functionBody(dbSource, "inspectVehicleDecayRepair");
  const repair = functionBody(dbSource, "repairVehicleDecay");
  for (const marker of ["VEHICLE_REPAIR_TEMPLATE_MAXIMA_CTE", "CurrentDurability", "MaxDurability", "tm.max_durability", "permission_actor_rank"]) {
    assert.match(inspect, new RegExp(marker.replaceAll(".", "\\.")));
    assert.match(repair, new RegExp(marker.replaceAll(".", "\\.")));
  }
  assert.match(inspect, /pg_stat_activity/);
  assert.match(inspect, /DuneSandbox -/);
});

test("vehicle repair restart routing is partition-specific", () => {
  const start = serverSource.indexOf("function vehicleRepairRestartCommands(");
  const end = serverSource.indexOf("\n}\n", start);
  const body = serverSource.slice(start, end + 2);
  assert.match(body, /Survival_1/);
  assert.match(body, /sietchesRestartStop/);
  assert.match(body, /Overmap/);
  assert.match(body, /restartServiceStop/);
  assert.match(body, /mapsDespawn/);
  assert.match(body, /mapsSpawn/);
});
