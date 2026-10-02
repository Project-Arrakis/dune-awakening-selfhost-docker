import type { LiveMapConfig, LiveMapMarker } from "../../api/liveMap";
import { fovForTilt, screenToWorldAtZ } from "./terrain/terrainCamera";
import type { TerrainCamera } from "./terrain/terrainCamera";

// The Live Map's coordinate maths, extracted from LiveMapPanel so it can be
// tested without rendering a 1300-line component. Behaviour is unchanged; the
// terrain renderer needs the same mapping the markers use, and the two agreeing
// by construction is the whole point.

// 8, not 4: the Deep Desert is drawn from geometry now, so rock holds up at any
// magnification and the limit is the sand. Compared at one spot across 4/6/8/12,
// the dune ripples stay readable to 8 (74 uu/px) and look washed out by 12.
// Hagga Basin still uses a 4096px image, so its own detail runs out sooner --
// this is a ceiling, not a recommendation.
export const MAX_LIVE_MAP_ZOOM = 8;
export const MIN_ZOOM_FIT_FACTOR = 1;

export type LiveMapPoint = { px: number; py: number; inBounds: boolean };

/**
 * How far outside the map rect a marker may sit and still be drawn.
 *
 * The rect is the sector square the image covers, and the world does not stop
 * dead at its edge: measured on a live farm, a player and the ornithopter they
 * were flying sat 4,216 uu past the north edge, and a handful of world markers
 * about 1,100 uu past it. A hard cut drops exactly the marker an admin is most
 * likely to be hunting for. 16 px is about 8,800 uu here -- twice the worst case
 * observed -- and markers are still drawn at their true position, never clamped.
 */
const EDGE_TOLERANCE_PX = 16;

export function worldToLiveMapPoint(marker: Pick<LiveMapMarker, "x" | "y">, config: LiveMapConfig): LiveMapPoint | null {
  const x = Number(marker.x);
  const y = Number(marker.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (config.maxX === config.minX || config.maxY === config.minY) return null;
  const px = ((x - config.minX) / (config.maxX - config.minX)) * config.width;
  let py = ((y - config.minY) / (config.maxY - config.minY)) * config.height;
  if (config.flipY) py = config.height - py;
  return {
    px,
    py,
    inBounds: px >= -EDGE_TOLERANCE_PX && px <= config.width + EDGE_TOLERANCE_PX
      && py >= -EDGE_TOLERANCE_PX && py <= config.height + EDGE_TOLERANCE_PX
  };
}

export function liveMapPixelsToWorld(px: number, py: number, config: LiveMapConfig) {
  if (!Number.isFinite(px) || !Number.isFinite(py) || config.width === 0 || config.height === 0) return null;
  let normalizedY = py / config.height;
  if (config.flipY) normalizedY = 1 - normalizedY;
  return {
    x: config.minX + (px / config.width) * (config.maxX - config.minX),
    y: config.minY + normalizedY * (config.maxY - config.minY)
  };
}

export function liveMapMinimumZoom(config: LiveMapConfig | null | undefined, frame: HTMLElement | null) {
  if (!config || !frame) return 0.16;
  // Math.min, not Math.max -- this needs to be a "contain" fit (the whole
  // map visible, letterboxed on the shorter axis) so the fully-zoomed-out
  // view never overflows the frame and forces a scrollbar. Math.max would
  // "cover" the frame instead, cropping whichever axis has the smaller
  // required ratio.
  const fitRatio = Math.min(frame.clientWidth / config.width, frame.clientHeight / config.height);
  return Math.max(0.02, fitRatio * MIN_ZOOM_FIT_FACTOR);
}

export function clampLiveMapZoom(value: number, minimum = 0.16) {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(MAX_LIVE_MAP_ZOOM, value));
}

/**
 * The world rectangle currently scrolled into view, for the terrain renderer.
 *
 * The panel scrolls a div and scales a canvas element by `zoom`; the renderer
 * has no camera of its own and draws exactly the rect it is given. Deriving that
 * rect through `liveMapPixelsToWorld` -- the same inverse the double-click
 * teleport uses -- is what keeps terrain and markers on the same pixel.
 */
