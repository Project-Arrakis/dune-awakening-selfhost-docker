import { describe, expect, it } from "vitest";
import type { LiveMapConfig } from "../../api/liveMap";
import { labelAnchorInView, projectSectorGrid, sectorForWorldPoint, sectorGridFor } from "./liveMapSectorGrid";
import { liveMapCamera, terrainViewport } from "./liveMapGeometry";
import { projectToScreen, screenToWorldAtZ } from "./terrain/terrainCamera";

const DEEP_DESERT: LiveMapConfig = {
  key: "DeepDesert", label: "The Deep Desert", actorMap: "DeepDesert",
  image: "/images/maps/deep-desert.png", width: 4096, height: 4096,
  minX: -1177656, maxX: 1072344, minY: -1177066, maxY: 1072934,
  flipY: false, defaultPartitionId: 8
};
const HAGGA: LiveMapConfig = { ...DEEP_DESERT, key: "HaggaBasin", actorMap: "HaggaBasin" };

const CENTRE_X = -52656;
const CENTRE_Y = -52066;
const HALF = 1125000;
const CELL = 250000;

describe("sectorForWorldPoint", () => {
  // Orientation is checked against the game's own map art, which carries the
  // labels burned in: I1-I9 across the top, A1-A9 across the bottom. World +Y
  // draws downward in the panel, so the letter runs OPPOSITE to screen-down --
  // the obvious guess (A first, going down) is upside down.
  it("puts A at the high-Y edge and I at the low-Y edge", () => {
    expect(sectorForWorldPoint(CENTRE_X - HALF + 1, CENTRE_Y + HALF - 1)).toBe("A1");
    expect(sectorForWorldPoint(CENTRE_X - HALF + 1, CENTRE_Y - HALF + 1)).toBe("I1");
  });

  it("numbers columns west to east", () => {
    expect(sectorForWorldPoint(CENTRE_X + HALF - 1, CENTRE_Y + HALF - 1)).toBe("A9");
    expect(sectorForWorldPoint(CENTRE_X + HALF - 1, CENTRE_Y - HALF + 1)).toBe("I9");
  });

  it("puts the map centre in the middle cell", () => {
    expect(sectorForWorldPoint(CENTRE_X, CENTRE_Y)).toBe("E5");
  });

  it("steps one letter per cell down the grid", () => {
    const column = CENTRE_X - HALF + CELL / 2;
    const letters = Array.from({ length: 9 }, (_, row) =>
      sectorForWorldPoint(column, CENTRE_Y + HALF - (row + 0.5) * CELL));
    expect(letters).toEqual(["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1", "I1"]);
  });

  it("returns null outside the grid rather than an out-of-range letter", () => {
    expect(sectorForWorldPoint(CENTRE_X - HALF - 1, CENTRE_Y)).toBeNull();
    expect(sectorForWorldPoint(CENTRE_X, CENTRE_Y + HALF + 1)).toBeNull();
    // The rect and the grid now coincide, so the far corner is the grid's own
    // exclusive edge rather than a point beyond it -- still no sector, but for a
    // different reason.
    expect(sectorForWorldPoint(DEEP_DESERT.minX, DEEP_DESERT.minY)).toBeNull();
    // and one cell inside that corner does have a sector
    expect(sectorForWorldPoint(DEEP_DESERT.minX + 1, DEEP_DESERT.minY + 1)).toBe("I1");
  });
});

describe("sectorGridFor", () => {
  it("returns 10 lines per axis and 81 labels", () => {
    const grid = sectorGridFor(DEEP_DESERT)!;
    expect(grid.lines).toHaveLength(20);
    expect(grid.labels).toHaveLength(81);
  });

  it("marks only the outer lines as edges", () => {
    const grid = sectorGridFor(DEEP_DESERT)!;
    expect(grid.lines.filter((line) => line.edge)).toHaveLength(4);
  });

  it("places labels where the sector lookup agrees they belong", () => {
    // The drawn label and the coordinate readout must never disagree.
    const grid = sectorGridFor(DEEP_DESERT)!;
    const toWorldX = (px: number) => DEEP_DESERT.minX + (px / DEEP_DESERT.width) * (DEEP_DESERT.maxX - DEEP_DESERT.minX);
    const toWorldY = (py: number) => DEEP_DESERT.minY + (py / DEEP_DESERT.height) * (DEEP_DESERT.maxY - DEEP_DESERT.minY);
    for (const label of grid.labels) {
      expect(sectorForWorldPoint(toWorldX(label.px), toWorldY(label.py))).toBe(label.text);
    }
  });

  it("draws A1 below I1 on screen, matching the game's map art", () => {
    const grid = sectorGridFor(DEEP_DESERT)!;
    const a1 = grid.labels.find((l) => l.text === "A1")!;
    const i1 = grid.labels.find((l) => l.text === "I1")!;
    expect(a1.py).toBeGreaterThan(i1.py);
    expect(a1.px).toBeCloseTo(i1.px, 6);
  });

  it("is Deep Desert only -- Hagga Basin has no lettered sector grid", () => {
    expect(sectorGridFor(HAGGA)).toBeNull();
  });

  it("spans the image exactly, because the rect is the sector square", () => {
    // The config rect used to be ~8% wider than the square the image covers, so
    // this grid sat inset 153 px per side while the picture's own grid ran edge
    // to edge. The two now describe the same world square.
    const grid = sectorGridFor(DEEP_DESERT)!;
    const xs = grid.lines.flatMap((line) => [line.x1, line.x2]);
    const ys = grid.lines.flatMap((line) => [line.y1, line.y2]);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(DEEP_DESERT.width, 6);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(DEEP_DESERT.height, 6);
  });
});

