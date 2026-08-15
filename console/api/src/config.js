import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, chownSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

export const APP_NAME = "Dune Docker Console";

// Single source of truth for every host-facing port this console cares
// about. Stock (Instance 1) values are the fallback defaults only --
// multi-server / single-public-IP deployments override these via .env.
// These values MUST stay in sync with runtime/scripts/runtime-env.sh's
// resolve_*_port() functions -- that file is the shell-side equivalent
// used by non-Node scripts, and the two must never drift (found 6
// places across the codebase that hardcoded these stock values directly
// instead of reading them from a shared source, breaking any deployment
// running non-default configured ports).
export function resolvePorts(env = process.env, repoRoot = process.cwd()) {
  const enginePorts = readEnginePortsFromProfile(repoRoot);
  // Player/Game and IGW base ports are authoritative in
  // runtime/generated/gameplay-profile.ini's [Engine:URL] section
  // (written via runtime/scripts/usersettings.py engine-set, e.g. by
  // the Maps UI or multi-server-config.py) -- NOT env vars. .env's
  // CLIENT_PORT_BASE/IGW_PORT_BASE are documented as
  // "compatibility/console metadata" only (see
  // docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md): a deployment that
  // changed these via the Maps UI directly, without also re-running
  // multi-server-config.py, would have a stale .env value while the
  // real game server already uses the new one -- reading the profile
  // file first avoids exactly that staleness. .env is kept as a
  // secondary fallback (useful before the profile file exists at all,
  // e.g. immediately after multi-server-config.py writes .env but
  // before its own engine-set call has run), and the stock literal is
  // the final fallback.
  // Route profile-parsed values through portValue() too (not just the
  // .env/stock fallback branch) -- a corrupted/malformed
  // gameplay-profile.ini could otherwise produce an out-of-range value
  // (e.g. Port=0 or a 10-digit garbage number) that bypasses range
  // validation entirely and flows through to the frontend and the
  // public-hosting reminder text unvalidated.
  const clientBase = enginePorts.port !== null
    ? portValue(enginePorts.port, portValue(env.CLIENT_PORT_BASE, 7777))
    : portValue(env.CLIENT_PORT_BASE, 7777);
  const igwBase = enginePorts.igwPort !== null
    ? portValue(enginePorts.igwPort, portValue(env.IGW_PORT_BASE, 7888))
    : portValue(env.IGW_PORT_BASE, 7888);
  return {
    postgres: portValue(env.POSTGRES_PORT || env.DUNE_DB_PORT || env.PGPORT, 15432),
    rmqAdmin: portValue(env.RMQ_ADMIN_PORT, 32573),
    rmqGame: portValue(env.RMQ_GAME_PORT, 31982),
    rmqGameHttp: portValue(env.RMQ_GAME_HTTP_PORT, 31983),
    rmqGameLocalHttp: portValue(env.RMQ_GAME_LOCAL_HTTP_PORT, 15672),
    textRouter: portValue(env.TEXT_ROUTER_PORT, 5059),
    director: portValue(env.DIRECTOR_PORT, 11717),
    metricsPrometheus: portValue(env.METRICS_PROMETHEUS_PORT, 9090),
    clientBase,
    clientBaseSecondary: clientBase + 1,
    igwBase,
    igwBaseSecondary: igwBase + 1
  };
}

