import type { TerrainDrawCall, TerrainLayoutMeta, TerrainLibrary, TerrainOutside, TerrainSandRing, TerrainView } from "./types";

/**
 * A mesh over 50k uu on both horizontal axes is a landscape tile; everything
 * else (rock, patch, POI) is under 1.9k. Only the tiles overlap a neighbour, so
 * only they are feathered at their rim.
 */
const LAND_EXTENT = 50000;

/** Slack either side when mapping world Z into clip depth. */
const DEPTH_SLACK = 2.2;

/**
 * Pair each of a layout's draws with its mesh from the shared library. The
 * renderer's draw loop wants one flat record per (mesh, layout) pair: geometry
 * offsets from the library, instance range and overlay flag from the layout.
 */
export function buildDrawCalls(library: TerrainLibrary, layout: TerrainLayoutMeta): TerrainDrawCall[] {
  return layout.draws.map((draw) => {
    const mesh = library.meshes[draw.m];
    if (!mesh) throw new Error(`layout ${layout.layout} references mesh ${draw.m}, which the library does not have`);
    return {
      ...mesh,
      instOff: draw.off,
      instN: draw.n,
      overlay: draw.overlay,
      land: mesh.ext[0] > LAND_EXTENT && mesh.ext[1] > LAND_EXTENT
    };
  });
}

/**
 * A layout's draw calls and instances with the shared outside rock appended,
 * its draws offset past the layout's own instances.
 */
export function withOutside(
  calls: TerrainDrawCall[],
  instances: Float32Array,
  library: TerrainLibrary,
  outside: TerrainOutside,
  outsideInstances: Float32Array
): { calls: TerrainDrawCall[]; instances: Float32Array } {
  const base = instances.length / INSTANCE_FLOATS;
  const merged = new Float32Array(instances.length + outsideInstances.length);
  merged.set(instances);
  merged.set(outsideInstances, instances.length);
  const extra = outside.draws.map((draw) => {
    const mesh = library.meshes[draw.m];
    if (!mesh) throw new Error(`outside rock references mesh ${draw.m}, which the library does not have`);
    return { ...mesh, instOff: base + draw.off, instN: draw.n, overlay: 0, land: false };
  });
  return { calls: [...calls, ...extra], instances: merged };
}

/**
 * How far world Z is spread across clip depth. Exposed because the overlay
 * layer's depth bias is expressed in world units and has to be divided through
 * by the same number.
 */
export function depthRange(layout: Pick<TerrainLayoutMeta, "zmin" | "zmax">): number {
  return DEPTH_SLACK * Math.max(Math.abs(layout.zmax), Math.abs(layout.zmin), 1);
}

/**
 * Orthographic projection mapping a world rectangle onto the clip cube.
 *
 * This is the one piece the port genuinely changes. The prototype owned its own
 * camera and built this from a centre plus a half-extent; here the panel owns
 * pan and zoom and hands us the visible rect, so the terrain lands on exactly
 * the world rectangle the panel believes it is showing.
 *
 * Placing geometry at true world positions is also what exposed the ~8% oversize
 * in `LIVE_MAP_CONFIGS`' Deep Desert rect, since the stretched PNG visibly
 * disagreed with it. The rect is the sector square now, so the two agree.
 *
 * Screen Y runs opposite to clip Y: the panel's pixel space grows downward and
 * `flipY` is false for both maps, so increasing world Y is drawn further down.
 * Depth is negated so that higher ground wins a `LESS` depth test.
 *
 * Returns a column-major mat4 for `uniformMatrix4fv(..., false, m)`.
 */
export function orthoFromWorldRect(view: TerrainView, zRange: number): Float32Array {
  const width = view.maxX - view.minX;
  const height = view.maxY - view.minY;
  if (!(width > 0) || !(height > 0)) throw new Error("terrain view rectangle must have positive extent");

  const sx = 2 / width;
  const tx = -(view.minX + view.maxX) / width;
  // Unflipped, world +Y draws downward, so clip Y is negated.
  const flip = view.flipY ? -1 : 1;
  const sy = (-2 / height) * flip;
  const ty = ((view.minY + view.maxY) / height) * flip;

  const m = new Float32Array(16);
  m[0] = sx;
  m[5] = sy;
  m[10] = -1 / zRange;
  m[12] = tx;
  m[13] = ty;
  m[14] = 0.5;
  m[15] = 1;
  return m;
}

/** Project a world point through `orthoFromWorldRect`'s matrix. For tests and hit-testing. */
export function projectWorldPoint(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[12], m[5] * y + m[13], m[10] * z + m[14]];
}

/**
 * Decode an oct-encoded normal back to a unit vector. The shader does this
 * itself; this mirrors it so the encoding can be checked against a fixture
 * without a GPU.
 */
