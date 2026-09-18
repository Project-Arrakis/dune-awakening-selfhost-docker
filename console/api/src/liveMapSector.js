// Game-coordinate constants for the Deep Desert's 9x9 sector grid. Columns
// increase west-to-east; letters increase from the high-Y edge to the low-Y
// edge, matching the labels baked into the in-game map (A at the bottom of the
// rendered map and I at the top).
const DEEP_DESERT_CENTRE_X = -52656;
const DEEP_DESERT_CENTRE_Y = -52066;
const DEEP_DESERT_GRID_HALF_SIZE = 1125000;
const DEEP_DESERT_SECTOR_SIZE = 250000;
const DEEP_DESERT_SECTOR_COUNT = 9;

export function deepDesertSectorForWorldPoint(x, y) {
  const worldX = Number(x);
  const worldY = Number(y);
  if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return null;

  const column = Math.floor((worldX - (DEEP_DESERT_CENTRE_X - DEEP_DESERT_GRID_HALF_SIZE)) / DEEP_DESERT_SECTOR_SIZE);
  const row = Math.floor((DEEP_DESERT_CENTRE_Y + DEEP_DESERT_GRID_HALF_SIZE - worldY) / DEEP_DESERT_SECTOR_SIZE);
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