// Reads Port/IGWPort directly from the [Engine:URL] section of
// runtime/generated/gameplay-profile.ini -- a cheap, synchronous read
// (no shelling out to usersettings.py, which resolvePorts() cannot
// afford given it's called from hot paths like server.js's error
// handler). Returns { port: null, igwPort: null } if the file doesn't
// exist yet (fresh install, before the first `dune init`/materialize)
// or doesn't have an [Engine:URL] section -- callers fall back to
// .env / stock values in that case, exactly matching
// runtime-env.sh's own resolve_client_port_base()/resolve_igw_port_base()
// fallback behavior.
function readEnginePortsFromProfile(repoRoot) {
  const profilePath = resolve(repoRoot, "runtime/generated/gameplay-profile.ini");
  if (!existsSync(profilePath)) return { port: null, igwPort: null };
  let text;
  try {
    text = readFileSync(profilePath, "utf8");
  } catch {
    return { port: null, igwPort: null };
  }
  // Normalize CRLF -> LF before parsing. The section-boundary regex
  // below relies on `$` (multiline) matching end-of-line -- `$` matches
  // before `\n` but not before a `\r` that precedes it, so an
  // unnormalized CRLF file causes the lookahead to treat the position
  // right before the trailing `\r` as the section boundary, silently
  // truncating the section one line early and dropping whichever key
  // (Port or IGWPort) comes last. usersettings.py always writes LF-only
  // on this project's Linux hosts, so this is a defensive normalization
  // for hand-edited/out-of-band files, not the common path.
  const normalized = text.replace(/\r\n/g, "\n");
  const sectionMatch = normalized.match(/^\[Engine:URL\]\s*$([\s\S]*?)(?=^\[|\s*$(?!\n))/m);
  const sectionText = sectionMatch ? sectionMatch[1] : normalized;
  const portMatch = sectionText.match(/^\s*Port\s*=\s*(\d+)\s*$/m);
  const igwMatch = sectionText.match(/^\s*IGWPort\s*=\s*(\d+)\s*$/m);
  return {
    port: portMatch ? Number(portMatch[1]) : null,
    igwPort: igwMatch ? Number(igwMatch[1]) : null
  };
}

function portValue(value, fallback) {
  const parsed = Number(value || fallback);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

export function loadConfig() {
  const repoRoot = resolve(process.env.DUNE_DOCKER_DIR || process.env.RUNTIME_DIR || process.cwd());
  const generatedDir = resolve(repoRoot, "runtime/generated");
  const secretsDir = resolve(repoRoot, "runtime/secrets");
  const secureCookieEnv = process.env.ADMIN_SECURE_COOKIES;
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  repairRootOwnedHostState(repoRoot);

  const adminPasswordFile = resolve(secretsDir, "admin-web-password.txt");
  const adminPasswordEnvManaged = Boolean(process.env.ADMIN_PASSWORD);
  return {
    appName: APP_NAME,
    version: readConsoleVersion(repoRoot),
    repoRoot,
    duneScript: resolve(repoRoot, "runtime/scripts/dune"),
    host: resolveAdminBindHost(process.env.ADMIN_BIND_HOST),
    port: Number(process.env.ADMIN_BIND_PORT || 8088),
    // A getter, not a plain value: config is loaded once at process
    // startup and lives for the life of the process (see server.js's
    // top-level `const config = loadConfig()`), but clientBase/igwBase
    // are backed by runtime/generated/gameplay-profile.ini, which the
    // Maps UI can rewrite at any time without restarting the console
    // (see userSettingsRawWriteRoute in server.js). A plain value here
    // would silently re-introduce the exact staleness bug resolvePorts()
    // was written to fix -- correct once at boot, stale forever after
    // the first Maps UI port change. Re-resolving on every read keeps
    // every consumer (publicConfig() -> /api/auth/state, preflight.js)
    // live-accurate without requiring a console restart. resolvePorts()
    // is a cheap sync file read (see readEnginePortsFromProfile()), safe
    // to call on every request.
    get ports() {
      return resolvePorts(process.env, repoRoot);
    },
    authDisabled: process.env.ADMIN_AUTH_DISABLED === "1",
    secureCookies: secureCookieEnv === undefined ? process.env.NODE_ENV === "production" : secureCookieEnv === "1",
    allowHostBootstrap: process.env.ALLOW_HOST_BOOTSTRAP === "true",
    mockMode: process.env.ADMIN_MOCK_MODE === "1",
    sessionSecret: getOrCreateSecret(resolve(secretsDir, "admin-web-session-secret.txt"), 48),
    adminPassword: process.env.ADMIN_PASSWORD || getOrCreateSecret(adminPasswordFile, 18),
    adminPasswordFile,
    adminPasswordEnvManaged,
    generatedDir,
    secretsDir,
    auditLog: resolve(generatedDir, "web-admin-audit.jsonl"),
    spicefieldOverridesFile: resolve(generatedDir, "spicefield-overrides.json"),
    landsraadMilestonePresetFile: resolve(generatedDir, "landsraad-milestones.json"),
    taskRetention: Number(process.env.ADMIN_TASK_RETENTION || 200),
    maxJsonBytes: Number(process.env.ADMIN_MAX_JSON_BYTES || 2 * 1024 * 1024),
    maxUploadBytes: Number(process.env.ADMIN_MAX_UPLOAD_BYTES || 1024 * 1024 * 1024),
    commandTimeoutMs: Number(process.env.ADMIN_COMMAND_TIMEOUT_MS || 120000),
    updateCheckCacheMs: Number(process.env.ADMIN_UPDATE_CHECK_CACHE_MS || 5 * 60 * 1000),
    staticDir: process.env.ADMIN_STATIC_DIR || resolve(repoRoot, "console/web/dist"),
    allowedIps: parseAllowedIps(process.env.ADMIN_ALLOWED_IPS)
  };
}

export function parseAllowedIps(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0)
    .map((ip) => ip.replace(/^::ffff:/, ""));
}

function repairRootOwnedHostState(repoRoot) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;

  let owner;
  try {
    owner = statSync(repoRoot);
  } catch {
    return;
  }
  if (!owner.uid || owner.uid === 0) return;

  const envPath = resolve(repoRoot, ".env");
  if (existsSync(envPath)) {
    updateEnvFileValue(envPath, "DUNE_HOST_UID", String(owner.uid));
    updateEnvFileValue(envPath, "DUNE_HOST_GID", String(owner.gid));
  }

  for (const path of [
    repoRoot,
    envPath,
    resolve(repoRoot, "runtime/generated"),
    resolve(repoRoot, "runtime/generated/battlegroup.env"),
    resolve(repoRoot, "runtime/generated/db-backup.env"),
    resolve(repoRoot, "runtime/generated/director-character-transfer.ini"),
    resolve(repoRoot, "runtime/generated/director-deepdesert-dual.ini"),
    resolve(repoRoot, "runtime/generated/ip-change-restart.env"),
    resolve(repoRoot, "runtime/generated/landsraad-milestones.json"),
    resolve(repoRoot, "runtime/generated/map-runtime-modes.json"),
    resolve(repoRoot, "runtime/generated/memory-balancer.json"),
    resolve(repoRoot, "runtime/generated/message-of-the-day.json"),
    resolve(repoRoot, "runtime/generated/message-of-the-day-state.json"),
    resolve(repoRoot, "runtime/generated/player-announcements.json"),
    resolve(repoRoot, "runtime/generated/player-announcements-state.json"),
    resolve(repoRoot, "runtime/generated/player-bans.json"),
    resolve(repoRoot, "runtime/generated/public-directory-status.json"),
    resolve(repoRoot, "runtime/generated/restart-queue.json"),
    resolve(repoRoot, "runtime/generated/restart-queue-state.json"),
    resolve(repoRoot, "runtime/generated/restart-schedule.env"),
    resolve(repoRoot, "runtime/generated/shutdown-protection.env"),
    resolve(repoRoot, "runtime/generated/sietch-config.json"),
    resolve(repoRoot, "runtime/generated/spicefield-overrides.json"),
    resolve(repoRoot, "runtime/generated/update-auto.env"),
    resolve(repoRoot, "runtime/generated/usersettings.json"),
    resolve(repoRoot, "runtime/generated/auto-refill-bases.json"),
    resolve(repoRoot, "runtime/generated/pending-generator-refills.json"),
    resolve(repoRoot, "runtime/generated/gameplay-profile.ini"),
    resolve(repoRoot, "runtime/generated/care-package.json"),
    resolve(repoRoot, "runtime/generated/care-package-grants.jsonl"),
    resolve(repoRoot, "runtime/generated/care-package-pending-returns.json"),
    resolve(repoRoot, "runtime/addons"),
    resolve(repoRoot, "runtime/addons/downloads"),
    resolve(repoRoot, "runtime/addons/grant-receipts"),
    resolve(repoRoot, "runtime/addons/installed"),
    resolve(repoRoot, "runtime/addons/staging"),
    resolve(repoRoot, "runtime/addons/state.json"),
    resolve(repoRoot, "runtime/secrets/funcom-token.txt"),
    resolve(repoRoot, "runtime/secrets/public-directory.json")
  ]) {
    try {
      if (existsSync(path)) chownSync(path, owner.uid, owner.gid);
    } catch {
      // Best effort. The console should still start even if a mounted path
      // cannot be chowned by the current runtime.
    }
  }
}

