import test from "node:test";
import assert from "node:assert/strict";
import { hardwareStatusSnapshot } from "../src/services/performance.js";

function fixtureIo(files, directories) {
  return {
    readFileSync(path) {
      if (!Object.hasOwn(files, path)) throw new Error("missing");
      return files[path];
    },
    readdirSync(path) {
      if (!Object.hasOwn(directories, path)) throw new Error("missing");
      return directories[path];
    }
  };
}

test("hardware status returns the stable addon contract from bounded proc and hwmon inputs", async () => {
  const io = fixtureIo({
    "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n",
    "/proc/loadavg": "1.25 0.50 0.20 2/100 42\n",
    "/proc/uptime": "90061.99 100.00\n",
    "/test/hwmon/hwmon0/name": "coretemp\n",
    "/test/hwmon/hwmon0/temp1_input": "47500\n",
    "/test/hwmon/hwmon0/temp1_label": "Package id 0\n",
    "/test/hwmon/hwmon0/temp2_input": "not-a-number\n",
    "/test/hwmon/hwmon1/name": "nvme\n",
    "/test/hwmon/hwmon1/temp1_input": "38000\n"
  }, {
    "/test/hwmon": ["hwmon1", "not-hwmon", "hwmon0"],
    "/test/hwmon/hwmon0": ["temp2_input", "temp1_label", "temp1_input", "name"],
    "/test/hwmon/hwmon1": ["temp1_input", "name"]
  });

  const result = await hardwareStatusSnapshot({ ...io, hwmonRoot: "/test/hwmon" });

  assert.deepEqual(result, {
    version: 1,
    temperatures: [
      { name: "coretemp Package id 0", temperature: 47.5 },
      { name: "nvme Sensor 1", temperature: 38 }
    ],
    memory: { total_kb: 1000, available_kb: 250, used_kb: 750, percent: 75 },
    swap: { total_kb: 200, free_kb: 50, used_kb: 150, percent: 75 },
    load: { one: 1.25, five: 0.5, fifteen: 0.2 },
    uptime_seconds: 90061
  });
});

test("hardware status degrades to a valid empty response when host metrics are unavailable", async () => {
  const unavailable = () => { throw new Error("unavailable"); };
  const result = await hardwareStatusSnapshot({ readFileSync: unavailable, readdirSync: unavailable, hwmonRoot: "/missing" });
  assert.deepEqual(result, {
    version: 1,
    temperatures: [],
    memory: { total_kb: 0, available_kb: 0, used_kb: 0, percent: 0 },
    swap: { total_kb: 0, free_kb: 0, used_kb: 0, percent: 0 },
    load: { one: 0, five: 0, fifteen: 0 },
    uptime_seconds: 0
  });
});

test("hardware status caps sensor output and rejects impossible temperatures", async () => {
  const inputs = Array.from({ length: 140 }, (_, index) => `temp${index + 1}_input`);
  const files = {
    "/proc/meminfo": "",
    "/proc/loadavg": "",
    "/proc/uptime": "",
    "/test/hwmon/hwmon0/name": "chip"
  };
  for (const [index, input] of inputs.entries()) {
    files[`/test/hwmon/hwmon0/${input}`] = index === 0 ? "999999" : "42000";
  }
  const io = fixtureIo(files, {
    "/test/hwmon": ["hwmon0"],
    "/test/hwmon/hwmon0": inputs
  });

  const result = await hardwareStatusSnapshot({ ...io, hwmonRoot: "/test/hwmon" });
  assert.equal(result.temperatures.length, 128);
  assert.ok(result.temperatures.every((sensor) => sensor.temperature === 42));
});
