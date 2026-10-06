import test from "node:test";
import assert from "node:assert/strict";
import {
  deepDesertSectorForWorldPoint,
  sectorForMapPoint,
  withLiveMapSector
} from "../src/liveMapSector.js";

const CENTRE_X = -52656;
const CENTRE_Y = -52066;
// The measured grid: low-X edge, high-Y edge, cell width and height.
const MIN_X = -1268450;
const MAX_Y = 1163467;
const WIDTH = 269650;
const HEIGHT = 269217;

test("Deep Desert sector letters and numbers match the in-game grid orientation", () => {
  assert.equal(deepDesertSectorForWorldPoint(MIN_X, MAX_Y), "A1");
  assert.equal(deepDesertSectorForWorldPoint(MIN_X + 9 * WIDTH - 1, MAX_Y), "A9");
  assert.equal(deepDesertSectorForWorldPoint(MIN_X, MAX_Y - 9 * HEIGHT + 1), "I1");
  assert.equal(deepDesertSectorForWorldPoint(MIN_X + 9 * WIDTH - 1, MAX_Y - 9 * HEIGHT + 1), "I9");
  assert.equal(deepDesertSectorForWorldPoint(CENTRE_X, CENTRE_Y), "E5");
});

test("known active large spice coordinates resolve to their Deep Desert sector", () => {
  assert.equal(deepDesertSectorForWorldPoint(129775, -238525), "F6");
});

// In-game map labels read at exact positions (2026-10-04), plus older anchors.
// The pairs straddling a line by a few thousand uu pin the grid.
test("every sector label read in game is reproduced", () => {
  const readings = [
    [-30000, 100000, "D5"], [-30000, 350000, "D5"], [-30000, 900000, "A5"], [900000, -710000, "G9"],
    [886000, -724000, "H8"], [890500, -719000, "G9"], [889200, -720500, "G9"], [888560, -721240, "H8"],
    [-1001800, 898200, "A1"], [-997000, 895000, "A2"], [-999400, 892000, "B1"], [-998200, 893500, "B2"],
    [474472, 575390, "C7"], [-1106224, -307716, "F1"]
  ];
  for (const [x, y, sector] of readings) {
    assert.equal(deepDesertSectorForWorldPoint(x, y), sector, `(${x}, ${y})`);
  }
});

test("coordinates outside the grid or without finite numbers return null", () => {
  assert.equal(deepDesertSectorForWorldPoint(MIN_X + 9 * WIDTH, CENTRE_Y), null);
  assert.equal(deepDesertSectorForWorldPoint(CENTRE_X, MAX_Y - 9 * HEIGHT), null);
  assert.equal(deepDesertSectorForWorldPoint("not-a-coordinate", 0), null);
});

test("sector conversion applies only to Deep Desert map identifiers", () => {
  assert.equal(sectorForMapPoint("DeepDesert", CENTRE_X, CENTRE_Y), "E5");
  assert.equal(sectorForMapPoint("DeepDesert_1", CENTRE_X, CENTRE_Y), "E5");
  assert.equal(sectorForMapPoint("HaggaBasin", CENTRE_X, CENTRE_Y), undefined);
});

test("Deep Desert API rows expose null outside the grid while other maps omit sector", () => {
  assert.deepEqual(withLiveMapSector({ map: "DeepDesert", x: 99999999, y: 0 }), {
    map: "DeepDesert", x: 99999999, y: 0, sector: null
  });
  const hagga = { map: "HaggaBasin", x: CENTRE_X, y: CENTRE_Y };
  assert.equal(withLiveMapSector(hagga), hagga);
});
