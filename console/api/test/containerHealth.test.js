import assert from "node:assert/strict";
import test from "node:test";
import { collectContainerHealth, mergeContainerHealth } from "../src/services/containerHealth.js";

test("container health parses and joins Docker stats with real status output", () => {
  const result = mergeContainerHealth(
    '{"Name":"dune-postgres","CPUPerc":"1.2%","MemUsage":"100MiB / 1GiB","NetIO":"1kB / 2kB","BlockIO":"3MB / 4MB"}\n',
    '{"Names":"dune-postgres","Status":"Up 2 hours (healthy)"}\n'
  );
  assert.deepEqual(result, [{
    name: "dune-postgres",
    cpu: "1.2%",
    memory: "100MiB",
    memoryLimit: "1GiB",
    networkIO: "1kB / 2kB",
    blockIO: "3MB / 4MB",
    status: "Up 2 hours (healthy)"
  }]);
});

test("container health scopes both Docker calls to the configured Compose project", async () => {
  const calls = [];
  const result = await collectContainerHealth({
    projectName: "dune-test",
    run: async (command, args) => {
      calls.push({ command, args });
      return "";
    }
  });
  assert.deepEqual(result, { containers: [] });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, "docker");
    assert.ok(call.args.includes("label=com.docker.compose.project=dune-test"));
  }
});

test("container health fails closed instead of exposing every host container", async () => {
  let called = false;
  const result = await collectContainerHealth({ projectName: "", run: async () => { called = true; return ""; } });
  assert.equal(called, false);
  assert.deepEqual(result.containers, []);
  assert.match(result.error, /project name/i);
});
