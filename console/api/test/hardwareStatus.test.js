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
    },
    realpathSync(path) {
      if (!Object.hasOwn(files, `realpath:${path}`)) throw new Error("missing");
      return files[`realpath:${path}`];
    }
  };
}

test("hardware status returns the stable addon contract from bounded proc and hwmon inputs", async () => {
  const io = fixtureIo({
    "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n",
    "/proc/loadavg": "1.25 0.50 0.20 2/100 42\n",
    "/proc/uptime": "90061.99 100.00\n",
    "/proc/cpuinfo": "vendor_id: GenuineIntel\nmodel name: Intel(R) Xeon(R) CPU E3-1220 v3 @ 3.10GHz\n",
    "/test/hwmon/hwmon0/name": "coretemp\n",
    "/test/hwmon/hwmon0/temp1_input": "47500\n",
    "/test/hwmon/hwmon0/temp1_label": "Package id 0\n",
    "/test/hwmon/hwmon0/temp2_input": "not-a-number\n",
    "/test/hwmon/hwmon1/name": "nvme\n",
    "/test/hwmon/hwmon1/temp1_input": "38000\n",
    "/test/block/nvme0n1/device/model": "Samsung SSD 990 PRO 2TB\n",
    "/test/block/nvme0n1/device/vendor": "Samsung\n",
    "realpath:/test/hwmon/hwmon1/device": "/devices/pci0000:00/nvme/nvme0",
    "realpath:/test/block/nvme0n1/device": "/devices/pci0000:00/nvme/nvme0/nvme0n1",
    "realpath:/test/block/nvme0n1/device/subsystem": "/sys/bus/nvme"
  }, {
    "/test/hwmon": ["hwmon1", "not-hwmon", "hwmon0"],
    "/test/hwmon/hwmon0": ["temp2_input", "temp1_label", "temp1_input", "name"],
    "/test/hwmon/hwmon1": ["temp1_input", "name"],
    "/test/block": ["nvme0n1", "nvme0n1p1", "loop0"]
  });

  const result = await hardwareStatusSnapshot({ ...io, hwmonRoot: "/test/hwmon", blockRoot: "/test/block" });

  assert.deepEqual(result, {
    version: 2,
    temperatures: [
      { name: "coretemp Package id 0", temperature: 47.5, device_id: "cpu:0" },
      { name: "nvme Sensor 1", temperature: 38, device_id: "block:nvme0n1" }
    ],
    cpu: { id: "cpu:0", manufacturer: "GenuineIntel", model: "Intel(R) Xeon(R) CPU E3-1220 v3 @ 3.10GHz" },
    storage: [
      { id: "block:nvme0n1", name: "nvme0n1", manufacturer: "Samsung", model: "Samsung SSD 990 PRO 2TB", bus: "nvme" }
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
    version: 2,
    temperatures: [],
    cpu: {},
    storage: [],
    memory: { total_kb: 0, available_kb: 0, used_kb: 0, percent: 0 },
    swap: { total_kb: 0, free_kb: 0, used_kb: 0, percent: 0 },
    load: { one: 0, five: 0, fifteen: 0 },
    uptime_seconds: 0
  });
});

test("hardware status omits partitions and persistent storage identifiers", async () => {
  const io = fixtureIo({
    "/proc/meminfo": "",
    "/proc/loadavg": "",
    "/proc/uptime": "",
    "/proc/cpuinfo": "Hardware: Example Board\n",
    "/test/block/sda/device/model": "Crucial MX500\u0000\n",
    "/test/block/sda/device/vendor": "ATA\n",
    "/test/block/sda/device/protocol": "ATA\n",
    "/test/block/sda/device/type": "0\n",
    "/test/block/sda/device/serial": "must-not-be-returned\n",
    "/test/block/sda1/partition": "1\n",
    "/test/block/sda1/device/model": "Crucial MX500\n",
    "/test/block/sr0/device/model": "DVD-ROM\n",
    "/test/block/sr0/device/type": "5\n",
    "realpath:/test/block/sda/device": "/devices/pci0000:00/ata1/host0/target0:0:0/0:0:0:0",
    "realpath:/test/block/sda1/device": "/devices/pci0000:00/ata1/host0/target0:0:0/0:0:0:0",
    "realpath:/test/block/sda/device/subsystem": "/sys/bus/scsi"
  }, {
    "/test/hwmon": [],
    "/test/block": ["sr0", "sda1", "sda"]
  });

  const result = await hardwareStatusSnapshot({ ...io, hwmonRoot: "/test/hwmon", blockRoot: "/test/block" });

  assert.deepEqual(result.cpu, { id: "cpu:0", model: "Example Board" });
  assert.deepEqual(result.storage, [
    { id: "block:sda", name: "sda", manufacturer: "ATA", model: "Crucial MX500", bus: "sata" }
  ]);
  assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
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
