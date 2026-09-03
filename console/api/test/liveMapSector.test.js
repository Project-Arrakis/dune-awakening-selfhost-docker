import test from "node:test";
import assert from "node:assert/strict";
import {
  deepDesertSectorForWorldPoint,
  sectorForMapPoint,
  withLiveMapSector
} from "../src/liveMapSector.js";

const CENTRE_X = -52656;
const CENTRE_Y = -52066;
const HALF = 1125000;

test("Deep Desert sector letters and numbers match the in-game grid orientation", () => {
  assert.equal(deepDesertSectorForWorldPoint(CENTRE_X - HALF, CENTRE_Y + HALF), "A1");
  assert.equal(deepDesertSectorForWorldPoint(CENTRE_X + HALF - 1, CENTRE_Y + HALF), "A9");
  assert.equal(deepDesertSectorForWorldPoint(CENTRE_X - HALF, CENTRE_Y - HALF + 1), "I1");
  assert.equal(deepDesertSectorForWorldPoint(CENTRE_X + HALF - 1, CENTRE_Y - HALF + 1), "I9");
  assert.equal(deepDesertSectorForWorldPoint(CENTRE_X, CENTRE_Y), "E5");
});

test("known active large spice coordinates resolve to their Deep Desert sector", () => {
  assert.equal(deepDesertSectorForWorldPoint(129775, -238525), "F6");
});

test("coordinates outside the grid or without finite numbers return null", () => {
  assert.equal(deepDesertSectorForWorldPoint(CENTRE_X + HALF, CENTRE_Y), null);
  assert.equal(deepDesertSectorForWorldPoint(CENTRE_X, CENTRE_Y - HALF), null);
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
