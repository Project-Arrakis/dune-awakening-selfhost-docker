import test from "node:test";
import assert from "node:assert/strict";
import { getCommunityBlueprint, getCommunityBlueprintPreview, listCommunityBlueprints } from "../src/services/blueprintCatalog.js";

const id = "11111111-1111-4111-8111-111111111111";

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...(init.headers || {}) }, ...init });
}

test("community catalog forwards bounded filters and exposes only normalized summaries", async () => {
  let requested;
  const result = await listCommunityBlueprints({ q: " desert ", set: "CHOAM", sort: "popular", limit: 500, offset: -8 }, {
    baseUrl: "http://localhost/api/v1/blueprints",
    fetchImpl: async (url) => {
      requested = new URL(url);
      return jsonResponse({
        blueprints: [{ id, title: "Desert Keep", description: "A compact base", owner_name: "Chani", building_set: "CHOAM", tags: ["pve"], piece_count: 42, placeable_count: 7, like_count: 3, download_count: 5, version: 2, has_preview: true, preview_night: false, updated_at: "2026-09-14T00:00:00Z", owner_discord_id: "private" }],
        total: 1,
        limit: 60,
        offset: 0
      });
    }
  });
  assert.equal(requested.pathname, "/api/v1/blueprints");
  assert.deepEqual(Object.fromEntries(requested.searchParams), { q: "desert", set: "CHOAM", sort: "popular", limit: "60", offset: "0" });
  assert.deepEqual(result.rows[0], {
    id, title: "Desert Keep", description: "A compact base", ownerName: "Chani", buildingSet: "CHOAM", tags: ["pve"],
    pieces: 42, placeables: 7, likes: 3, downloads: 5, version: 2, hasPreview: true, previewNight: false, updatedAt: "2026-09-14T00:00:00Z"
  });
  assert.equal("owner_discord_id" in result.rows[0], false);
});

test("community install source converts Studio projects and accepts only public published Blueprints", async () => {
  const blueprint = { instances: [{ building_type: "Foundation", x: 0, y: 0, z: 0, rotation: 80 }], placeables: [], designer: { coordinateConvention: "studio-v10" } };
  let requested;
  const allowed = await getCommunityBlueprint(id, {
    baseUrl: "http://localhost/api/v1/blueprints",
    fetchImpl: async (url) => { requested = new URL(url); return jsonResponse({ blueprint: { id, title: "Keep", owner_name: "Chani", visibility: "public", status: "published", blueprint } }); }
  });
  assert.equal(requested.pathname, `/api/v1/blueprints/${id}/console-download`);
  assert.equal(allowed.blueprint.instances[0].rotation, -80);
  assert.deepEqual(allowed.blueprint.designer, { coordinateConvention: "game-v1", placeableRotationConvention: "native-yaw-y" });
  assert.equal(blueprint.instances[0].rotation, 80);

  for (const visibility of ["private", "unlisted"]) {
    await assert.rejects(() => getCommunityBlueprint(id, {
      baseUrl: "http://localhost/api/v1/blueprints",
      fetchImpl: async () => jsonResponse({ blueprint: { id, visibility, status: "published", blueprint } })
    }), /no longer available/);
  }
});

test("community catalog rejects oversized and non-image preview responses", async () => {
  await assert.rejects(() => getCommunityBlueprintPreview(id, {
    baseUrl: "http://localhost/api/v1/blueprints",
    fetchImpl: async () => new Response("not an image", { headers: { "content-type": "text/html" } })
  }), /unsupported format/);

  await assert.rejects(() => listCommunityBlueprints({}, {
    baseUrl: "http://localhost/api/v1/blueprints",
    fetchImpl: async () => new Response("{}", { headers: { "content-length": String(9 * 1024 * 1024) } })
  }), /too large/);

  await assert.rejects(() => getCommunityBlueprintPreview(id, {
    baseUrl: "http://localhost/api/v1/blueprints",
    fetchImpl: async () => new Response(Buffer.alloc(1024 * 1024 + 1), { headers: { "content-type": "image/webp" } })
  }), /too large/);
});

test("community preview preserves a validated image type and bytes", async () => {
  const preview = await getCommunityBlueprintPreview(id, {
    baseUrl: "http://localhost/api/v1/blueprints",
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } })
  });
  assert.equal(preview.contentType, "image/webp");
  assert.deepEqual(preview.bytes, Buffer.from([1, 2, 3]));
});
