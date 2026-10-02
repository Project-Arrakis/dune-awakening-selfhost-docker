import type { TerrainView } from "./types";

/**
 * The Live Map's 3D camera: the map seen from overhead, optionally tilted back,
 * rotated, and -- as it tilts -- given perspective.
 *
 * Top-down is the flat map everyone already reads, and it must stay exactly that:
 * with no tilt, no rotation and no field of view this is the same orthographic
 * mapping `orthoFromWorldRect` builds, which is what the markers and the teleport
 * have always relied on. Tilt adds perspective gradually (see `fovForTilt`), and
 * the scale at the view centre is held fixed while it does, so leaning the map
 * back never makes the point you are looking at jump or change size.
 *
 * Conventions match the panel: world +X draws right, world +Y draws down (the
 * Deep Desert is not flipped), screen coordinates are CSS pixels from the
 * viewport's top-left.
 */
export type TerrainCamera = {
  /** The world point at the centre of the viewport. `cz` is the height tilting pivots about. */
  cx: number;
  cy: number;
  cz: number;
  /** World units per CSS pixel at the view centre. */
  scale: number;
  /** Viewport size, CSS pixels. */
  width: number;
  height: number;
  /** Lean back from straight down, radians: 0 is top-down. */
  tilt: number;
  /** Rotation about the vertical, radians: 0 keeps world +X to the right. */
  yaw: number;
  /** Vertical field of view, radians: 0 is orthographic. Normally `fovForTilt(tilt)`. */
  fov: number;
};

export const MAX_TILT = (60 * Math.PI) / 180;
export const MAX_FOV = (35 * Math.PI) / 180;

/**
 * Perspective grows with tilt: none at top-down, `MAX_FOV` at `MAX_TILT`. Tilting
 * past 60 with 35 of field puts the top edge's ray 77.5 degrees from vertical, so
 * it still meets the ground -- the view never reaches the horizon, which keeps
 * both the culling rect and the far depth finite.
 */
export function fovForTilt(tilt: number): number {
  return MAX_FOV * Math.max(0, Math.min(1, tilt / MAX_TILT));
}

/**
 * The field of view for a tilt, held back as far as it takes to keep the eye at
 * least `rise` above the pivot.
 *
 * The eye stands off from its target by a distance that goes with the scale:
 * zoom in and it comes closer, and lower. Fully tilted at high zoom that put it
 * below the tops of the tall rock, and then inside the rock, looking at the
 * inside of a cliff. A narrower field of view stands the eye further back for
 * the same framing -- the scale at the target does not change -- so the field is
 * narrowed just enough to lift the eye clear. The cost is a little less
 * perspective when zoomed right in, which is where there is least of it to lose.
 */
export function fovClearing(tilt: number, scale: number, height: number, rise: number): number {
  const base = fovForTilt(tilt);
  if (base <= 0 || !(rise > 0)) return base;
  // Eye height over the pivot is D * cos(tilt), with D = scale * height / (2 tan(fov / 2)).
  return Math.min(base, 2 * Math.atan((scale * height * Math.cos(tilt)) / (2 * rise)));
}

/** The flat, top-down camera for a world rect drawn into a viewport -- today's view. */
export function cameraFromRect(view: TerrainView, width: number, height: number): TerrainCamera {
  return {
    cx: (view.minX + view.maxX) / 2,
    cy: (view.minY + view.maxY) / 2,
    cz: 0,
    scale: (view.maxX - view.minX) / Math.max(width, 1),
    width,
    height,
    tilt: 0,
    yaw: 0,
    fov: 0
  };
}

export function isFlatCamera(camera: TerrainCamera): boolean {
  return camera.tilt === 0 && camera.yaw === 0 && camera.fov === 0;
}

/**
 * Eye distance from the target, world units, for a perspective camera: the
 * distance at which the vertical field of view spans exactly `height` pixels at
 * `scale`. Infinite for an orthographic camera.
 */
export function eyeDistance(camera: TerrainCamera): number {
  if (camera.fov <= 1e-6) return Infinity;
  return (camera.scale * camera.height) / (2 * Math.tan(camera.fov / 2));
}

/** Screen right and screen down as world-XY unit vectors, after yaw. */
function basis(camera: TerrainCamera) {
  const c = Math.cos(camera.yaw);
  const s = Math.sin(camera.yaw);
  return { rx: c, ry: s, dx: -s, dy: c };
}

/**
 * Camera-relative coordinates of a world point: `a` across the screen, `syw`
 * down the screen, and `q` toward the eye -- all world units, before
 * perspective.
 */
function cameraSpace(camera: TerrainCamera, x: number, y: number, z: number) {
  const { rx, ry, dx, dy } = basis(camera);
  const px = x - camera.cx;
  const py = y - camera.cy;
  const h = z - camera.cz;
  const a = px * rx + py * ry;
  const b = px * dx + py * dy;
  const ct = Math.cos(camera.tilt);
  const st = Math.sin(camera.tilt);
  return { a, syw: b * ct - h * st, q: b * st + h * ct };
}

/**
 * Where a world point lands in the viewport, CSS pixels from its top-left.
 * `behind` is set for a point at or behind the eye, which has no position.
 */
export function projectToScreen(camera: TerrainCamera, x: number, y: number, z: number): { sx: number; sy: number; behind: boolean } {
  const { a, syw, q } = cameraSpace(camera, x, y, z);
  const D = eyeDistance(camera);
  const f = Number.isFinite(D) ? D / (D - q) : 1;
  return {
    sx: camera.width / 2 + (a * f) / camera.scale,
    sy: camera.height / 2 + (syw * f) / camera.scale,
    behind: Number.isFinite(D) && q >= D
  };
}