describe("labelAnchorInView", () => {
  const grid = sectorGridFor(DEEP_DESERT)!;
  const cell = grid.labels.find((l) => l.text === "E5")!;

  it("uses the cell's own centre when the whole cell is visible", () => {
    const anchor = labelAnchorInView(cell, { left: 0, top: 0, right: 4096, bottom: 4096 }, 0)!;
    expect(anchor.px).toBeCloseTo(cell.px, 6);
    expect(anchor.py).toBeCloseTo(cell.py, 6);
  });

  it("follows the viewport when the cell is larger than it", () => {
    // The case that matters: above ~2x zoom a cell is wider than the frame, so a
    // label at the true centre is off-screen and the grid stops being useful.
    const view = { left: cell.x0 + 10, top: cell.y0 + 10, right: cell.x0 + 90, bottom: cell.y0 + 90 };
    const anchor = labelAnchorInView(cell, view, 0)!;
    expect(anchor.px).toBeCloseTo(50 + cell.x0, 6);
    expect(anchor.py).toBeCloseTo(50 + cell.y0, 6);
    expect(anchor.px).not.toBeCloseTo(cell.px, 0);
  });

  it("stays inside the cell when the viewport straddles a boundary", () => {
    const view = { left: cell.x0 - 500, top: cell.y0 - 500, right: cell.x0 + 100, bottom: cell.y0 + 100 };
    const anchor = labelAnchorInView(cell, view, 0)!;
    expect(anchor.px).toBeGreaterThanOrEqual(cell.x0);
    expect(anchor.py).toBeGreaterThanOrEqual(cell.y0);
    expect(anchor.px).toBeLessThanOrEqual(cell.x1);
  });

  it("returns null when the cell is off-screen entirely", () => {
    expect(labelAnchorInView(cell, { left: 0, top: 0, right: 5, bottom: 5 }, 0)).toBeNull();
  });

  it("returns null when the visible sliver is thinner than the padding", () => {
    // Rather than jam a label into a 3px strip at the very edge of the frame.
    const view = { left: cell.x1 - 4, top: cell.y0, right: cell.x1 + 500, bottom: cell.y1 };
    expect(labelAnchorInView(cell, view, 20)).toBeNull();
  });
});

// Finding 16: the padding is in map pixels, so it grows as you zoom out. At the
// fit on a 375px viewport it demanded 524 map-px of clearance from a 421 map-px
// cell, and every one of the 81 labels was suppressed -- a grid of bare lines.
describe("labels survive being zoomed out", () => {
  const grid = sectorGridFor(DEEP_DESERT)!;

  function visibleAt(viewportPx: number) {
    const zoom = viewportPx / DEEP_DESERT.width;
    const view = { left: 0, top: 0, right: DEEP_DESERT.width, bottom: DEEP_DESERT.height };
    // The panel's own figure: label size scaled back out of map space.
    const padding = (15 * 1.6) / zoom;
    return grid.labels.filter((label) => labelAnchorInView(label, view, padding) !== null).length;
  }

  it("labels every cell at a phone's fit zoom, where all 81 used to vanish", () => {
    expect(visibleAt(375)).toBe(81);
  });

  it("labels every cell on a tablet and a desktop too", () => {
    expect(visibleAt(768)).toBe(81);
    expect(visibleAt(1400)).toBe(81);
  });

  it("still refuses a sliver too thin to label", () => {
    // The case the padding exists for is far smaller than the cap and unchanged.
    const cell = grid.labels.find((l) => l.text === "E5")!;
    const view = { left: cell.x1 - 4, top: cell.y0, right: cell.x1 + 500, bottom: cell.y1 };
    expect(labelAnchorInView(cell, view, 20)).toBeNull();
  });
});

