import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTerrainAssetCache, decodeHeightField, decodeIndices, decodeSandBase, joinShared, loadLayoutAssets, loadSharedAssets } from "./terrainAssets";
import type { TerrainLibrary } from "./types";

// Production resolves hashed URLs out of the Vite bundle; tests inject a plain
// one so the fetch mock can key on readable paths.
const at = (name: string) => `/base/${name}`;

// jsdom does not give Blob a .stream(), so compress by writing into a
// CompressionStream directly rather than piping one through it.
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  // TS 5.7 types Uint8Array over a generic buffer, which no longer satisfies
  // BufferSource; the value is a plain byte array at runtime.
  void writer.write(bytes as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** Response whose .body is a real ReadableStream, which is what the loader reads. */
function bytesResponse(body: Uint8Array, status = 200): Response {
  return new Response(body as unknown as BodyInit, { status });
}

const gzipJson = (value: unknown) => gzip(new TextEncoder().encode(JSON.stringify(value)));

// One textured mesh: a single UV pair, and one 4x4 BC1 layer (a single 8-byte block).
const library = {
  posBytes: 6,
  nrmBytes: 2,
  idxBytes: 2,
  uvBytes: 8,
  texLayers: 1,
  texSize: 4,
  meshes: [{ lo: [0, 0, 0], ext: [1, 1, 1], vo: 0, vn: 1, io: 0, ic: 1, texLayer: 0, texGain: 1, uvo: 0 }]
};

function layoutMeta(layout: number) {
  return { layout, nInst: 1, tris: 1, zmin: 0, zmax: 1, cx: 0, cy: 0, half: 1, floorZ: 0,
    hfN: 2, hfZlo: 0, hfZhi: 1, hfStep: 1, hfX0: 0, hfY0: 0, draws: [{ m: 0, off: 0, n: 1, overlay: 0 }] };
}

// The encoder's side of the height coding, so the decoder is tested against it.
const zigzag = (step: number) => (((step << 16) >> 16) << 1 ^ ((step << 16) >> 31)) & 0xffff;
function planes(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  values.forEach((v, k) => {
    out[k] = v >> 8;
    out[values.length + k] = v & 0xff;
  });
  return out;
}
function codeSandBase(field: number[], n: number): Uint8Array {
  return planes(field.map((v, k) => {
    const i = k % n;
    const j = Math.floor(k / n);
    const predicted = i === 0 ? (j === 0 ? 0 : field[k - n]) : j === 0 ? field[k - 1] : field[k - 1] + field[k - n] - field[k - n - 1];
    return zigzag(v - predicted);
  }));
}
const SAND_BASE = { n: 2, zlo: -100, zstep: 2, coding: "zigzag-delta2d" };
const BASE_FIELD = [10, 4000, 9, 65000];
const CODED_LAYOUT_FIELD = [10, 3990, 300, 2];
const codedLayoutMeta = (layout: number) => ({ ...layoutMeta(layout), hfZlo: -100, hfZhi: -100 + 65535 * 2, hfCoding: "base-diff" });

let requests: string[] = [];

// A faithful fetch: it honours an AbortSignal mid-flight, which is the whole
// point of the tests below. A mock that ignores the signal cannot tell a shared
// loader that leaks one caller's abort from one that does not.
function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

function installFetch(overrides: Record<string, () => Promise<Response>> = {}) {
  const deliver = (body: Uint8Array, signal?: AbortSignal | null) =>
    new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      setTimeout(() => resolve(bytesResponse(body)), 0);
    });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (overrides[url]) return overrides[url]();
    const signal = init?.signal;
    if (url.endsWith("meshes.json.gz")) return deliver(await gzipJson(library), signal);
    if (url.endsWith("meshes.bin.gz")) return deliver(await gzip(new Uint8Array(10)), signal);
    if (url.endsWith("rock-uv.bin.gz")) return deliver(await gzip(new Uint8Array(8)), signal);
    if (url.endsWith("tex/rock.bin.gz")) return deliver(await gzip(new Uint8Array(8)), signal);
    if (url.endsWith("outside.json.gz")) return deliver(await gzipJson({ nInst: 2, zmax: 9000, draws: [{ m: 0, off: 0, n: 2 }] }), signal);
    if (url.endsWith("outside.bin.gz")) return deliver(await gzip(new Uint8Array(112)), signal);
    // A ring one texel deep round the 2x2 layout field: all 16 texels of the 4x4, 2 bytes each.
    if (url.endsWith("sand-ring.json.gz")) return deliver(await gzipJson({ pad: 1, n: 2, zlo: 0, zstep: 1 }), signal);
    if (url.endsWith("sand-ring.bin.gz")) return deliver(await gzip(new Uint8Array(32)), signal);
    // One placement every layout shares, all 2s, for mesh 0.
    if (url.endsWith("rock-common.json.gz")) return deliver(await gzipJson({ nInst: 1, draws: [{ m: 0, overlay: 0, off: 0, n: 1 }] }), signal);
    if (url.endsWith("rock-common.bin.gz")) return deliver(await gzip(new Uint8Array(new Float32Array(14).fill(2).buffer)), signal);
    if (url.includes("/tex/")) return deliver(await gzip(new Uint8Array(4)), signal);
    if (url.endsWith("sand-base.json.gz")) return deliver(await gzipJson(SAND_BASE), signal);
    if (url.endsWith("sand-base.bin.gz")) return deliver(await gzip(codeSandBase(BASE_FIELD, 2)), signal);
    const match = url.match(/layout-(\d+)\.(json|bin|hf)\.gz$/);
    if (match) {
      const n = Number(match[1]);
      if (match[2] === "json") return deliver(await gzipJson(layoutMeta(n)), signal);
      if (match[2] === "bin") return deliver(await gzip(new Uint8Array(56)), signal);
      return deliver(await gzip(new Uint8Array(2 * 2 * 2)), signal); // hfN=2 -> 8 bytes
    }
    return new Response("nope", { status: 404 });
  }));
}

