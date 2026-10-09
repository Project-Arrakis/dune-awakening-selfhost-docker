import test from "node:test";
import assert from "node:assert/strict";
import { playerAccessParam } from "../src/playerAccessParam.js";

const param = (query) => playerAccessParam(new URL(`http://localhost/api/players/1/bases${query}`));

test("playerAccessParam accepts owner and coowner", () => {
  assert.equal(param("?access=owner"), "owner");
  assert.equal(param("?access=coowner"), "coowner");
});

test("playerAccessParam treats a missing or unrecognised value as all, so older clients keep their behaviour", () => {
  assert.equal(param(""), "all");
  assert.equal(param("?access=all"), "all");
  assert.equal(param("?access=bogus"), "all");
  assert.equal(param("?access=OWNER"), "all");
  assert.equal(param("?access="), "all");
});
