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

test("playerAccessParam never lets a hostile value through: only the two literals are ever returned", () => {
  const hostile = ["owner'--", "coowner or 1=1", "owner%00", "owner%20", "%20owner", "access", "__proto__", "constructor", "owner,coowner", "[owner]"];
  for (const value of hostile) {
    assert.equal(param(`?access=${value}`), "all", value);
  }
  assert.equal(param("?access[]=owner"), "all", "bracket syntax is a different parameter name");
  assert.equal(param("?Access=owner"), "all", "the name is case-sensitive");
});

test("playerAccessParam decodes percent-encoding, and the first of a repeated parameter wins", () => {
  assert.equal(param("?access=%6Fwner"), "owner");
  assert.equal(param("?access=owner&access=coowner"), "owner");
  assert.equal(param("?access=bogus&access=owner"), "all");
});
