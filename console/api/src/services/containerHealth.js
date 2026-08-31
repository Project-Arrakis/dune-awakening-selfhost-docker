import { execFile } from "node:child_process";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export async function collectContainerHealth(options = {}) {
  const projectName = String(options.projectName ?? process.env.DUNE_COMPOSE_PROJECT_NAME ?? process.env.COMPOSE_PROJECT_NAME ?? "").trim();
  if (!projectName) return { containers: [], error: "The Dune Compose project name is not configured." };

  const run = options.run || execFileText;
  const filter = `label=com.docker.compose.project=${projectName}`;
  try {
    const statusOutput = await run("docker", ["ps", "--filter", filter, "--format", "{{json .}}"]);
    const containerIds = parseJsonLines(statusOutput)
      .map((row) => String(row.ID || "").trim())
      .filter(Boolean);
    if (containerIds.length === 0) return { containers: [] };

    // `docker stats` has no --filter option. Resolve the Compose project's
    // containers first, then pass only those explicit IDs so addons cannot
    // obtain telemetry for unrelated host containers.
    const statsOutput = await run("docker", ["stats", "--no-stream", "--format", "{{json .}}", ...containerIds]);
    return { containers: mergeContainerHealth(statsOutput, statusOutput) };
  } catch {
    return { containers: [], error: "Docker container statistics are unavailable." };
  }
}

export function mergeContainerHealth(statsOutput, statusOutput = "") {
  const statuses = new Map(parseJsonLines(statusOutput).map((row) => [containerName(row), String(row.Status || "unknown")]));
  return parseJsonLines(statsOutput)
    .map((row) => {
      const name = containerName(row);
      const [memory = "0B", memoryLimit = ""] = String(row.MemUsage || "").split("/").map((value) => value.trim());
      return {
        name,
        cpu: String(row.CPUPerc || "0%"),
        memory,
        memoryLimit,
        networkIO: String(row.NetIO || "0B / 0B"),
        blockIO: String(row.BlockIO || "0B / 0B"),
        status: statuses.get(name) || "unknown"
      };
    })
    .filter((row) => row.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseJsonLines(output) {
  return String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function containerName(row) {
  return String(row?.Name || row?.Names || row?.Container || "").trim();
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: 5000, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