/**
 * The world point under a screen pixel, at a given world height. Exact: the ray
 * through the pixel meets the horizontal plane `z` there. Used directly for a
 * plane (the sector grid's ground), and iterated against the height field where
 * the true surface is wanted and no GPU pick is available.
 */
export function screenToWorldAtZ(camera: TerrainCamera, sx: number, sy: number, z: number): { x: number; y: number } {
  const ux = sx - camera.width / 2;
  const uy = sy - camera.height / 2;
  const s = camera.scale;
  const D = eyeDistance(camera);
  const k = Number.isFinite(D) ? s / D : 0;
  const h = z - camera.cz;
  const ct = Math.cos(camera.tilt);
  const st = Math.sin(camera.tilt);
  const b = (uy * s - uy * k * h * ct + h * st) / (ct + uy * k * st);
  const q = b * st + h * ct;
  const a = ux * (s - k * q);
  const { rx, ry, dx, dy } = basis(camera);
  return { x: camera.cx + a * rx + b * dx, y: camera.cy + a * ry + b * dy };
}

/** World units per CSS pixel at a world point -- the view centre's scale, scaled by perspective. */
export function scaleAt(camera: TerrainCamera, x: number, y: number, z: number): number {
  const D = eyeDistance(camera);
  if (!Number.isFinite(D)) return camera.scale;
  const { q } = cameraSpace(camera, x, y, z);
  return (camera.scale * (D - q)) / D;
}

/**
 * The world rect that holds everything the camera can see between heights
 * `zmin` and `zmax`: the bounding box of the four screen corners inverse-projected
 * onto both planes. Exact for a flat camera, conservative otherwise.
 */
export function cullRectForCamera(camera: TerrainCamera, zmin: number, zmax: number): TerrainView {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const z of [zmin, zmax]) {
    for (const [sx, sy] of [[0, 0], [camera.width, 0], [0, camera.height], [camera.width, camera.height]]) {
      const p = screenToWorldAtZ(camera, sx, sy, z);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  return { minX, maxX, minY, maxY, flipY: false };
}

/**
 * The camera as a WebGL clip-space matrix (column-major), for scene heights
 * between `zmin` and `zmax`.
 *
 * Flat, it is `orthoFromWorldRect`'s matrix term for term, depth included: depth
 * there is `-z / zRange + 0.5`, which the pick and the weighted blend were both
 * built against. Tilted and orthographic, depth follows `q` -- distance toward
 * the eye -- over a range widened to span the tilted volume. With perspective,
 * clip w is `1 - q/D` and depth is the usual hyperbolic mapping of the scene's
 * near and far planes, so it interpolates correctly across large triangles.
 */
export function cameraClipMatrix(camera: TerrainCamera, zmin: number, zmax: number, zRange: number): Float32Array {
  const { rx, ry, dx, dy } = basis(camera);
  const ct = Math.cos(camera.tilt);
  const st = Math.sin(camera.tilt);
  const s = camera.scale;
  const ax = 2 / (s * camera.width);
  const ay = 2 / (s * camera.height);
  // Camera-space rows as functions of world (x, y, z): a, syw, q, each with a constant.
  const A = [rx, ry, 0, -(camera.cx * rx + camera.cy * ry)];
  const SY = [dx * ct, dy * ct, -st, -(camera.cx * dx + camera.cy * dy) * ct + camera.cz * st];
  const Q = [dx * st, dy * st, ct, -(camera.cx * dx + camera.cy * dy) * st - camera.cz * ct];
  const m = new Float32Array(16);
  const row = (r: number, v: number[]) => { m[r] = v[0]; m[4 + r] = v[1]; m[8 + r] = v[2]; m[12 + r] = v[3]; };
  const D = eyeDistance(camera);
  row(0, A.map((v) => v * ax));
  row(1, SY.map((v) => -v * ay));
  if (!Number.isFinite(D)) {
    if (camera.tilt === 0) {
      // Flat: exactly orthoFromWorldRect's depth, on absolute z.
      row(2, [0, 0, -1 / zRange, 0.5]);
    } else {
      // Tilted orthographic: depth by distance toward the eye, over the span the
      // view's corners and heights can reach.
      const reach = Math.max(Math.abs(zmin - camera.cz), Math.abs(zmax - camera.cz)) * ct
        + 0.5 * Math.hypot(camera.width, camera.height) * s * st;
      const r = 2.2 * Math.max(reach, 1);
      row(2, Q.map((v, i) => (-v / r) + (i === 3 ? 0.5 : 0)));
    }
    row(3, [0, 0, 0, 1]);
    return m;
  }
  // Perspective: w = 1 - q/D. Depth maps the nearest and farthest q the view can
  // hold to -1..1 hyperbolically: ndc_z = alpha + beta / w.
  const W = Q.map((v, i) => (-v / D) + (i === 3 ? 1 : 0));
  let qmin = Infinity, qmax = -Infinity;
  const rect = cullRectForCamera(camera, zmin, zmax);
  for (const x of [rect.minX, rect.maxX]) for (const y of [rect.minY, rect.maxY]) for (const z of [zmin, zmax]) {
    const q = cameraSpace(camera, x, y, z).q;
    qmin = Math.min(qmin, q); qmax = Math.max(qmax, q);
  }
  const wNear = Math.max(1 - qmax / D, 1e-4);
  const wFar = Math.max(1 - qmin / D, wNear * 1.0001);
  // alpha + beta / wNear = -1, alpha + beta / wFar = 1
  const beta = -2 / (1 / wNear - 1 / wFar);
  const alpha = -1 - beta / wNear;
  // clip_z = alpha * w + beta, so ndc_z = alpha + beta / w
  row(2, W.map((v, i) => alpha * v + (i === 3 ? beta : 0)));
  row(3, W);
  return m;
}
