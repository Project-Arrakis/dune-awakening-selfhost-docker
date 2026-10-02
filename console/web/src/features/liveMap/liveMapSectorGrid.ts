import type { LiveMapConfig } from "../../api/liveMap";
import { worldToLiveMapPoint } from "./liveMapGeometry";
import { cullRectForCamera, projectToScreen, scaleAt, type TerrainCamera } from "./terrain/terrainCamera";

/**
 * The Deep Desert's 9x9 lettered sector grid.
 *
 * Game constants, not derived from the map config: the grid is 250,000 uu cells
 * spanning +/-1,125,000 uu about the map centre. The centre happens to match
 * `LIVE_MAP_CONFIGS`' centre exactly, but they are independent facts -- the grid
 * would not move if the config's bounds were ever retuned.
 *
 * Orientation is confirmed against the game's own map art
 * (`images/maps/deep-desert.png`, which carries the labels burned in): **I is at
 * the top and A at the bottom**. World +Y draws downward in the panel, so the
 * letter runs opposite to screen-down -- the row index counts down from the
 * high-Y edge. Easy to get upside down by assuming A comes first.
 */
const CENTRE_X = -52656;
const CENTRE_Y = -52066;
const HALF = 1125000;
const CELL = 250000;
const DIVISIONS = 9;

export type SectorGridLine = { x1: number; y1: number; x2: number; y2: number; edge: boolean };
/**
 * `px`/`py` is the cell's centre; `x0..y1` is its full footprint, both in
 * map-pixel space. The footprint is what lets a label be kept inside the
 * visible part of its cell when the cell is larger than the viewport.
 */
export type SectorGridLabel = { text: string; px: number; py: number; x0: number; y0: number; x1: number; y1: number };

/**
 * Which sector a world point falls in, or null outside the grid.
 *
 * Nothing in the panel calls this: the overlay is built from `sectorGridFor`,
 * which walks rows and columns directly. It is kept because it states the
 * mapping the other way round -- world point to label -- and the orientation
 * tests check the drawn grid against it. Deleting it would remove the only
 * independent statement that I is at the top, which is the thing here most
 * likely to be got wrong.
 */
export function sectorForWorldPoint(x: number, y: number): string | null {
  const column = Math.floor((x - (CENTRE_X - HALF)) / CELL);
  const row = Math.floor((CENTRE_Y + HALF - y) / CELL);
  if (column < 0 || column >= DIVISIONS || row < 0 || row >= DIVISIONS) return null;
  return `${String.fromCharCode(65 + row)}${column + 1}`;
}

/**
 * Where a cell's label should sit given the currently visible region, all in
 * map-pixel space: the centre of the part of the cell you can actually see.
 *
 * At the map's higher zooms a single 250,000 uu cell is wider than the frame, so
 * a label pinned to the cell's true centre scrolls out of view and the grid
 * stops answering the only question it exists for -- which sector am I looking
 * at. Returns null when too little of the cell is visible to label.
 */
export function labelAnchorInView(
  label: SectorGridLabel,
  view: { left: number; top: number; right: number; bottom: number },
  padding: number
): { px: number; py: number } | null {
  // Padding is given in map pixels, so it grows as you zoom out: at the fit on a
  // phone it asked for more clearance than a whole cell is wide and suppressed
  // all 81 labels, leaving a grid of unlabelled lines. Cap it against the cell
  // so a fully visible cell always gets its label; the sliver case that the
  // padding exists for is unaffected, being far smaller than a quarter cell.
  const capped = Math.min(padding, Math.min(label.x1 - label.x0, label.y1 - label.y0) / 4);
  const left = Math.max(label.x0, view.left) + capped;
  const right = Math.min(label.x1, view.right) - capped;
  const top = Math.max(label.y0, view.top) + capped;
  const bottom = Math.min(label.y1, view.bottom) - capped;
  if (right < left || bottom < top) return null;
  return { px: (left + right) / 2, py: (top + bottom) / 2 };
}

/**
 * Grid lines and cell labels in the panel's map-pixel space, so they scale and
 * scroll with the markers by multiplying through by `zoom` exactly as a marker
 * does. Returns null for a map that has no sector grid.
 */
