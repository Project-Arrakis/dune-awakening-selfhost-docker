import { runDockerLogs } from "../runner.js";

// Confirmed directly against a live game server's own stdout log (2026-09-17, dune-dev and
// dune-prod2), not guessed. Distinct from the weekly Coriolis cycle (coriolisSeed.js) -- this
// is the frequent, random smaller storm, firing roughly every 45-60 minutes.
//
// Hagga Basin logs a clean, explicit pair of lines per storm:
//   LogSandStormManager: Log: Requested a Sandstorm auto-spawn on [HaggaBasin] Server 1 Dimension 0
//   LogSandStorm: Log: Sandstorm BeginPlay on [HaggaBasin] Server 1 Dimension 0
// Deep Desert has no equivalent clean line -- the best available signal is a BP_SandStorm_C_<id>
// actor's SetAutoActivate warning, which appears once per storm spawn on that map:
//   LogActorComponent: Warning: SetAutoActivate called on component
//     BP_StormLightningManager_Component_C .../BP_SandStorm_C_<id>.BP_StormLightningManager_Component
//     after construction!
//
// Neither map logs a storm-end line, and neither carries any sub-map region/sector or position
// data -- confirmed no `dune.actors` row exists for `class ILIKE '%sandstorm%'` on either
// dune-dev or dune-prod2, matching dune-resource-scanner's established finding that this class of
// ephemeral weather actor is never persisted to Postgres. "Active" below is therefore a heuristic
// window from the last detected start line, not a real observed end -- documented, not asserted
// as ground truth.
const HAGGA_START_LINE = /Requested a Sandstorm auto-spawn on \[(\w+)\]/;
const DEEP_DESERT_START_LINE = /SetAutoActivate called on component BP_StormLightningManager_Component.*BP_SandStorm_C_\d+/;

// How long a storm is assumed to stay active after its last detected start line, since neither
// map logs an end. Per the operator's own in-game observation (2026-09-17): a real storm at an
// Overmap-to-Hagga-Basin entry point runs roughly 1-3 minutes. Set above that observed range
// with a small margin for log-timestamp/poll lag, not a confirmed exact duration.
export const ACTIVE_WINDOW_MS = 4 * 60 * 1000;

const STATUS_CACHE_MS = 30000;
const STATUS_CACHE_MAX_ENTRIES = 128;
const statusCache = new Map();

// Unlike Coriolis (one farm-wide value with a fallback chain), a sandstorm's status is genuinely
// per-partition -- each Sietch/Deep-Desert-instance dimension runs its own independent cycle
// (confirmed: dune-prod2 runs both dune-server-survival-1 and dune-server-survival-1-37 as
// separate partitions). There is deliberately no fallback to a different partition's container
// here; an unresolvable partition reports unknown status rather than borrowing another one's.
function partitionContainerCandidate(map, partitionId) {
  const id = partitionId === undefined || partitionId === null ? "" : String(partitionId).trim();
  if (!/^[1-9]\d{0,18}$/.test(id)) return null;
  if (map === "HaggaBasin") return id === "1" ? "dune-server-survival-1" : `dune-server-survival-1-${id}`;
  if (map === "DeepDesert") return `dune-server-deepdesert-1-${id}`;
  return null;
}

async function fetchLog(service, { tail = 10000, timeoutMs = 5000, runLogs = runDockerLogs } = {}) {
  try {
    const result = await runLogs(service, { tail, timeoutMs, captureOutput: true });
    return `${result?.stdout || ""}\n${result?.stderr || ""}`;
  } catch {
    return null;
  }
}

const TIMESTAMP_PREFIX = /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/;

function lineTimestamp(line) {
  const match = line.match(TIMESTAMP_PREFIX);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms));
}

function lastStartTimestamp(combined, pattern) {
  if (combined === null) return null;
  let latest = null;
  for (const line of combined.split(/\r?\n/)) {
    if (!pattern.test(line)) continue;
    const ts = lineTimestamp(line);
    if (ts !== null && (latest === null || ts > latest)) latest = ts;
  }
  return latest;
}

export async function resolveSandstormStatus({ map, partitionId, service, now = Date.now(), ...options } = {}) {
  const container = service || partitionContainerCandidate(map, partitionId);
  if (!container) return { map: map || null, partitionId: partitionId ?? null, active: false, lastStartAt: null };

  const cacheable = !options.runLogs;
  const cached = cacheable ? statusCache.get(container) : null;
  const cachedIsFresh = cached && cached.expiresAt > now;
  const lastStartMs = cachedIsFresh ? cached.lastStartMs : lastStartTimestamp(
    await fetchLog(container, options),
    map === "DeepDesert" ? DEEP_DESERT_START_LINE : HAGGA_START_LINE
  );

  if (cacheable && !cachedIsFresh) {
    for (const [key, entry] of statusCache) {
      if (entry.expiresAt <= now) statusCache.delete(key);
    }
    if (!statusCache.has(container) && statusCache.size >= STATUS_CACHE_MAX_ENTRIES) {
      statusCache.delete(statusCache.keys().next().value);
    }
    statusCache.set(container, { expiresAt: now + STATUS_CACHE_MS, lastStartMs });
  }

  return {
    map: map || null,
    partitionId: partitionId ?? null,
    active: lastStartMs !== null && now - lastStartMs < ACTIVE_WINDOW_MS,
    lastStartAt: lastStartMs !== null ? new Date(lastStartMs).toISOString() : null
  };
}
