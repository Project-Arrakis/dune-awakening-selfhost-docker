import type { LiveMapConfig } from "../../api/liveMap";
import { worldToLiveMapPoint } from "./liveMapGeometry";
import { cullRectForCamera, projectToScreen, scaleAt, type TerrainCamera } from "./terrain/terrainCamera";
import type { SectorGridSpec } from "./terrain/types";

/**
 * The Deep Desert's 9x9 lettered sector grid.
 *
 * Measured in game: two grid crossings were located to a few hundred uu by
 * reading the in-game map label at known positions (see
 * docs/console/live-map.md). The cells are not square. The Deep Desert rect in
 * `LIVE_MAP_CONFIGS` is this grid squared up, so keep the two in step.
 *
 * **I is at the top and A at the bottom**: world +Y draws downward in the panel,
 * so the row index counts down from the high-Y edge. Easy to get upside down by
 * assuming A comes first.
 */
const X0 = -1268450;
const Y_TOP = 1163467;
const CELL_X = 269650;
const CELL_Y = 269217;
const DIVISIONS = 9;
const Y0 = Y_TOP - DIVISIONS * CELL_Y;

/** The grid as the terrain draws it while tilted. */
export const SECTOR_GRID: SectorGridSpec = { x0: X0, y0: Y0, cellX: CELL_X, cellY: CELL_Y, divisions: DIVISIONS };

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
 * The overlay is built from `sectorGridFor`, which walks rows and columns
 * directly; this states the mapping the other way round -- world point to
 * label -- and the orientation tests check the drawn grid against it.
 */
export function sectorForWorldPoint(x: number, y: number): string | null {
  const column = Math.floor((x - X0) / CELL_X);
  const row = Math.floor((Y_TOP - y) / CELL_Y);
  if (column < 0 || column >= DIVISIONS || row < 0 || row >= DIVISIONS) return null;
  return `${String.fromCharCode(65 + row)}${column + 1}`;
}

/**
 * Where a cell's label should sit given the currently visible region, all in
 * map-pixel space: the centre of the part of the cell you can actually see.
 *
 * At the map's higher zooms a single cell is wider than the frame, so
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
  const x1 = X0 + DIVISIONS * CELL_X;
  const lines: SectorGridLine[] = [];
  for (let i = 0; i <= DIVISIONS; i++) {
    const edge = i === 0 || i === DIVISIONS;
    const vertical = [at(X0 + i * CELL_X, Y0), at(X0 + i * CELL_X, Y_TOP)];
    const horizontal = [at(X0, Y0 + i * CELL_Y), at(x1, Y0 + i * CELL_Y)];
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
      const centre = at(X0 + (column + 0.5) * CELL_X, Y_TOP - (row + 0.5) * CELL_Y);
      const near = at(X0 + column * CELL_X, Y_TOP - row * CELL_Y);
      const far = at(X0 + (column + 1) * CELL_X, Y_TOP - (row + 1) * CELL_Y);
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

/** A cell label as the tilted view draws it, in viewport CSS pixels. */
export type SectorLabel3D = { text: string; sx: number; sy: number };

// Perspective depth below which a point counts as behind the view. Anything on
// screen is far above it, so this only cuts geometry off-screen toward the eye.
const NEAR_DEPTH = 0.1;

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
 * The sector labels seen through the 3D camera, in viewport CSS pixels: each at
 * the centre of the visible part of its cell. The lines are drawn by the terrain
 * itself (`SECTOR_GRID`), on whatever surface they cross.
 */
export function projectSectorLabels(camera: TerrainCamera, padding: number, minArea: number): SectorLabel3D[] {
  const depth = (x: number, y: number, z: number) => scaleAt(camera, x, y, z) / camera.scale;
  // What the camera can see of the ground, generously: dunes stay well inside this band.
  const seen = cullRectForCamera(camera, camera.cz - 40000, camera.cz + 40000);
  const labels: SectorLabel3D[] = [];
  const z = camera.cz;
  for (let row = 0; row < DIVISIONS; row++) {
    for (let column = 0; column < DIVISIONS; column++) {
      const x0 = X0 + column * CELL_X;
      const y1 = Y_TOP - row * CELL_Y;
      if (x0 > seen.maxX || x0 + CELL_X < seen.minX || y1 < seen.minY || y1 - CELL_Y > seen.maxY) continue;
      // The cell on the ground, cut to what is in front of the view...
      const ground = clipPolygon<Vec>(
        [{ x: x0, y: y1 - CELL_Y }, { x: x0 + CELL_X, y: y1 - CELL_Y }, { x: x0 + CELL_X, y: y1 }, { x: x0, y: y1 }],
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
  return labels;
}