export function sectorGridFor(config: LiveMapConfig): { lines: SectorGridLine[]; labels: SectorGridLabel[] } | null {
  if (config.key !== "DeepDesert") return null;

  const at = (x: number, y: number) => worldToLiveMapPoint({ x, y }, config);
  const lines: SectorGridLine[] = [];
  for (let i = 0; i <= DIVISIONS; i++) {
    const edge = i === 0 || i === DIVISIONS;
    const offset = -HALF + i * CELL;
    const vertical = [at(CENTRE_X + offset, CENTRE_Y - HALF), at(CENTRE_X + offset, CENTRE_Y + HALF)];
    const horizontal = [at(CENTRE_X - HALF, CENTRE_Y + offset), at(CENTRE_X + HALF, CENTRE_Y + offset)];
    if (vertical[0] && vertical[1]) {
      lines.push({ x1: vertical[0].px, y1: vertical[0].py, x2: vertical[1].px, y2: vertical[1].py, edge });
    }
    if (horizontal[0] && horizontal[1]) {
      lines.push({ x1: horizontal[0].px, y1: horizontal[0].py, x2: horizontal[1].px, y2: horizontal[1].py, edge });
    }
  }

  const labels: SectorGridLabel[] = [];
  for (let row = 0; row < DIVISIONS; row++) {
    for (let column = 0; column < DIVISIONS; column++) {
      // Cell centre: columns run with +X, rows run against +Y.
      const centre = at(
        CENTRE_X - HALF + (column + 0.5) * CELL,
        CENTRE_Y + HALF - (row + 0.5) * CELL
      );
      const near = at(CENTRE_X - HALF + column * CELL, CENTRE_Y + HALF - row * CELL);
      const far = at(CENTRE_X - HALF + (column + 1) * CELL, CENTRE_Y + HALF - (row + 1) * CELL);
      if (!centre || !near || !far) continue;
      labels.push({
        text: `${String.fromCharCode(65 + row)}${column + 1}`,
        px: centre.px,
        py: centre.py,
        x0: Math.min(near.px, far.px),
        y0: Math.min(near.py, far.py),
        x1: Math.max(near.px, far.px),
        y1: Math.max(near.py, far.py)
      });
    }
  }
  return { lines, labels };
}

/** The grid as the tilted view draws it: paths and labels in viewport CSS pixels. */
export type SectorGrid3D = {
  paths: { d: string; edge: boolean }[];
  labels: { text: string; sx: number; sy: number }[];
};

// Perspective depth below which a point counts as behind the view. Anything on
// screen is far above it, so this only cuts geometry off-screen toward the eye.
const NEAR_DEPTH = 0.1;
// Lines are sampled this often on screen, and twice as often when being cut.
const SAMPLE_PX = 12;
const MAX_SAMPLES = 256;

type Vec = { x: number; y: number };

/** Sutherland-Hodgman: the part of a convex polygon where `inside` is non-negative. */
function clipPolygon<T extends Vec>(points: T[], inside: (p: T) => number, mix: (a: T, b: T, t: number) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const da = inside(a);
    const db = inside(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) out.push(mix(a, b, da / (da - db)));
  }
  return out;
}

const mixVec = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/**
 * The sector grid seen through the 3D camera, in viewport CSS pixels. Lines are
 * laid on the sand (`heightAt`) so they stay on the right side of markers, and
 * each label sits at the centre of the visible part of its cell. `hidden`, when
 * given, cuts lines where terrain covers them; labels are never hidden.
 */
