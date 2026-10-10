import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_BROKER_URL = "https://dunedocker.app/api/v1/qa";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const sessions = new Map();

export function createQaUpdates(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const brokerUrl = String(options.brokerUrl || process.env.DUNE_QA_BROKER_URL || DEFAULT_BROKER_URL).replace(/\/+$/, "");
  const now = options.now || (() => Date.now());

  async function start(consoleSessionId) {
    const result = await request(fetchImpl, `${brokerUrl}/device`, { method: "POST" });
    const token = cleanToken(result.token);
    const authorizeUrl = safeHttpsUrl(result.authorizeUrl);
    const requestId = cleanId(result.requestId);
    if (!token || !authorizeUrl || !requestId) throw new Error("The QA authorization service returned an invalid response.");
    sessions.set(consoleSessionId, { token, requestId, expiresAt: now() + 10 * 60 * 1000, authorized: false, user: null });
    return { requestId, authorizeUrl, status: "pending" };
  }

  async function status(consoleSessionId, { refresh = false } = {}) {
    const local = activeSession(consoleSessionId, now());
    const channel = readQaChannel(config.repoRoot);
    if (!local) return { authenticated: false, status: "signed_out", channel };
    if (!refresh && local.authorized && local.expiresAt > now() + 30_000) {
      return { authenticated: true, status: "authorized", user: local.user, expiresAt: new Date(local.expiresAt).toISOString(), channel };
    }
    const result = await request(fetchImpl, `${brokerUrl}/session`, { headers: { authorization: `Bearer ${local.token}` } });
    if (result.status === "pending") return { authenticated: false, status: "pending", requestId: local.requestId, channel };
    if (result.status !== "authorized") {
      sessions.delete(consoleSessionId);
      return { authenticated: false, status: "denied", reason: String(result.reason || "QA access was not approved."), channel };
    }
    local.authorized = true;
    local.user = normalizeUser(result.user);
    local.expiresAt = safeExpiry(result.expiresAt, now());
    return { authenticated: true, status: "authorized", user: local.user, expiresAt: new Date(local.expiresAt).toISOString(), channel };
  }

  async function build(consoleSessionId) {
    const local = await requireAuthorized(consoleSessionId);
    const result = await request(fetchImpl, `${brokerUrl}/build`, { headers: { authorization: `Bearer ${local.token}` } });
    const sha = String(result.sha || "").toLowerCase();
    if (!SHA_PATTERN.test(sha)) throw new Error("The QA authorization service returned an invalid build identifier.");
    const channel = readQaChannel(config.repoRoot);
    return {
      sha,
      shortSha: sha.slice(0, 8),
      commitUrl: safeHttpsUrl(result.commitUrl),
      committedAt: safeTimestamp(result.committedAt),
      ready: result.ready === true,
      status: cleanLabel(result.status, 80) || "Unavailable",
      reason: cleanLabel(result.reason, 240),
      installedSha: channel.channel === "qa" ? channel.commitSha : "",
      commitsAheadOfRelease: boundedCount(result.commitsAheadOfRelease),
      updateAvailable: result.ready === true && (channel.channel === "qa" ? channel.commitSha !== sha : boundedCount(result.commitsAheadOfRelease) > 0),
      channel
    };
  }

  async function requireAuthorized(consoleSessionId) {
    const state = await status(consoleSessionId, { refresh: true });
    if (!state.authenticated) throw Object.assign(new Error(state.reason || "QA Tester Login is required."), { statusCode: 403 });
    return sessions.get(consoleSessionId);
  }

  async function logout(consoleSessionId) {
    const local = sessions.get(consoleSessionId);
    sessions.delete(consoleSessionId);
    if (local?.token) {
      await request(fetchImpl, `${brokerUrl}/logout`, { method: "POST", headers: { authorization: `Bearer ${local.token}` } }).catch(() => {});
    }
  }

  return { start, status, build, requireAuthorized, logout };
}

export function readQaChannel(repoRoot) {
  const path = join(repoRoot, "runtime", "generated", "qa-update-channel.env");
  let source = "";
  try { source = readFileSync(path, "utf8"); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const values = Object.fromEntries(source.split(/\r?\n/).map((line) => line.split("=", 2)).filter(([key, value]) => /^[a-z_]+$/.test(key || "") && value !== undefined));
  const commitSha = SHA_PATTERN.test(values.commit_sha || "") ? values.commit_sha.toLowerCase() : "";
  return commitSha
    ? { channel: "qa", label: "QA Pre-Release", commitSha, shortSha: commitSha.slice(0, 8), installedAt: safeTimestamp(values.installed_at) }
    : { channel: "release", label: "Public Release", commitSha: "", shortSha: "", installedAt: null };
}

async function request(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal, headers: { accept: "application/json", ...(options.headers || {}) } });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) throw Object.assign(new Error(String(body.error || "The QA authorization service is unavailable.")), { statusCode: response.status });
    return body;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("The QA authorization service timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function activeSession(id, now) {
  const session = sessions.get(id);
  if (!session || session.expiresAt <= now) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function cleanToken(value) { const token = String(value || ""); return /^[A-Za-z0-9_-]{32,200}$/.test(token) ? token : ""; }
function cleanId(value) { const id = String(value || ""); return /^[A-Za-z0-9_-]{16,100}$/.test(id) ? id : ""; }
function cleanLabel(value, max) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max); }
function safeHttpsUrl(value) { try { const url = new URL(String(value || "")); return url.protocol === "https:" ? url.toString() : ""; } catch { return ""; } }
function safeTimestamp(value) { const text = String(value || ""); return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null; }
function safeExpiry(value, now) { const parsed = Date.parse(String(value || "")); return Number.isFinite(parsed) && parsed > now ? Math.min(parsed, now + 60 * 60 * 1000) : now + 15 * 60 * 1000; }
function normalizeUser(value) { return { id: cleanLabel(value?.id, 24), username: cleanLabel(value?.username, 100), avatarUrl: safeHttpsUrl(value?.avatarUrl), role: normalizeQaRole(value?.role) }; }
function normalizeQaRole(value) { const role = cleanLabel(value, 40); return ["Founder", "Core Contributor", "QA Tester"].includes(role) ? role : "QA Tester"; }
function boundedCount(value) { const number = Number(value); return Number.isInteger(number) && number >= 0 && number <= 100000 ? number : 0; }
