import { readFileSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";

let previousCpuSample = null;
const DEFAULT_HWMON_ROOT = "/sys/class/hwmon";
const MAX_HWMON_DEVICES = 64;
const MAX_TEMPERATURE_SENSORS = 128;
const MAX_SENSOR_TEXT_BYTES = 256;

export async function performanceSnapshot(repoRoot) {
  const cpu = readCpuUsagePercent();
  const memory = readMemoryUsage();
  const disk = readDiskUsage(repoRoot);
  const uptimeSeconds = readHostUptimeSeconds();
  return {
    cpuPercent: cpu,
    memory,
    disk,
    uptimeSeconds,
    uptime: formatUptime(uptimeSeconds),
    sampledAt: new Date().toISOString()
  };
}

// Stable, permissioned addon contract for read-only host telemetry. Collection
// is implemented in Console core: addon packages never provide or execute a
// host-side script. Fixed proc/sys roots, strict numeric parsing, byte bounds,
// and sensor-count caps keep the bridge response small and predictable.
export async function hardwareStatusSnapshot(options = {}) {
  const readFile = options.readFileSync || readFileSync;
  const readDir = options.readdirSync || readdirSync;
  const hwmonRoot = options.hwmonRoot || DEFAULT_HWMON_ROOT;
  const meminfo = safeReadText("/proc/meminfo", readFile, 256 * 1024);
  const memoryRows = parseMeminfo(meminfo);
  const memory = memorySnapshotKb(memoryRows);
  const swap = swapSnapshotKb(memoryRows);
  const load = loadSnapshot(safeReadText("/proc/loadavg", readFile, 4096));
  const uptimeSeconds = uptimeSnapshotSeconds(safeReadText("/proc/uptime", readFile, 4096));

  return {
    version: 1,
    temperatures: temperatureSnapshot(hwmonRoot, readFile, readDir),
    memory,
    swap,
    load,
    uptime_seconds: uptimeSeconds
  };
}

function temperatureSnapshot(root, readFile, readDir) {
  const temperatures = [];
  const devices = safeReadDir(root, readDir)
    .filter((name) => /^hwmon\d+$/.test(name))
    .sort(naturalNameCompare)
    .slice(0, MAX_HWMON_DEVICES);

  for (const device of devices) {
    if (temperatures.length >= MAX_TEMPERATURE_SENSORS) break;
    const deviceRoot = join(root, device);
    const chipName = sensorLabel(safeReadText(join(deviceRoot, "name"), readFile, MAX_SENSOR_TEXT_BYTES));
    const inputs = safeReadDir(deviceRoot, readDir)
      .filter((name) => /^temp\d+_input$/.test(name))
      .sort(naturalNameCompare);
    for (const input of inputs) {
      if (temperatures.length >= MAX_TEMPERATURE_SENSORS) break;
      const raw = strictNumber(safeReadText(join(deviceRoot, input), readFile, MAX_SENSOR_TEXT_BYTES));
      // Linux hwmon temperatures are millidegrees Celsius. Reject impossible
      // or sentinel values rather than presenting them as real hardware data.
      if (raw === null || raw < -100000 || raw > 250000) continue;
      const stem = input.slice(0, -"_input".length);
      const explicitLabel = sensorLabel(safeReadText(join(deviceRoot, `${stem}_label`), readFile, MAX_SENSOR_TEXT_BYTES));
      const fallback = stem.replace(/^temp/, "Sensor ");
      const name = explicitLabel
        ? (chipName ? `${chipName} ${explicitLabel}` : explicitLabel)
        : (chipName ? `${chipName} ${fallback}` : fallback);
      temperatures.push({ name: name.slice(0, 160), temperature: Math.round((raw / 1000) * 10) / 10 });
    }
  }
  return temperatures;
}

function parseMeminfo(text) {
  const rows = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB\s*$/);
    if (!match) continue;
    rows[match[1]] = Number(match[2]);
  }
  return rows;
}

function memorySnapshotKb(rows) {
  const total = nonnegativeNumber(rows.MemTotal);
  const available = Math.min(total, nonnegativeNumber(rows.MemAvailable));
  const used = Math.max(0, total - available);
  return { total_kb: total, available_kb: available, used_kb: used, percent: percent(used, total) };
}

function swapSnapshotKb(rows) {
  const total = nonnegativeNumber(rows.SwapTotal);
  const free = Math.min(total, nonnegativeNumber(rows.SwapFree));
  const used = Math.max(0, total - free);
  return { total_kb: total, free_kb: free, used_kb: used, percent: percent(used, total) };
}

function loadSnapshot(text) {
  const values = text.trim().split(/\s+/).slice(0, 3).map(strictNumber);
  const loadValue = (index) => values[index] === null || values[index] === undefined ? 0 : Math.max(0, values[index]);
  return {
    one: loadValue(0),
    five: loadValue(1),
    fifteen: loadValue(2)
  };
}

function uptimeSnapshotSeconds(text) {
  const value = strictNumber(text.trim().split(/\s+/)[0]);
  return value === null ? 0 : Math.max(0, Math.floor(value));
}

function safeReadText(path, readFile, maxBytes) {
  try {
    const value = readFile(path, "utf8");
    const text = typeof value === "string" ? value : String(value || "");
    return text.slice(0, maxBytes).trim();
  } catch {
    return "";
  }
}

function safeReadDir(path, readDir) {
  try {
    const rows = readDir(path);
    return Array.isArray(rows) ? rows.map(String) : [];
  } catch {
    return [];
  }
}

function sensorLabel(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function strictNumber(value) {
  const text = String(value ?? "").trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function nonnegativeNumber(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function percent(used, total) {
  return total > 0 ? Math.round(((used / total) * 100) * 10) / 10 : 0;
}

function naturalNameCompare(left, right) {
  return left.localeCompare(right, "en", { numeric: true });
}

function readCpuUsagePercent() {
  const line = readFileSync("/proc/stat", "utf8").split(/\r?\n/).find((row) => row.startsWith("cpu "));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map((value) => Number(value) || 0);
  const idle = (values[3] || 0) + (values[4] || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const current = { idle, total };
  if (!previousCpuSample) {
    previousCpuSample = current;
    return null;
  }
  const totalDelta = current.total - previousCpuSample.total;
  const idleDelta = current.idle - previousCpuSample.idle;
  previousCpuSample = current;
  if (totalDelta <= 0) return null;
  return roundPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

function readMemoryUsage() {
  const rows = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split(/\r?\n/).map((line) => {
    const match = line.match(/^([^:]+):\s+(\d+)/);
    return match ? [match[1], Number(match[2]) * 1024] : null;
  }).filter(Boolean));
  const total = rows.MemTotal || 0;
  const available = rows.MemAvailable || 0;
  const used = Math.max(0, total - available);
  return {
    usedBytes: used,
    totalBytes: total,
    availableBytes: available,
    percent: total ? roundPercent((used / total) * 100) : null
  };
}

function readDiskUsage(path) {
  const stats = statfsSync(path || ".");
  const total = Number(stats.blocks) * Number(stats.bsize);
  const free = Number(stats.bavail) * Number(stats.bsize);
  const used = Math.max(0, total - free);
  return {
    usedBytes: used,
    totalBytes: total,
    freeBytes: free,
    percent: total ? roundPercent((used / total) * 100) : null
  };
}

function readHostUptimeSeconds() {
  const value = readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0];
  return Math.max(0, Math.floor(Number(value) || 0));
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
}

function roundPercent(value) {
  return Math.round(value * 10) / 10;
}