export function visibleWorldRect(
  config: LiveMapConfig,
  zoom: number,
  scrollLeft: number,
  scrollTop: number,
  viewWidth: number,
  viewHeight: number
) {
  const a = liveMapPixelsToWorld(scrollLeft / zoom, scrollTop / zoom, config);
  const b = liveMapPixelsToWorld((scrollLeft + viewWidth) / zoom, (scrollTop + viewHeight) / zoom, config);
  if (!a || !b) return null;
  return {
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
    flipY: config.flipY
  };
}

/**
 * Where the terrain canvas sits inside the scrolled map, CSS pixels: it covers
 * the viewport (or the whole map, when that is smaller), clamped to the map's
 * extent -- see DeepDesertTerrain for why the clamp is load-bearing. Shared so
 * the 3D markers are placed against exactly the canvas the terrain draws into.
 */
export function terrainViewport(config: LiveMapConfig, zoom: number, scrollLeft: number, scrollTop: number, frameWidth: number, frameHeight: number) {
  const mapWidth = Math.floor(config.width * zoom);
  const mapHeight = Math.floor(config.height * zoom);
  const width = Math.min(frameWidth, mapWidth);
  const height = Math.min(frameHeight, mapHeight);
  const left = Math.min(Math.max(scrollLeft, 0), Math.max(0, mapWidth - width));
  const top = Math.min(Math.max(scrollTop, 0), Math.max(0, mapHeight - height));
  return { left, top, width, height };
}

/**
 * The 3D camera for the panel's current scroll and zoom: the viewport's centre
 * is the camera's target, at height `cz`, and the scale there is the flat map's
 * scale. Tilt and yaw are radians; perspective follows tilt.
 */
export function liveMapCamera(
  config: LiveMapConfig,
  zoom: number,
  viewport: { left: number; top: number; width: number; height: number },
  tilt: number,
  yaw: number,
  cz: number
): TerrainCamera | null {
  const centre = liveMapPixelsToWorld((viewport.left + viewport.width / 2) / zoom, (viewport.top + viewport.height / 2) / zoom, config);
  if (!centre || viewport.width <= 0 || viewport.height <= 0) return null;
  return {
    cx: centre.x,
    cy: centre.y,
    cz,
    scale: (config.maxX - config.minX) / config.width / zoom,
    width: viewport.width,
    height: viewport.height,
    tilt,
    yaw,
    fov: fovForTilt(tilt)
  };
}

/**
 * How far to scroll, CSS pixels, so that a drag from one viewport pixel to
 * another carries the ground with it: the point grabbed, at height `z`, ends up
 * under the pointer. Flat, that is just the drag reversed. Tilted and rotated it
 * is the difference between the two pixels' ground points -- exact anywhere in
 * the view, perspective included, because moving the camera's centre moves every
 * projected point rigidly. `camera` is the one in force when the drag began.
 *
 * Unflipped maps only, like the camera itself: world axes and scroll axes agree.
 */
export function panScrollDelta(camera: TerrainCamera, from: { sx: number; sy: number }, to: { sx: number; sy: number }, z: number) {
  const grabbed = screenToWorldAtZ(camera, from.sx, from.sy, z);
  const under = screenToWorldAtZ(camera, to.sx, to.sy, z);
  return { left: (grabbed.x - under.x) / camera.scale, top: (grabbed.y - under.y) / camera.scale };
}

/**
 * Where the camera centre must move, in world units, so that zooming from
 * `oldZoom` to `newZoom` keeps `anchor` (a world point) under the same pixel.
 * Exact even with perspective: the eye distance scales with the scale, so the
 * whole projection scales uniformly about the target.
 */
export function zoomCentreFor(camera: TerrainCamera, anchor: { x: number; y: number }, oldZoom: number, newZoom: number) {
  const f = oldZoom / newZoom;
  return { x: anchor.x - (anchor.x - camera.cx) * f, y: anchor.y - (anchor.y - camera.cy) * f };
}
