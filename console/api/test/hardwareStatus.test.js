import test from "node:test";
import assert from "node:assert/strict";
import { createHardwareStatusProvider, hardwareStatusSnapshot } from "../src/services/performance.js";

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
    "/proc/stat": "cpu 100 0 50 850 0 0 0 0 0 0\n",
    "/proc/cpuinfo": "processor: 0\nphysical id: 0\ncore id: 0\nvendor_id: GenuineIntel\nmodel name: Intel(R) Xeon(R) CPU E3-1220 v3 @ 3.10GHz\n\nprocessor: 1\nphysical id: 0\ncore id: 1\n",
    "/proc/net/dev": "Inter-| Receive | Transmit\n eth0: 12345 0 0 0 0 0 0 0 67890 0 0 0 0 0 0 0\n lo: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n",
    "/test/hwmon/hwmon0/name": "coretemp\n",
    "/test/hwmon/hwmon0/temp1_input": "47500\n",
    "/test/hwmon/hwmon0/temp1_label": "Package id 0\n",
    "/test/hwmon/hwmon0/temp2_input": "not-a-number\n",
    "/test/hwmon/hwmon0/fan1_input": "1450\n",
    "/test/hwmon/hwmon0/fan1_label": "CPU Fan\n",
    "/test/hwmon/hwmon1/name": "nvme\n",
    "/test/hwmon/hwmon1/temp1_input": "38000\n",
    "/test/block/nvme0n1/device/model": "Samsung SSD 990 PRO 2TB\n",
    "/test/block/nvme0n1/device/vendor": "Samsung\n",
    "/test/block/nvme0n1/size": "3907029168\n",
    "/test/net/eth0/operstate": "up\n",
    "/test/net/eth0/speed": "1000\n",
    "realpath:/test/hwmon/hwmon1/device": "/devices/pci0000:00/nvme/nvme0",
    "realpath:/test/block/nvme0n1/device": "/devices/pci0000:00/nvme/nvme0/nvme0n1",
    "realpath:/test/block/nvme0n1/device/subsystem": "/sys/bus/nvme"
  }, {
    "/test/hwmon": ["hwmon1", "not-hwmon", "hwmon0"],
    "/test/hwmon/hwmon0": ["temp2_input", "temp1_label", "temp1_input", "fan1_input", "fan1_label", "name"],
    "/test/hwmon/hwmon1": ["temp1_input", "name"],
    "/test/block": ["nvme0n1", "nvme0n1p1", "loop0"],
    "/test/net": ["lo", "eth0"]
  });

  const result = await hardwareStatusSnapshot({
    ...io,
    hwmonRoot: "/test/hwmon",
    blockRoot: "/test/block",
    networkRoot: "/test/net",
    filesystemPath: "/test/data",
    statfsSync: () => ({ blocks: 1000, bavail: 250, bsize: 4096 }),
    sampleState: { previousCpuSample: { idle: 700, total: 800 } },
    now: () => Date.parse("2026-08-28T00:00:00.000Z")
  });

  assert.deepEqual(result, {
    version: 3,
    sampled_at: "2026-08-28T00:00:00.000Z",
    temperatures: [
      { name: "coretemp Package id 0", temperature: 47.5, device_id: "cpu:0" },
      { name: "nvme Sensor 1", temperature: 38, device_id: "block:nvme0n1" }
    ],
    fans: [{ name: "coretemp CPU Fan", rpm: 1450, device_id: "cpu:0" }],
    cpu: { id: "cpu:0", manufacturer: "GenuineIntel", model: "Intel(R) Xeon(R) CPU E3-1220 v3 @ 3.10GHz", usage_percent: 25, logical_threads: 2, physical_cores: 2 },
    storage: [
      { id: "block:nvme0n1", name: "nvme0n1", manufacturer: "Samsung", model: "Samsung SSD 990 PRO 2TB", bus: "nvme", size_bytes: 2000398934016 }
    ],
    filesystems: [{ id: "dune-data", name: "Dune Docker Data", total_bytes: 4096000, free_bytes: 1024000, used_bytes: 3072000, percent: 75 }],
    network: [{ name: "eth0", status: "up", rx_bytes: 12345, tx_bytes: 67890, speed_mbps: 1000 }],
    memory: { total_kb: 1000, available_kb: 250, used_kb: 750, percent: 75 },
    swap: { total_kb: 200, free_kb: 50, used_kb: 150, percent: 75 },
    load: { one: 1.25, five: 0.5, fifteen: 0.2 },
    uptime_seconds: 90061
  });
});

test("hardware status degrades to a valid empty response when host metrics are unavailable", async () => {
  const unavailable = () => { throw new Error("unavailable"); };
  const result = await hardwareStatusSnapshot({ readFileSync: unavailable, readdirSync: unavailable, statfsSync: unavailable, hwmonRoot: "/missing", now: () => 0 });
  assert.deepEqual(result, {
    version: 3,
    sampled_at: "1970-01-01T00:00:00.000Z",
    temperatures: [],
    fans: [],
    cpu: {},
    storage: [],
    filesystems: [],
    network: [],
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

  assert.deepEqual(result.cpu, { id: "cpu:0", model: "Example Board", usage_percent: null, logical_threads: 0, physical_cores: 0 });
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

test("hardware provider caches snapshots for at least five seconds and preserves CPU sampling state", async () => {
  let now = 10000;
  let stat = "cpu 100 0 0 900 0 0 0 0 0 0\n";
  let reads = 0;
  const provider = createHardwareStatusProvider({
    now: () => now,
    readFileSync(path) {
      if (path === "/proc/stat") {
        reads += 1;
        return stat;
      }
      return "";
    },
    readdirSync: () => [],
    statfsSync: () => { throw new Error("unavailable"); }
  });

  const first = await provider();
  now += 1000;
  stat = "cpu 200 0 0 1000 0 0 0 0 0 0\n";
  const cached = await provider();
  assert.strictEqual(cached, first);
  assert.equal(reads, 1);

  now += 4000;
  const next = await provider();
  assert.notStrictEqual(next, first);
  assert.equal(reads, 2);
  assert.equal(next.cpu.usage_percent, 50);
});