export function projectSectorGrid(
  camera: TerrainCamera,
  heightAt: (x: number, y: number) => number,
  padding: number,
  minArea: number,
  hidden?: (x: number, y: number, z: number) => boolean
): SectorGrid3D {
  const depth = (x: number, y: number, z: number) => scaleAt(camera, x, y, z) / camera.scale;
  // What the camera can see of the ground, generously: dunes stay well inside this band.
  const seen = cullRectForCamera(camera, camera.cz - 40000, camera.cz + 40000);
  const step = Math.max((hidden ? SAMPLE_PX / 2 : SAMPLE_PX) * camera.scale, 1);
  const maxSamples = hidden ? MAX_SAMPLES * 2 : MAX_SAMPLES;
  const margin = 64;
  const onScreen = (ax: number, ay: number, bx: number, by: number) => (
    Math.max(ax, bx) >= -margin && Math.min(ax, bx) <= camera.width + margin
    && Math.max(ay, by) >= -margin && Math.min(ay, by) <= camera.height + margin
  );
  const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

  const paths: SectorGrid3D["paths"] = [];
  const trace = (fixed: number, lo: number, hi: number, alongX: boolean, edge: boolean) => {
    // Only the stretch the camera can see is sampled.
    const from = Math.max(lo, alongX ? seen.minX : seen.minY);
    const to = Math.min(hi, alongX ? seen.maxX : seen.maxY);
    const across = alongX ? [seen.minY, seen.maxY] : [seen.minX, seen.maxX];
    if (to <= from || fixed < across[0] || fixed > across[1]) return;
    const count = Math.min(maxSamples, Math.max(1, Math.ceil((to - from) / step)));
    let d = "";
    let pen = false;
    let prev: { x: number; y: number; z: number; w: number; covered: boolean } | null = null;
    for (let i = 0; i <= count; i++) {
      const v = from + ((to - from) * i) / count;
      const x = alongX ? v : fixed;
      const y = alongX ? fixed : v;
      const z = heightAt(x, y);
      const w = depth(x, y, z);
      const cur = { x, y, z, w, covered: !!hidden && w >= NEAR_DEPTH && hidden(x, y, z) };
      if (prev && !prev.covered && !cur.covered && (prev.w >= NEAR_DEPTH || cur.w >= NEAR_DEPTH)) {
        // Cut the segment where it passes behind the view, rather than dropping it whole.
        let a = prev;
        let b = cur;
        if (a.w < NEAR_DEPTH || b.w < NEAR_DEPTH) {
          const t = (NEAR_DEPTH - a.w) / (b.w - a.w);
          const cut = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, w: NEAR_DEPTH, covered: false };
          if (a.w < NEAR_DEPTH) a = cut; else b = cut;
        }
        const sa = projectToScreen(camera, a.x, a.y, a.z);
        const sb = projectToScreen(camera, b.x, b.y, b.z);
        if (onScreen(sa.sx, sa.sy, sb.sx, sb.sy)) {
          if (!pen || a !== prev) d += `M${fmt(sa.sx)} ${fmt(sa.sy)}`;
          d += `L${fmt(sb.sx)} ${fmt(sb.sy)}`;
          pen = b === cur;
        } else {
          pen = false;
        }
      } else {
        pen = false;
      }
      prev = cur;
    }
    if (d) paths.push({ d, edge });
  };
  for (let i = 0; i <= DIVISIONS; i++) {
    const edge = i === 0 || i === DIVISIONS;
    const offset = -HALF + i * CELL;
    trace(CENTRE_X + offset, CENTRE_Y - HALF, CENTRE_Y + HALF, false, edge);
    trace(CENTRE_Y + offset, CENTRE_X - HALF, CENTRE_X + HALF, true, edge);
  }

  const labels: SectorGrid3D["labels"] = [];
  const z = camera.cz;
  for (let row = 0; row < DIVISIONS; row++) {
    for (let column = 0; column < DIVISIONS; column++) {
      const x0 = CENTRE_X - HALF + column * CELL;
      const y1 = CENTRE_Y + HALF - row * CELL;
      if (x0 > seen.maxX || x0 + CELL < seen.minX || y1 < seen.minY || y1 - CELL > seen.maxY) continue;
      // The cell on the ground, cut to what is in front of the view...
      const ground = clipPolygon<Vec>(
        [{ x: x0, y: y1 - CELL }, { x: x0 + CELL, y: y1 - CELL }, { x: x0 + CELL, y: y1 }, { x: x0, y: y1 }],
        (p) => depth(p.x, p.y, z) - NEAR_DEPTH,
        mixVec
      );
      if (ground.length < 3) continue;
      // ...then on screen, cut to the viewport.
      let shape: Vec[] = ground.map((p) => {
        const s = projectToScreen(camera, p.x, p.y, z);
        return { x: s.sx, y: s.sy };
      });
      shape = clipPolygon(shape, (p) => p.x - padding, mixVec);
      shape = clipPolygon(shape, (p) => camera.width - padding - p.x, mixVec);
      shape = clipPolygon(shape, (p) => p.y - padding, mixVec);
      shape = clipPolygon(shape, (p) => camera.height - padding - p.y, mixVec);
      if (shape.length < 3) continue;
      let area = 0;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < shape.length; i++) {
        const a = shape[i];
        const b = shape[(i + 1) % shape.length];
        const cross = a.x * b.y - b.x * a.y;
        area += cross;
        cx += (a.x + b.x) * cross;
        cy += (a.y + b.y) * cross;
      }
      if (Math.abs(area) / 2 < minArea) continue;
      labels.push({ text: `${String.fromCharCode(65 + row)}${column + 1}`, sx: cx / (3 * area), sy: cy / (3 * area) });
    }
  }
  return { paths, labels };
}
