/// <reference types="vite/client" />
import { beforeAll, describe, expect, it } from "vitest";
import { decodeHeightField, decodeSandBase, type SandBase } from "./terrainAssets";
import { interpolateHeightField } from "./terrainGeometry";
import type { TerrainLayoutMeta, TerrainSandBase } from "./types";

// The shipped files themselves: they are written by a script outside this repo,
// so this is what ties them to the decoder.
const inlined = import.meta.glob(["./assets/sand-base.*.gz", "./assets/layout-*.hf.gz", "./assets/layout-*.json.gz"], {
  query: "?inline",
  import: "default",
  eager: true
}) as Record<string, string>;

async function read(name: string): Promise<Uint8Array> {
  const packed = Uint8Array.from(atob(inlined[`./assets/${name}`].split(",")[1]), (c) => c.charCodeAt(0));
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(packed as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
const readJson = async <T>(name: string) => JSON.parse(new TextDecoder().decode(await read(name))) as T;

let base: SandBase;
beforeAll(async () => {
  const info = await readJson<TerrainSandBase>("sand-base.json.gz");
  base = { info, field: decodeSandBase(info, await read("sand-base.bin.gz")) };
});

async function layout(n: number) {
  const { meta, heightField } = decodeHeightField(await readJson<TerrainLayoutMeta>(`layout-${n}.json.gz`), await read(`layout-${n}.hf.gz`), base);
  return { meta, field: new Uint16Array(heightField.buffer) };
}

describe("the shipped height fields", () => {
  it("decode for all twelve layouts, mostly to the shared base and within the sand's range", async () => {
    for (let n = 0; n < 12; n++) {
      const { meta, field } = await layout(n);
      expect(field).toHaveLength(meta.hfN * meta.hfN);
      let same = 0;
      let top = 0;
      for (let k = 0; k < field.length; k++) {
        if (field[k] === base.field[k]) same++;
        if (field[k] > top) top = field[k];
      }
      expect(same / field.length).toBeGreaterThan(0.7);
      // No dune is taller than about 26,000 uu; a wrapped or mis-added texel would be.
      expect(base.info.zlo + top * base.info.zstep).toBeLessThan(30000);
    }
  });

  it("give the heights the plain files gave, to within the 2 uu step", async () => {
    // Read from the uncoded files before they were replaced.
    for (const [n, x, y, height] of [[3, -30000, 350000, 3389.07], [3, 888560, -721240, 3521.38], [10, -52656, -52066, 1027.11], [0, 900000, -710000, 4006.34]]) {
      const { meta, field } = await layout(n);
      expect(Math.abs(interpolateHeightField(field, meta, x, y) - height)).toBeLessThan(1.5);
    }
  });
});
