import assert from "node:assert/strict";
import test from "node:test";
import { addonOpsContainerHealth, mergeContainerHealth, parseDockerJsonLines } from "../src/duneDb.js";

test("parseDockerJsonLines skips blank lines and parses one JSON object per line", () => {
  const result = parseDockerJsonLines('{"a":1}\n\n{"b":2}\n');
  assert.deepEqual(result, [{ a: 1 }, { b: 2 }]);
});

test("parseDockerJsonLines returns an empty array for empty/undefined input", () => {
  assert.deepEqual(parseDockerJsonLines(""), []);
  assert.deepEqual(parseDockerJsonLines(undefined), []);
});

test("mergeContainerHealth joins docker stats with real status from docker ps", () => {
  const result = mergeContainerHealth(
    '{"Name":"dune-postgres","CPUPerc":"1.2%","MemUsage":"100MiB / 1GiB","NetIO":"1kB / 2kB","BlockIO":"3MB / 4MB"}\n',
    '{"Names":"dune-postgres","Status":"Up 2 hours (healthy)"}\n'
  );
  assert.deepEqual(result, [{
    name: "dune-postgres",
    cpu: "1.2%",
    mem: "100MiB",
    memLimit: "1GiB",
    netIO: "1kB / 2kB",
    blockIO: "3MB / 4MB",
    status: "Up 2 hours (healthy)"
  }]);
});

test("mergeContainerHealth falls back to 'unknown' status when docker ps has no matching row", () => {
  const result = mergeContainerHealth(
    '{"Name":"dune-orphan","CPUPerc":"0%","MemUsage":"10MiB / 1GiB","NetIO":"0B","BlockIO":"0B"}\n',
    ""
  );
  assert.equal(result[0].status, "unknown");
});

test("addonOpsContainerHealth scopes the docker ps lookup to the configured Compose project", async () => {
  const calls = [];
  const result = await addonOpsContainerHealth({
    projectName: "dune-test",
    run: async (command, args) => {
      calls.push({ command, args });
      return "";
    }
  });
  // `docker ps` returns no rows, so there's nothing to scope `docker stats`
  // to -- the implementation must not fall back to querying every
  // container on the host, and must not call `docker stats` at all here.
  assert.deepEqual(result, { containers: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "docker");
  assert.deepEqual(calls[0].args.slice(0, 1), ["ps"]);
  assert.ok(calls[0].args.includes("label=com.docker.compose.project=dune-test"));
});

test("addonOpsContainerHealth passes docker ps's resolved container names positionally to docker stats, never --filter", async () => {
  // `docker stats` (unlike `docker ps`) has no --filter flag -- confirmed
  // against a live Docker CLI (see issue #246). Scoping must happen by
  // resolving names via `docker ps --filter` first, then passing those
  // names as positional CONTAINER arguments to `docker stats`.
  const calls = [];
  const result = await addonOpsContainerHealth({
    projectName: "dune-test",
    run: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "ps") {
        return '{"Names":"dune-postgres","Status":"Up 2 hours"}\n{"Names":"dune-rmq-game","Status":"Up 1 hour"}\n';
      }
      return "";
    }
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 1), ["ps"]);
  assert.deepEqual(calls[1].args.slice(0, 1), ["stats"]);
  assert.ok(!calls[1].args.includes("--filter"), "docker stats must never receive --filter");
  assert.ok(calls[1].args.includes("dune-postgres"));
  assert.ok(calls[1].args.includes("dune-rmq-game"));
  assert.deepEqual(result, { containers: [] });
});

test("addonOpsContainerHealth fails closed instead of exposing every host container when project name is unset", async () => {
  let called = false;
  const result = await addonOpsContainerHealth({
    projectName: "",
    run: async () => { called = true; return ""; }
  });
  assert.equal(called, false);
  assert.deepEqual(result.containers, []);
  assert.match(result.error, /project name/i);
});

test("addonOpsContainerHealth returns an unavailable result (not a throw) when Docker itself fails", async () => {
  const result = await addonOpsContainerHealth({
    projectName: "dune-test",
    run: async () => { throw new Error("docker: command not found"); }
  });
  assert.deepEqual(result.containers, []);
  assert.match(result.error, /unavailable/i);
});

test("addonOpsContainerHealth merges real stats+status output end-to-end through the run injection point", async () => {
  const result = await addonOpsContainerHealth({
    projectName: "dune-test",
    run: async (command, args) => {
      if (args.includes("stats")) {
        return '{"Name":"dune-rmq-game","CPUPerc":"0.5%","MemUsage":"50MiB / 512MiB","NetIO":"1kB / 1kB","BlockIO":"0B"}\n';
      }
      return '{"Names":"dune-rmq-game","Status":"Up 1 hour"}\n';
    }
  });
  assert.deepEqual(result, {
    containers: [{
      name: "dune-rmq-game",
      cpu: "0.5%",
      mem: "50MiB",
      memLimit: "512MiB",
      netIO: "1kB / 1kB",
      blockIO: "0B",
      status: "Up 1 hour"
    }]
  });
});
