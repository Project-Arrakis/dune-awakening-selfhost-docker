import test from "node:test";
import assert from "node:assert/strict";
import { resolveSandstormStatus, ACTIVE_WINDOW_MS } from "../src/services/sandstormStatus.js";

const HAGGA_LINE = (ts) => `[${ts}][938][1]LogSandStormManager: Log: Requested a Sandstorm auto-spawn on [HaggaBasin] Server 1 Dimension 0`;
const DEEP_DESERT_LINE = (ts) =>
  `[${ts}][938][8]LogActorComponent: Warning: SetAutoActivate called on component BP_StormLightningManager_Component_C ` +
  "/Game/Dune/Maps/Arrakis/DeepDesert_1/DeepDesert_1.DeepDesert_1:PersistentLevel.BP_SandStorm_C_2147221273.BP_StormLightningManager_Component after construction!";

test("resolveSandstormStatus reports active immediately after a Hagga Basin start line", async () => {
  const now = Date.UTC(2026, 8, 17, 21, 20, 0, 0);
  const runLogs = async () => ({ stdout: `${HAGGA_LINE("2026.09.17-21.18.29:025")}\n`, stderr: "" });
  const result = await resolveSandstormStatus({ map: "HaggaBasin", partitionId: "1", now, runLogs });
  assert.equal(result.active, true);
  assert.equal(result.lastStartAt, "2026-09-17T21:18:29.025Z");
});

test("resolveSandstormStatus reports inactive once the heuristic window has elapsed", async () => {
  const startMs = Date.UTC(2026, 8, 17, 21, 18, 29, 25);
  const now = startMs + ACTIVE_WINDOW_MS + 1;
  const runLogs = async () => ({ stdout: `${HAGGA_LINE("2026.09.17-21.18.29:025")}\n`, stderr: "" });
  const result = await resolveSandstormStatus({ map: "HaggaBasin", partitionId: "1", now, runLogs });
  assert.equal(result.active, false);
  assert.equal(result.lastStartAt, "2026-09-17T21:18:29.025Z");
});

test("resolveSandstormStatus parses Deep Desert's BP_SandStorm_C warning line, not Hagga Basin's pattern", async () => {
  const now = Date.UTC(2026, 8, 17, 21, 15, 0, 0);
  const runLogs = async () => ({ stdout: `${DEEP_DESERT_LINE("2026.09.17-21.14.51:115")}\n`, stderr: "" });
  const result = await resolveSandstormStatus({ map: "DeepDesert", partitionId: "8", now, runLogs });
  assert.equal(result.active, true);
  assert.equal(result.lastStartAt, "2026-09-17T21:14:51.115Z");
});

test("resolveSandstormStatus never matches Deep Desert's pattern against a Hagga Basin log and vice versa", async () => {
  const now = Date.UTC(2026, 8, 17, 21, 20, 0, 0);
  const runLogs = async () => ({ stdout: `${DEEP_DESERT_LINE("2026.09.17-21.18.29:025")}\n`, stderr: "" });
  const result = await resolveSandstormStatus({ map: "HaggaBasin", partitionId: "1", now, runLogs });
  assert.equal(result.active, false);
  assert.equal(result.lastStartAt, null);
});

test("resolveSandstormStatus uses the most recent start line when several are present", async () => {
  const now = Date.UTC(2026, 8, 17, 21, 20, 0, 0);
  const runLogs = async () => ({
    stdout: [HAGGA_LINE("2026.09.17-19.37.03:010"), HAGGA_LINE("2026.09.17-20.29.27:012")].join("\n"),
    stderr: ""
  });
  const result = await resolveSandstormStatus({ map: "HaggaBasin", partitionId: "1", now, runLogs });
  assert.equal(result.lastStartAt, "2026-09-17T20:29:27.012Z");
});

test("resolveSandstormStatus returns inactive/null when the container isn't running", async () => {
  const runLogs = async () => { throw new Error("docker logs failed with exit 1"); };
  const result = await resolveSandstormStatus({ map: "HaggaBasin", partitionId: "1", runLogs });
  assert.equal(result.active, false);
  assert.equal(result.lastStartAt, null);
});

test("resolveSandstormStatus never falls back to a different partition's container", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    return { stdout: "some unrelated log line\n", stderr: "" };
  };
  await resolveSandstormStatus({ map: "HaggaBasin", partitionId: "37", runLogs });
  assert.deepEqual(seenServices, ["dune-server-survival-1-37"]);
});

test("resolveSandstormStatus asks Hagga Basin partition 1 via the bare survival-1 container", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    return { stdout: "some unrelated log line\n", stderr: "" };
  };
  await resolveSandstormStatus({ map: "HaggaBasin", partitionId: "1", runLogs });
  assert.deepEqual(seenServices, ["dune-server-survival-1"]);
});

test("resolveSandstormStatus reports inactive without querying anything when partitionId is missing", async () => {
  const seenServices = [];
  const runLogs = async (service) => { seenServices.push(service); return { stdout: "", stderr: "" }; };
  const result = await resolveSandstormStatus({ map: "DeepDesert", runLogs });
  assert.deepEqual(seenServices, []);
  assert.equal(result.active, false);
  assert.equal(result.lastStartAt, null);
});

test("resolveSandstormStatus ignores malformed partition IDs instead of constructing Docker service names from them", async () => {
  const seenServices = [];
  const runLogs = async (service) => { seenServices.push(service); return { stdout: "", stderr: "" }; };
  await resolveSandstormStatus({ map: "DeepDesert", partitionId: "../../59", runLogs });
  assert.deepEqual(seenServices, []);
});

test("resolveSandstormStatus passes a wide tail and a short timeout so a hung docker call can't stall the request", async () => {
  let seenOptions = null;
  const runLogs = async (service, options) => {
    seenOptions = options;
    return { stdout: "", stderr: "" };
  };
  await resolveSandstormStatus({ map: "HaggaBasin", partitionId: "1", runLogs });
  assert.equal(seenOptions.tail, 10000);
  assert.equal(seenOptions.timeoutMs, 5000);
});
