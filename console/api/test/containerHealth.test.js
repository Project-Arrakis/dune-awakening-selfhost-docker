import assert from "node:assert/strict";
import test from "node:test";
import { addonOpsContainerHealth, mergeContainerHealth, parseDockerJsonLines } from "../src/duneDb.js";
// `services/containerHealth.js`'s `collectContainerHealth`/`mergeContainerHealth` are an
// independent, currently-UNUSED upstream implementation -- server.js deliberately calls
// `duneDb.addonOpsContainerHealth()` instead (see server.js's own comment: `docker stats`,
// unlike `docker ps`, has no --filter flag, and collectContainerHealth() passes one). Kept
// under test anyway so this file tracks upstream's own test suite (Requirement 22 test-drift
// discipline) even though the module itself isn't wired into any route yet.
import { collectContainerHealth, mergeContainerHealth as mergeContainerHealthUpstream } from "../src/services/containerHealth.js";

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

test("collectContainerHealth (upstream, unused module) parses and joins Docker stats with real status output", () => {
  const result = mergeContainerHealthUpstream(
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

test("collectContainerHealth (upstream, unused module) includes Compose and host-mounted Dune services but excludes unrelated installations", async () => {
  const calls = [];
  const result = await collectContainerHealth({
    projectName: "dune-test",
    hostRoot: "/srv/dune",
    run: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "ps") {
        return [
          '{"ID":"abc123","Names":"dune-postgres","State":"running","Status":"Up 2 hours (healthy)"}',
          '{"ID":"def456","Names":"dune-director","State":"running","Status":"Up 1 hour"}',
          '{"ID":"stopped","Names":"dune-server-deepdesert-1-35","State":"exited","Status":"Exited (1) 2 hours ago"}',
          '{"ID":"other","Names":"dune-unrelated","State":"running","Status":"Up 1 hour"}'
        ].join("\n");
      }
      if (args[0] === "inspect") return [
        { id: "abc123", labels: { "com.docker.compose.project": "dune-test" } },
        { id: "def456", mounts: [{ Type: "bind", Source: "/srv/dune/runtime/director" }] },
        { id: "stopped", mounts: [{ Type: "bind", Source: "/srv/dune/runtime/game/dd/Saved" }] },
        { id: "other", labels: { "com.docker.compose.project": "other" }, mounts: [{ Type: "bind", Source: "/srv/dune-other/runtime" }] }
      ].map(row => JSON.stringify(row)).join("\n");
      return [
        '{"Name":"dune-postgres","CPUPerc":"1.2%","MemUsage":"100MiB / 1GiB"}',
        '{"Name":"dune-director","CPUPerc":"0.2%","MemUsage":"50MiB / 1GiB"}'
      ].join("\n");
    }
  });
  assert.equal(result.containers.length, 3);
  assert.equal(result.containers.find(row => row.name.includes("deepdesert")).status, "Exited (1) 2 hours ago");
  assert.equal(result.containers.find(row => row.name.includes("deepdesert")).cpu, "N/A");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], {
    command: "docker",
    args: ["ps", "--all", "--no-trunc", "--format", "{{json .}}"]
  });
  assert.deepEqual(calls[2], {
    command: "docker",
    args: ["stats", "--no-stream", "--format", "{{json .}}", "abc123", "def456"]
  });
});

test("collectContainerHealth (upstream, unused module) does not call Docker stats when the Compose project has no running containers", async () => {
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

test("collectContainerHealth (upstream, unused module) fails closed instead of exposing every host container", async () => {
  let called = false;
  const result = await collectContainerHealth({ projectName: "", run: async () => { called = true; return ""; } });
  assert.equal(called, false);
  assert.deepEqual(result.containers, []);
  assert.match(result.error, /project name/i);
});

test("collectContainerHealth (upstream, unused module) lists stopped installation volumes without requesting statistics", async () => {
  const calls = [];
  const result = await collectContainerHealth({
    projectName: "dune-test", hostRoot: "",
    run: async (_command, args) => {
      calls.push(args[0]);
      if (args[0] === "ps") return JSON.stringify({ ID: "a", Names: "dune-server", State: "exited", Status: "Exited (0)" });
      if (args[0] === "inspect") return JSON.stringify({ id: "a", mounts: [{ Type: "volume", Name: "dune-test_dune-server" }] });
      throw new Error("Stopped containers must not receive a stats request");
    }
  });
  assert.deepEqual(calls, ["ps", "inspect"]);
  assert.equal(result.containers[0].status, "Exited (0)");
  assert.equal(result.containers[0].memory, "N/A");
});

test("collectContainerHealth (upstream, unused module) keeps running containers visible if Docker stats omits them", () => {
  const result = mergeContainerHealthUpstream("", JSON.stringify({ Names: "dune-director", State: "running", Status: "Up 1 minute" }));
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "Up 1 minute");
  assert.equal(result[0].cpu, "N/A");
});
