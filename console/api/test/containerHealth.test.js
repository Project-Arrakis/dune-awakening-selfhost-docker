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

test("container health scopes Docker stats to explicit containers from the configured Compose project", async () => {
  const calls = [];
  const result = await collectContainerHealth({
    projectName: "dune-test",
    run: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "ps") {
        return [
          '{"ID":"abc123","Names":"dune-postgres","Status":"Up 2 hours (healthy)"}',
          '{"ID":"def456","Names":"dune-console","Status":"Up 1 hour"}'
        ].join("\n");
      }
      return [
        '{"Name":"dune-postgres","CPUPerc":"1.2%","MemUsage":"100MiB / 1GiB"}',
        '{"Name":"dune-console","CPUPerc":"0.2%","MemUsage":"50MiB / 1GiB"}'
      ].join("\n");
    }
  });
  assert.equal(result.containers.length, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    command: "docker",
    args: ["ps", "--filter", "label=com.docker.compose.project=dune-test", "--format", "{{json .}}"]
  });
  assert.deepEqual(calls[1], {
    command: "docker",
    args: ["stats", "--no-stream", "--format", "{{json .}}", "abc123", "def456"]
  });
});

test("container health does not call Docker stats when the Compose project has no running containers", async () => {
  const calls = [];
  const result = await collectContainerHealth({
    projectName: "dune-test",
    run: async (command, args) => {
      calls.push({ command, args });
      return "";
    }
  });
  assert.deepEqual(result, { containers: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "ps");
});

test("container health fails closed instead of exposing every host container", async () => {
  let called = false;
  const result = await collectContainerHealth({ projectName: "", run: async () => { called = true; return ""; } });
  assert.equal(called, false);
  assert.deepEqual(result.containers, []);
  assert.match(result.error, /project name/i);
});
