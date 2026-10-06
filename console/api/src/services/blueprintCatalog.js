import { blueprintForGameDownload } from "./blueprintGameFormat.js";

const DEFAULT_CATALOG_URL = "https://blueprints.dunedocker.app/api/v1/blueprints";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_BLUEPRINT_PIECES = 5000;
const BLUEPRINT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function catalogError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function catalogBaseUrl(value = process.env.DUNE_BLUEPRINT_CATALOG_URL || DEFAULT_CATALOG_URL) {
  const url = new URL(String(value));
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw catalogError("The Blueprint catalog must use HTTPS.", 500);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function blueprintId(value) {
  const id = String(value || "").trim();
  if (!BLUEPRINT_ID_PATTERN.test(id)) throw catalogError("Invalid community Blueprint ID.", 400);
  return id;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

async function catalogFetch(fetchImpl, url, { maxBytes, accept }) {
  if (typeof fetchImpl !== "function") throw catalogError("Blueprint catalog access is unavailable.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers: { accept, "user-agent": "dune-docker-console" },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) {
      if (response.status === 404) throw catalogError("That public Blueprint is no longer available.", 404);
      if (response.status === 429) throw catalogError("The Blueprint catalog is busy. Wait a moment and try again.", 503);
      throw catalogError(`The Blueprint catalog returned HTTP ${response.status}.`);
    }
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw catalogError("The Blueprint catalog response is too large.", 413);
    const reader = response.body?.getReader?.();
    if (!reader) throw catalogError("The Blueprint catalog returned an empty response.");
    const chunks = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw catalogError("The Blueprint catalog response is too large.", 413);
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, byteLength);
    return { response, bytes };
  } catch (error) {
    if (error?.statusCode) throw error;
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw catalogError("The Blueprint catalog timed out.", 504);
    throw catalogError("The Blueprint catalog could not be reached.");
  } finally {
    clearTimeout(timer);
  }
}

async function catalogJson(fetchImpl, url) {
  const { bytes } = await catalogFetch(fetchImpl, url, { maxBytes: MAX_JSON_BYTES, accept: "application/json" });
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw catalogError("The Blueprint catalog returned invalid data.");
  }
}

function publicSummary(row) {
  if (!row || typeof row !== "object") return null;
  const id = String(row.id || "");
  if (!BLUEPRINT_ID_PATTERN.test(id)) return null;
  return {
    id,
    title: String(row.title || "Untitled Blueprint").slice(0, 100),
    description: String(row.description || "").slice(0, 2000),
    ownerName: String(row.owner_name || "Community Builder").slice(0, 100),
    buildingSet: String(row.building_set || "General").slice(0, 60),
    tags: Array.isArray(row.tags) ? row.tags.map((tag) => String(tag).slice(0, 30)).slice(0, 10) : [],
    pieces: boundedInteger(row.piece_count, 0, 0, MAX_BLUEPRINT_PIECES),
    placeables: boundedInteger(row.placeable_count, 0, 0, MAX_BLUEPRINT_PIECES),
    likes: boundedInteger(row.like_count, 0, 0, Number.MAX_SAFE_INTEGER),
    downloads: boundedInteger(row.download_count, 0, 0, Number.MAX_SAFE_INTEGER),
    version: boundedInteger(row.version, 1, 1, Number.MAX_SAFE_INTEGER),
    hasPreview: row.has_preview === true,
    previewNight: row.preview_night === true,
    updatedAt: String(row.updated_at || "")
  };
}

export async function listCommunityBlueprints(query = {}, options = {}) {
  const base = catalogBaseUrl(options.baseUrl);
  const url = new URL(base);
  url.searchParams.set("q", String(query.q || "").trim().slice(0, 100));
  url.searchParams.set("set", String(query.set || "").trim().slice(0, 60));
  url.searchParams.set("sort", ["newest", "popular", "downloads"].includes(query.sort) ? query.sort : "newest");
  url.searchParams.set("limit", String(boundedInteger(query.limit, 20, 1, 60)));
  url.searchParams.set("offset", String(boundedInteger(query.offset, 0, 0, 1_000_000)));
  const body = await catalogJson(options.fetchImpl || globalThis.fetch, url);
  const rows = Array.isArray(body?.blueprints) ? body.blueprints.map(publicSummary).filter(Boolean) : [];
  return {
    rows,
    total: boundedInteger(body?.total, rows.length, 0, 1_000_000),
    limit: boundedInteger(body?.limit, 20, 1, 60),
    offset: boundedInteger(body?.offset, 0, 0, 1_000_000)
  };
}

export async function getCommunityBlueprint(idValue, options = {}) {
  const id = blueprintId(idValue);
  const base = catalogBaseUrl(options.baseUrl);
  const url = new URL(`${base.pathname}/${encodeURIComponent(id)}/console-download`, base);
  const body = await catalogJson(options.fetchImpl || globalThis.fetch, url);
  const row = body?.blueprint;
  if (!row || row.visibility !== "public" || row.status !== "published" || !row.blueprint || typeof row.blueprint !== "object") {
    throw catalogError("That public Blueprint is no longer available.", 404);
  }
  const instances = Array.isArray(row.blueprint.instances) ? row.blueprint.instances.length : 0;
  const placeables = Array.isArray(row.blueprint.placeables) ? row.blueprint.placeables.length : 0;
  const pentashields = Array.isArray(row.blueprint.pentashields) ? row.blueprint.pentashields.length : 0;
  if (instances + placeables + pentashields > MAX_BLUEPRINT_PIECES) throw catalogError("That Blueprint exceeds the supported piece limit.", 413);
  return { summary: publicSummary(row), blueprint: blueprintForGameDownload(row.blueprint) };
}

export async function getCommunityBlueprintPreview(idValue, options = {}) {
  const id = blueprintId(idValue);
  const base = catalogBaseUrl(options.baseUrl);
  const url = new URL(`${base.pathname}/${encodeURIComponent(id)}/preview`, base);
  const { response, bytes } = await catalogFetch(options.fetchImpl || globalThis.fetch, url, {
    maxBytes: MAX_PREVIEW_BYTES,
    accept: "image/avif,image/webp,image/png,image/jpeg"
  });
  const contentType = String(response.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!new Set(["image/avif", "image/webp", "image/png", "image/jpeg"]).has(contentType)) {
    throw catalogError("The Blueprint preview has an unsupported format.");
  }
  return { bytes, contentType };
}