describe("projectSectorGrid", () => {
  const deg = (d: number) => (d * Math.PI) / 180;
  const W = 900;
  const H = 700;
  const PIVOT = 5000;
  /** The panel's camera for a zoom, centred on a map pixel. */
  function cameraAt(zoom: number, px: number, py: number, tiltDeg: number, yawDeg: number) {
    const viewport = terrainViewport(DEEP_DESERT, zoom, px * zoom - W / 2, py * zoom - H / 2, W, H);
    return liveMapCamera(DEEP_DESERT, zoom, viewport, deg(tiltDeg), deg(yawDeg), PIVOT)!;
  }
  const flatSand = () => PIVOT;
  /** Every vertex of every path, as numbers. */
  const vertices = (d: string) => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  /** Distance from a point to the nearest segment of a path. */
  function distanceToPath(d: string, x: number, y: number) {
    let best = Infinity;
    let prev: number[] | null = null;
    for (const m of d.matchAll(/([ML])(-?[\d.]+) (-?[\d.]+)/g)) {
      const cur = [Number(m[2]), Number(m[3])];
      if (m[1] === "L" && prev) {
        const vx = cur[0] - prev[0];
        const vy = cur[1] - prev[1];
        const t = Math.max(0, Math.min(1, ((x - prev[0]) * vx + (y - prev[1]) * vy) / Math.max(vx * vx + vy * vy, 1e-9)));
        best = Math.min(best, Math.hypot(x - prev[0] - vx * t, y - prev[1] - vy * t));
      }
      prev = cur;
    }
    return best;
  }

  it("labels each sector with the sector that is actually under the label", () => {
    for (const [zoom, tilt, yaw] of [[0.2, 0, 35], [0.2, 45, 0], [0.5, 60, 130], [2, 55, -70], [8, 60, 20]]) {
      const camera = cameraAt(zoom, 2048, 2048, tilt, yaw);
      const grid = projectSectorGrid(camera, flatSand, 20, 900);
      expect(grid.labels.length).toBeGreaterThan(0);
      for (const label of grid.labels) {
        const ground = screenToWorldAtZ(camera, label.sx, label.sy, PIVOT);
        expect(sectorForWorldPoint(ground.x, ground.y)).toBe(label.text);
        // ...and it is inside the viewport, clear of its edge.
        expect(label.sx).toBeGreaterThanOrEqual(20);
        expect(label.sx).toBeLessThanOrEqual(W - 20);
        expect(label.sy).toBeGreaterThanOrEqual(20);
        expect(label.sy).toBeLessThanOrEqual(H - 20);
      }
    }
  });

  it("still labels the sector in view when one cell is larger than the viewport", () => {
    // Zoom 8, centred in E5's middle: the cell's edges are all off-screen.
    const grid = projectSectorGrid(cameraAt(8, 2048, 2048, 50, 25), flatSand, 20, 900);
    expect(grid.labels.map((label) => label.text)).toEqual(["E5"]);
  });

  it("draws the lines through the grid's own intersections", () => {
    const camera = cameraAt(0.6, 1900, 2100, 50, 40);
    const grid = projectSectorGrid(camera, flatSand, 20, 900);
    let checked = 0;
    for (let i = 0; i <= 9; i++) for (let j = 0; j <= 9; j++) {
      const s = projectToScreen(camera, CENTRE_X - HALF + i * CELL, CENTRE_Y - HALF + j * CELL, PIVOT);
      if (s.sx < 0 || s.sx > W || s.sy < 0 || s.sy > H) continue;
      checked++;
      // Two lines cross at every intersection: one path of each direction passes within rounding.
      const near = grid.paths.filter((path) => distanceToPath(path.d, s.sx, s.sy) < 0.2);
      expect(near.length).toBeGreaterThanOrEqual(2);
    }
    expect(checked).toBeGreaterThan(3);
  });

  it("lays the lines on the sand, not on a flat plane", () => {
    const camera = cameraAt(1, 2048, 2048, 55, 0);
    const flat = projectSectorGrid(camera, flatSand, 20, 900);
    const raised = projectSectorGrid(camera, () => PIVOT + 12000, 20, 900);
    // Higher ground draws further up the screen once tilted.
    const top = (paths: { d: string }[]) => Math.min(...paths.flatMap((path) => vertices(path.d).map((v) => v[1])));
    expect(top(raised.paths)).toBeLessThan(top(flat.paths) - 5);
    // A point on a dune sits on the line drawn over that dune.
    const x = CENTRE_X - HALF + 4 * CELL;
    const dune = (px: number, py: number) => PIVOT + 6000 * Math.sin(py / 30000) + 0 * px;
    const draped = projectSectorGrid(camera, dune, 20, 900);
    const y = camera.cy + 20000;
    const s = projectToScreen(camera, x, y, dune(x, y));
    expect(Math.min(...draped.paths.map((path) => distanceToPath(path.d, s.sx, s.sy)))).toBeLessThan(1.5);
    // The flat-plane line misses it by a visible amount.
    expect(Math.min(...flat.paths.map((path) => distanceToPath(path.d, s.sx, s.sy)))).toBeGreaterThan(3);
  });

  it("stays finite where lines run behind the view", () => {
    // Steep and zoomed in: most of every line is off-screen, some of it behind the eye.
    for (const yaw of [0, 90, 180, 270, 33]) {
      const grid = projectSectorGrid(cameraAt(8, 1500, 1700, 60, yaw), flatSand, 20, 900);
      for (const path of grid.paths) {
        for (const [x, y] of vertices(path.d)) {
          expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
          expect(Math.abs(x)).toBeLessThan(20000);
          expect(Math.abs(y)).toBeLessThan(20000);
        }
      }
    }
  });

  describe("where the terrain covers it", () => {
    const camera = cameraAt(0.6, 2048, 2048, 50, 0);
    // The grid line nearest the viewer of the two that cross the view's middle:
    // horizontal on screen at yaw 0, so it can be picked out by its row.
    const lineY = CENTRE_Y + CELL / 2;
    const rowSy = projectToScreen(camera, camera.cx, lineY, PIVOT).sy;
    const onRow = (paths: { d: string }[]) => paths.flatMap((path) => vertices(path.d)).filter(([, y]) => Math.abs(y - rowSy) < 1);
    const sxOf = (x: number) => projectToScreen(camera, x, lineY, PIVOT).sx;

    it("breaks a line there, and nowhere else", () => {
      const open = projectSectorGrid(camera, flatSand, 20, 900);
      // A rock across the middle of the view: everything within 60,000 uu of the centre line.
      const cut = projectSectorGrid(camera, flatSand, 20, 900, (x) => Math.abs(x - camera.cx) < 60000);
      const left = sxOf(camera.cx - 60000);
      const right = sxOf(camera.cx + 60000);
      const inBand = (paths: { d: string }[]) => onRow(paths).filter(([x]) => x > left + 1 && x < right - 1);
      // Uncovered, the line runs through the band; covered, nothing of it is drawn there...
      expect(inBand(open.paths).length).toBeGreaterThan(5);
      expect(inBand(cut.paths)).toHaveLength(0);
      // ...it is broken, not dropped...
      const moves = (paths: { d: string }[]) => paths.reduce((n, path) => n + (path.d.match(/M/g) || []).length, 0);
      expect(moves(cut.paths)).toBeGreaterThan(moves(open.paths));
      // ...and it still runs on both sides.
      const xs = onRow(cut.paths).map(([x]) => x);
      expect(Math.min(...xs)).toBeLessThan(left - 20);
      expect(Math.max(...xs)).toBeGreaterThan(right + 20);
      // Labels are not hidden by it.
      expect(cut.labels).toEqual(open.labels);
    });

    it("stops within half the usual sampling distance of the rock", () => {
      const edge = camera.cx - 60000;
      const cut = projectSectorGrid(camera, flatSand, 20, 900, (x) => x > edge);
      const edgeSx = sxOf(edge);
      const last = Math.max(...onRow(cut.paths).map(([x]) => x));
      // Never into the rock, and no more than a 6 px sample short of it.
      expect(last).toBeLessThanOrEqual(edgeSx + 0.1);
      expect(edgeSx - last).toBeLessThanOrEqual(7);
    });

    it("is not sampled, or cut, when nothing says what is covered", () => {
      const open = projectSectorGrid(camera, flatSand, 20, 900);
      const never = projectSectorGrid(camera, flatSand, 20, 900, () => false);
      // The same lines either way; only finer when being tested.
      expect(never.paths).toHaveLength(open.paths.length);
      expect(onRow(never.paths).length).toBeGreaterThan(onRow(open.paths).length);
    });
  });

  it("marks the four outer lines as the edge", () => {
    const grid = projectSectorGrid(cameraAt(0.2, 2048, 2048, 30, 10), flatSand, 20, 900);
    expect(grid.paths.filter((path) => path.edge)).toHaveLength(4);
    expect(grid.paths).toHaveLength(20);
  });
});