export function octDecode(ex: number, ey: number): [number, number, number] {
  let x = ex;
  let y = ey;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const nx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    const ny = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    x = nx;
    y = ny;
  }
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/** Dequantise a u16 position triple back to world units, as the vertex shader does. */
export function dequantizePosition(
  q: ArrayLike<number>,
  at: number,
  lo: readonly [number, number, number],
  ext: readonly [number, number, number]
): [number, number, number] {
  return [
    lo[0] + (q[at] / 65535) * ext[0],
    lo[1] + (q[at + 1] / 65535) * ext[1],
    lo[2] + (q[at + 2] / 65535) * ext[2]
  ];
}

/**
 * Height of the sand at a world point, sampled from the height field the same
 * way the shader does: nearest texel, clamped at the edges.
 */
export function sampleHeightField(field: Uint16Array, layout: TerrainLayoutMeta, x: number, y: number): number {
  const n = layout.hfN;
  const ix = Math.min(n - 1, Math.max(0, Math.round((x - layout.hfX0) / layout.hfStep)));
  const iy = Math.min(n - 1, Math.max(0, Math.round((y - layout.hfY0) / layout.hfStep)));
  const raw = field[iy * n + ix];
  return layout.hfZlo + (raw / 65535) * (layout.hfZhi - layout.hfZlo);
}

/**
 * Height of the drawn sand surface at a world point: the sand mesh has a vertex
 * per texel, so between texels it is the interpolation of the four corners.
 */
export function interpolateHeightField(field: Uint16Array, layout: TerrainLayoutMeta, x: number, y: number): number {
  const n = layout.hfN;
  const fx = Math.min(n - 1, Math.max(0, (x - layout.hfX0) / layout.hfStep));
  const fy = Math.min(n - 1, Math.max(0, (y - layout.hfY0) / layout.hfStep));
  const x0 = Math.min(n - 2, Math.floor(fx));
  const y0 = Math.min(n - 2, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (ix: number, iy: number) => field[iy * n + ix];
  const raw = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
  return layout.hfZlo + (raw / 65535) * (layout.hfZhi - layout.hfZlo);
}

/** Texels over which a step between a layout's rim and the ring is faded out. */
const SEAM_TEXELS = 6;

/** How many heights a sand ring holds: the padded grid less the layout's field inside its rim. */
export function sandRingCount(ring: TerrainSandRing): number {
  const m = ring.n + 2 * ring.pad;
  return m * m - (ring.n - 2) * (ring.n - 2);
}

/**
 * A layout's height field with the shared ring of outside sand joined on, on
 * the same grid. The layout's own texels are untouched. The ring was built from
 * the game's current tiles and a layout's rim may not match it, so any step
 * there is faded out over the ring's first few texels.
 *
 * `planes` is the ring's u16 heights, all high bytes then all low bytes.
 */
export function withSandRing(
  field: Uint16Array,
  layout: TerrainLayoutMeta,
  ring: TerrainSandRing,
  planes: Uint8Array
): { field: Uint16Array; meta: TerrainLayoutMeta } {
  const n = layout.hfN;
  const pad = ring.pad;
  const count = sandRingCount(ring);
  if (ring.n !== n || planes.length !== count * 2) {
    throw new Error(`sand ring is for a ${ring.n} field and ${planes.length} bytes, the layout's is ${n}`);
  }
  const m = n + 2 * pad;
  const lo = pad;
  const hi = pad + n - 1;
  const toRaw = 65535 / (layout.hfZhi - layout.hfZlo);
  const out = new Uint16Array(m * m);
  // The ring's heights in the layout's own u16 scale, rim copy included.
  const ringRaw = new Float32Array(m * m);
  let k = 0;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      if (i > lo && i < hi && j > lo && j < hi) {
        out[j * m + i] = field[(j - pad) * n + (i - pad)];
        continue;
      }
      const value = (planes[k] << 8) | planes[count + k];
      k++;
      ringRaw[j * m + i] = (ring.zlo + value * ring.zstep - layout.hfZlo) * toRaw;
    }
  }
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      if (i > lo && i < hi && j > lo && j < hi) continue;
      // The nearest texel of the layout's rim, and how far out this one is from it.
      const ci = Math.min(hi, Math.max(lo, i));
      const cj = Math.min(hi, Math.max(lo, j));
      const own = field[(cj - pad) * n + (ci - pad)];
      const reach = Math.max(Math.abs(i - ci), Math.abs(j - cj));
      const step = (own - ringRaw[cj * m + ci]) * Math.max(0, 1 - reach / SEAM_TEXELS);
      out[j * m + i] = reach === 0 ? own : Math.min(65535, Math.max(0, Math.round(ringRaw[j * m + i] + step)));
    }
  }
  return {
    field: out,
    meta: { ...layout, hfN: m, hfX0: layout.hfX0 - pad * layout.hfStep, hfY0: layout.hfY0 - pad * layout.hfStep }
  };
}