function updateEnvFileValue(path, key, value) {
  const current = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  let found = false;
  const line = `${key}=${value}`;
  const next = current.map((entry) => {
    if (envLineKey(entry) !== key) return entry;
    found = true;
    return line;
  });
  if (!found) next.push(line);
  writeFileSync(path, `${next.filter((entry, index) => entry !== "" || index < next.length - 1).join("\n")}\n`, { mode: 0o644 });
  try { chmodSync(path, 0o644); } catch {}
}

function envLineKey(line) {
  const text = String(line || "").trimStart();
  if (!text || text.startsWith("#")) return "";
  const index = text.indexOf("=");
  return index > 0 ? text.slice(0, index).trim() : "";
}

function readConsoleVersion(repoRoot) {
  try {
    return readFileSync(resolve(repoRoot, "VERSION"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

function resolveAdminBindHost(value) {
  const raw = String(value || "0.0.0.0").trim();
  if (raw && raw !== "auto") return raw;
  return detectPrivateIpv4() || "127.0.0.1";
}

function detectPrivateIpv4() {
  let interfaces = {};
  try {
    interfaces = networkInterfaces();
  } catch {
    return "";
  }
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal || !isPrivateIpv4(address.address)) continue;
      return address.address;
    }
  }
  return "";
}

function isPrivateIpv4(value) {
  const parts = String(value || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  return false;
}

function getOrCreateSecret(path, bytes) {
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  mkdirSync(dirname(path), { recursive: true });
  const value = randomBytes(bytes).toString("base64url");
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on non-POSIX development hosts.
  }
  return value;
}

export function publicConfig(config) {
  return {
    appName: config.appName,
    version: config.version,
    repoRoot: config.repoRoot,
    host: config.host,
    port: config.port,
    ports: config.ports,
    authDisabled: config.authDisabled,
    adminPasswordEnvManaged: config.adminPasswordEnvManaged,
    secureCookies: config.secureCookies,
    allowHostBootstrap: config.allowHostBootstrap,
    mockMode: config.mockMode
  };
}
