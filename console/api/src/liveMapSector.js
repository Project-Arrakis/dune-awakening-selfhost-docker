// The Deep Desert's 9x9 sector grid, measured in game: it is larger than the
// terrain rect and its cells are not square. Columns increase west-to-east;
// letters increase from the high-Y edge to the low-Y edge (A at the bottom of
// the rendered map, I at the top). Keep in step with liveMapSectorGrid.ts.
const DEEP_DESERT_GRID_MIN_X = -1268450;
const DEEP_DESERT_GRID_MAX_Y = 1163467;
const DEEP_DESERT_SECTOR_WIDTH = 269650;
const DEEP_DESERT_SECTOR_HEIGHT = 269217;
const DEEP_DESERT_SECTOR_COUNT = 9;

export function deepDesertSectorForWorldPoint(x, y) {
  const worldX = Number(x);
  const worldY = Number(y);
  if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return null;

  const column = Math.floor((worldX - DEEP_DESERT_GRID_MIN_X) / DEEP_DESERT_SECTOR_WIDTH);
  const row = Math.floor((DEEP_DESERT_GRID_MAX_Y - worldY) / DEEP_DESERT_SECTOR_HEIGHT);
  if (column < 0 || column >= DEEP_DESERT_SECTOR_COUNT || row < 0 || row >= DEEP_DESERT_SECTOR_COUNT) return null;
  return `${String.fromCharCode(65 + row)}${column + 1}`;
}

export function sectorForMapPoint(map, x, y) {
  const mapName = String(map || "").replace(/[\s_-]/g, "").toLowerCase();
  if (mapName !== "deepdesert" && mapName !== "deepdesert1") return undefined;
  return deepDesertSectorForWorldPoint(x, y);
}

export function withLiveMapSector(row) {
  const sector = sectorForMapPoint(row?.map, row?.x, row?.y);
  return sector === undefined ? row : { ...row, sector };
}