/** The parts of a canvas the size guard touches, so it can be tested without one. */
export type SizableCanvas = { width: number; height: number; style: { width: string; height: string } };

/**
 * Size a canvas, touching `width`/`height` only when they actually change.
 *
 * Assigning either resets the drawing buffer and blanks the canvas, even when
 * the value is identical. This runs on every zoom tick and every scroll event,
 * so writing unconditionally cleared the terrain and redrew it constantly --
 * the flicker while zooming. Returns whether the buffer was reset.
 */
export function applyCanvasSize(canvas: SizableCanvas, cssWidth: number, cssHeight: number, dpr: number): boolean {
  const scale = Math.min(dpr || 1, 2);
  const w = Math.max(1, Math.round(cssWidth * scale));
  const h = Math.max(1, Math.round(cssHeight * scale));
  if (canvas.style.width !== `${cssWidth}px`) canvas.style.width = `${cssWidth}px`;
  if (canvas.style.height !== `${cssHeight}px`) canvas.style.height = `${cssHeight}px`;
  let reset = false;
  if (canvas.width !== w) { canvas.width = w; reset = true; }
  if (canvas.height !== h) { canvas.height = h; reset = true; }
  return reset;
}

/** Floats per instance in a layout's instance buffer: mat3 by columns, translation, iMat, lift. */
export const INSTANCE_FLOATS = 14;

/**
 * A bounding circle in world XY per instance, as `[x, y, r]` triples in instance
 * order. `r` takes the longest matrix column, so it holds under non-uniform scale.
 */
export function instanceCircles(calls: TerrainDrawCall[], instances: Float32Array): Float32Array {
  const out = new Float32Array((instances.length / INSTANCE_FLOATS) * 3);
  for (const call of calls) {
    const lx = call.lo[0] + call.ext[0] / 2;
    const ly = call.lo[1] + call.ext[1] / 2;
    const lz = call.lo[2] + call.ext[2] / 2;
    const half = 0.5 * Math.hypot(call.ext[0], call.ext[1], call.ext[2]);
    for (let i = call.instOff; i < call.instOff + call.instN; i++) {
      const f = i * INSTANCE_FLOATS;
      const s = Math.max(
        Math.hypot(instances[f], instances[f + 1], instances[f + 2]),
        Math.hypot(instances[f + 3], instances[f + 4], instances[f + 5]),
        Math.hypot(instances[f + 6], instances[f + 7], instances[f + 8])
      );
      out[i * 3] = instances[f] * lx + instances[f + 3] * ly + instances[f + 6] * lz + instances[f + 9];
      out[i * 3 + 1] = instances[f + 1] * lx + instances[f + 4] * ly + instances[f + 7] * lz + instances[f + 10];
      out[i * 3 + 2] = half * s;
    }
  }
  return out;
}

export type CulledDraw = { off: number; n: number };

/**
 * Choose which instances to draw this frame and pack them into `out`: those
 * whose bounding circle touches the view and is at least `minRadius`. Per
 * instance, not per call -- a call's instances are scattered across the map.
 * Landscape tiles are always kept.
 */
export function cullInstances(
  calls: TerrainDrawCall[],
  instances: Float32Array,
  circles: Float32Array,
  view: TerrainView,
  minRadius: number | ((x: number, y: number) => number),
  out: Float32Array
): { draws: CulledDraw[]; total: number } {
  // A number is one threshold for the whole view; a function gives it per instance.
  const threshold = typeof minRadius === "number" ? () => minRadius : minRadius;
  const draws: CulledDraw[] = [];
  let total = 0;
  for (const call of calls) {
    const off = total;
    let runStart = -1;
    const flush = (end: number) => {
      if (runStart < 0) return;
      out.set(instances.subarray(runStart * INSTANCE_FLOATS, end * INSTANCE_FLOATS), total * INSTANCE_FLOATS);
      total += end - runStart;
      runStart = -1;
    };
    const last = call.instOff + call.instN;
    for (let i = call.instOff; i < last; i++) {
      let keep = call.land;
      if (!keep) {
        const x = circles[i * 3], y = circles[i * 3 + 1], r = circles[i * 3 + 2];
        keep = x + r >= view.minX && x - r <= view.maxX && y + r >= view.minY && y - r <= view.maxY && r >= threshold(x, y);
      }
      if (keep) { if (runStart < 0) runStart = i; } else flush(i);
    }
    flush(last);
    draws.push({ off, n: total - off });
  }
  return { draws, total };
}