beforeEach(() => {
  requests = [];
  clearTerrainAssetCache();
  installFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("loadSharedAssets", () => {
  it("inflates the library and its textures", async () => {
    const shared = await loadSharedAssets(at);
    expect(shared.library.meshes).toHaveLength(1);
    expect(shared.geometry.byteLength).toBe(10);
    expect(shared.detail1.byteLength).toBe(4);
    expect(shared.rockUV.byteLength).toBe(8);
    expect(shared.rockTex.byteLength).toBe(8);
  });

  it("is fetched once and then reused, so a layout switch costs nothing", async () => {
    await loadSharedAssets(at);
    await loadSharedAssets(at);
    expect(requests.filter((u) => u.endsWith("meshes.bin.gz"))).toHaveLength(1);
  });

  it("rejects a geometry blob that does not match its own table", async () => {
    clearTerrainAssetCache();
    installFetch({ "/base/meshes.bin.gz": async () => bytesResponse(await gzip(new Uint8Array(3))) });
    await expect(loadSharedAssets(at)).rejects.toThrow(/table describes/);
  });

  it("rejects rock UVs that do not match the library", async () => {
    clearTerrainAssetCache();
    installFetch({ "/base/rock-uv.bin.gz": async () => bytesResponse(await gzip(new Uint8Array(16))) });
    await expect(loadSharedAssets(at)).rejects.toThrow(/rock UVs are 16 bytes, the library describes 8/);
  });

  it("loads the rock outside the map with the shared half, and rejects a short block", async () => {
    clearTerrainAssetCache();
    installFetch();
    const shared = await loadSharedAssets(at);
    expect(shared.outside.nInst).toBe(2);
    expect(shared.outsideInstances.byteLength).toBe(112);

    clearTerrainAssetCache();
    installFetch({ "/base/outside.bin.gz": async () => bytesResponse(await gzip(new Uint8Array(56))) });
    await expect(loadSharedAssets(at)).rejects.toThrow(/outside rock is 56 bytes, its table describes 2 instances/);
  });

  it("loads the sand ring with the shared half, and rejects a short one", async () => {
    clearTerrainAssetCache();
    installFetch();
    const shared = await loadSharedAssets(at);
    expect(shared.sandRing.pad).toBe(1);
    expect(shared.sandRingField.byteLength).toBe(32);

    clearTerrainAssetCache();
    installFetch({ "/base/sand-ring.bin.gz": async () => bytesResponse(await gzip(new Uint8Array(30))) });
    await expect(loadSharedAssets(at)).rejects.toThrow(/sand ring is 30 bytes, its table describes 16 heights/);
  });

  it("joins the ring to a layout once, so the renderer sees one object per layout", async () => {
    clearTerrainAssetCache();
    installFetch();
    const [shared, layout] = await Promise.all([loadSharedAssets(at), loadLayoutAssets(3, at)]);
    const joined = joinShared(shared, layout);
    expect(joined.meta.hfN).toBe(4);
    expect(joined.heightField.byteLength).toBe(4 * 4 * 2);
    expect(joined.instances).toBe(layout.instances);
    expect(layout.meta.hfN).toBe(2);
    expect(joinShared(shared, layout)).toBe(joined);
    // An unsplit layout keeps its placements as they are.
    expect(joined.meta.draws).toEqual(layout.meta.draws);
  });

  it("puts the shared placements back into a split layout, ahead of its own", async () => {
    clearTerrainAssetCache();
    const own = new Float32Array(14).fill(1);
    installFetch({
      "/base/layout-5.json.gz": async () => bytesResponse(await gzipJson({ ...layoutMeta(5), common: 1 })),
      "/base/layout-5.bin.gz": async () => bytesResponse(await gzip(new Uint8Array(own.buffer)))
    });
    const [shared, layout] = await Promise.all([loadSharedAssets(at), loadLayoutAssets(5, at)]);
    const joined = joinShared(shared, layout);
    expect(joined.meta.draws).toEqual([{ m: 0, off: 0, n: 2, overlay: 0 }]);
    const floats = new Float32Array(joined.instances.slice().buffer);
    expect(floats[0]).toBe(2);
    expect(floats[14]).toBe(1);
  });

  it("rejects shared placements that do not match their table", async () => {
    clearTerrainAssetCache();
    installFetch({ "/base/rock-common.bin.gz": async () => bytesResponse(await gzip(new Uint8Array(28))) });
    await expect(loadSharedAssets(at)).rejects.toThrow(/shared placements are 28 bytes, their table describes 1/);
  });

  it("refuses mesh indices stored in a way it cannot read", async () => {
    clearTerrainAssetCache();
    installFetch({ "/base/meshes.json.gz": async () => bytesResponse(await gzipJson({ ...library, idxCoding: "something-new" })) });
    await expect(loadSharedAssets(at)).rejects.toThrow(/stored as something-new/);
  });

  it("rejects a rock texture that is not whole BC1 layers", async () => {
    clearTerrainAssetCache();
    installFetch({ "/base/tex/rock.bin.gz": async () => bytesResponse(await gzip(new Uint8Array(12))) });
    await expect(loadSharedAssets(at)).rejects.toThrow(/expected 1 BC1 layers of 4\^2/);
  });

  it("does not cache a failure, so a retry can still succeed", async () => {
    clearTerrainAssetCache();
    installFetch({ "/base/meshes.bin.gz": async () => new Response("boom", { status: 500 }) });
    await expect(loadSharedAssets(at)).rejects.toThrow(/500/);
    installFetch();
    await expect(loadSharedAssets(at)).resolves.toBeTruthy();
  });
});

describe("loadLayoutAssets", () => {
  it("inflates a layout's instances and height field", async () => {
    const layout = await loadLayoutAssets(3, at);
    expect(layout.meta.layout).toBe(3);
    expect(layout.instances.byteLength).toBe(56);
    expect(layout.heightField.byteLength).toBe(8);
  });

  it("rebuilds a height field stored against the shared sand base", async () => {
    installFetch({
      "/base/layout-3.json.gz": async () => bytesResponse(await gzipJson(codedLayoutMeta(3))),
      "/base/layout-3.hf.gz": async () => bytesResponse(await gzip(planes(CODED_LAYOUT_FIELD.map((v, k) => zigzag(v - BASE_FIELD[k])))))
    });
    const layout = await loadLayoutAssets(3, at);
    expect([...new Uint16Array(layout.heightField.buffer)]).toEqual(CODED_LAYOUT_FIELD);
    // Decoded, it is an ordinary layout: nothing downstream sees the coding.
    expect(layout.meta.hfCoding).toBeUndefined();
    expect(layout.meta.hfZlo).toBe(-100);
  });

  it("fetches the sand base once, whichever layouts ask for it", async () => {
    const coded = (n: number) => ({
      [`/base/layout-${n}.json.gz`]: async () => bytesResponse(await gzipJson(codedLayoutMeta(n))),
      [`/base/layout-${n}.hf.gz`]: async () => bytesResponse(await gzip(new Uint8Array(8)))
    });
    installFetch({ ...coded(3), ...coded(7) });
    const [three, seven] = await Promise.all([loadLayoutAssets(3, at), loadLayoutAssets(7, at)]);
    expect(requests.filter((u) => u.endsWith("sand-base.bin.gz"))).toHaveLength(1);
    // A layout that differs nowhere is the base itself.
    expect([...new Uint16Array(three.heightField.buffer)]).toEqual(BASE_FIELD);
    expect([...new Uint16Array(seven.heightField.buffer)]).toEqual(BASE_FIELD);
  });

  it("does not fetch the sand base for a plain height field", async () => {
    await loadLayoutAssets(3, at);
    expect(requests.filter((u) => u.includes("sand-base"))).toHaveLength(0);
  });

  it("refuses a height coding it does not know rather than drawing garbage", async () => {
    installFetch({ "/base/layout-3.json.gz": async () => bytesResponse(await gzipJson({ ...codedLayoutMeta(3), hfCoding: "wavelet" })) });
    await expect(loadLayoutAssets(3, at)).rejects.toThrow(/wavelet/);
  });

  it("refuses a layout whose height scale is not the sand base's", async () => {
    installFetch({ "/base/layout-3.json.gz": async () => bytesResponse(await gzipJson({ ...codedLayoutMeta(3), hfZlo: 0 })) });
    await expect(loadLayoutAssets(3, at)).rejects.toThrow(/sand base/);
  });

  it("rejects a height field that does not match the declared hfN", async () => {
    installFetch({ "/base/layout-3.hf.gz": async () => bytesResponse(await gzip(new Uint8Array(6))) });
    await expect(loadLayoutAssets(3, at)).rejects.toThrow(/height field/);
  });

  it("keeps two layouts, so switching back after a reset does not re-download", async () => {
    await loadLayoutAssets(3, at);
    await loadLayoutAssets(7, at);
    await loadLayoutAssets(3, at);
    expect(requests.filter((u) => u.endsWith("layout-3.bin.gz"))).toHaveLength(1);
  });

  it("evicts the least recently used rather than holding all twelve", async () => {
    // All twelve decompressed height fields would be hundreds of megabytes.
    await loadLayoutAssets(0, at);
    await loadLayoutAssets(1, at);
    await loadLayoutAssets(2, at);
    await loadLayoutAssets(0, at);
    expect(requests.filter((u) => u.endsWith("layout-0.bin.gz"))).toHaveLength(2);
    expect(requests.filter((u) => u.endsWith("layout-2.bin.gz"))).toHaveLength(1);
  });

  it("rejects for the caller that aborted", async () => {
    const controller = new AbortController();
    const pending = loadLayoutAssets(5, at, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });
});

// Finding 1 of the branch review: the caches held the FIRST caller's signal, so
// a second mount inherited an abort it never asked for and the panel reported
// the terrain permanently unavailable. React StrictMode mounts, unmounts and
// remounts every effect, so this was not an edge case -- it was every dev run.
describe("a shared cache must not leak one caller's abort", () => {
  it("still serves the next caller after the first mount aborts", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const abandoned = loadSharedAssets(at, first.signal);
    abandoned.catch(() => {});
    first.abort();

    const shared = await loadSharedAssets(at, second.signal);
    expect(shared.library.meshes).toHaveLength(1);
    await expect(abandoned).rejects.toThrow(/abort/i);
  });

  it("does the same for a layout, which is what a StrictMode remount reloads", async () => {
    const first = new AbortController();
    const abandoned = loadLayoutAssets(3, at, first.signal);
    abandoned.catch(() => {});
    first.abort();

    await expect(loadLayoutAssets(3, at, new AbortController().signal)).resolves.toMatchObject({
      meta: { layout: 3 }
    });
  });

  it("lets an abandoned load finish and fill the cache rather than binning the bytes", async () => {
    const first = new AbortController();
    const abandoned = loadSharedAssets(at, first.signal);
    abandoned.catch(() => {});
    first.abort();
    await expect(abandoned).rejects.toThrow(/abort/i);

    await loadSharedAssets(at);
    // One fetch in total: the abandoned one was still worth keeping.
    expect(requests.filter((u) => u.endsWith("meshes.bin.gz"))).toHaveLength(1);
  });

  it("rejects immediately when handed an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadSharedAssets(at, controller.signal)).rejects.toThrow(/abort/i);
  });
});

// Finding 2: Vite's dev and preview servers answer a *.gz file with
// Content-Encoding: gzip, so the browser inflates it before the loader sees it
// and piping it through DecompressionStream throws. Production sets no such
// header. Both shapes have to work.
describe("a server that already inflated the body", () => {
  it("uses the body as-is when Content-Encoding says the browser inflated it", async () => {
    const plain = new TextEncoder().encode(JSON.stringify(library));
    installFetch({
      "/base/meshes.json.gz": async () =>
        new Response(plain as unknown as BodyInit, { headers: { "content-encoding": "gzip" } })
    });
    const shared = await loadSharedAssets(at);
    expect(shared.library.meshes).toHaveLength(1);
  });

  it("still inflates when the response carries no encoding header, as production serves it", async () => {
    const shared = await loadSharedAssets(at);
    expect(shared.library.meshes).toHaveLength(1);
    expect(shared.geometry.byteLength).toBe(10);
  });
});

describe("decodeIndices", () => {
  /** The pipeline's encoding: the step from the previous index, wrapped to 16 bits and zigzagged. */
  function encode(indices: number[]): number[] {
    let prev = 0;
    return indices.map((v) => {
      const s = ((v - prev + 32768 + 65536) % 65536) - 32768;
      prev = v;
      return ((s << 1) ^ (s >> 15)) & 0xffff;
    });
  }

  it("restores each mesh's indices, steps back and forth and across the 16-bit wrap included", () => {
    const meshes = [[0, 1, 2, 2, 1, 3], [65535, 0, 7, 40000, 3, 65535]];
    const coded = meshes.flatMap(encode);
    // 4 bytes of positions and normals ahead of the indices
    const geometry = new Uint8Array(4 + coded.length * 2);
    new Uint16Array(geometry.buffer, 4).set(coded);
    const lib = {
      posBytes: 2, nrmBytes: 2, idxBytes: coded.length * 2, idxCoding: "zigzag-delta",
      meshes: [{ io: 0, ic: 6 }, { io: 6, ic: 6 }]
    } as unknown as TerrainLibrary;
    const plain = decodeIndices(lib, geometry);
    expect(Array.from(new Uint16Array(geometry.buffer, 4))).toEqual(meshes.flat());
    expect(plain.idxCoding).toBeUndefined();
  });

  it("leaves a plain library alone", () => {
    const lib = { posBytes: 0, nrmBytes: 0, idxBytes: 2, meshes: [{ io: 0, ic: 1 }] } as unknown as TerrainLibrary;
    const geometry = new Uint8Array(new Uint16Array([9]).buffer);
    expect(decodeIndices(lib, geometry)).toBe(lib);
    expect(new Uint16Array(geometry.buffer)[0]).toBe(9);
  });
});

describe("decodeSandBase", () => {
  it("undoes the neighbour prediction, wrapping at 16 bits", () => {
    const field = [0, 65535, 3, 40000, 12, 13, 65535, 0, 7];
    expect([...decodeSandBase({ ...SAND_BASE, n: 3 }, codeSandBase(field, 3))]).toEqual(field);
  });

  it("refuses a coding it does not know", () => {
    expect(() => decodeSandBase({ ...SAND_BASE, coding: "raw" }, new Uint8Array(8))).toThrow(/raw/);
  });

  it("refuses a grid of the wrong size", () => {
    expect(() => decodeSandBase(SAND_BASE, new Uint8Array(6))).toThrow(/sand base/);
  });
});

describe("decodeHeightField", () => {
  it("adds each texel's step to the base, either way", () => {
    const base = { info: SAND_BASE, field: new Uint16Array(BASE_FIELD) };
    const coded = planes(CODED_LAYOUT_FIELD.map((v, k) => zigzag(v - BASE_FIELD[k])));
    const { heightField } = decodeHeightField(codedLayoutMeta(3), coded, base);
    expect([...new Uint16Array(heightField.buffer)]).toEqual(CODED_LAYOUT_FIELD);
  });
});
