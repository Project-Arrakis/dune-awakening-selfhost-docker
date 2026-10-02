import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTerrainAssetCache, decodeIndices, loadLayoutAssets, loadSharedAssets } from "./terrainAssets";
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
    if (url.includes("/tex/")) return deliver(await gzip(new Uint8Array(4)), signal);
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
