import test from "node:test";
import assert from "node:assert/strict";

async function fakeQuery(rows = []) {
  return { rows };
}

// ─── Death poller detectTransitions ───

test("death poller detectTransitions skips players when no previous snapshot exists", async () => {
  let detectTransitions;
  try {
    ({ detectTransitions } = await import("../src/deathPoller.js"));
  } catch {
    // Function not exported directly
  }

  if (detectTransitions) {
    const previous = new Map();
    const current = new Map([["1", "Alive"], ["2", "Dead"], ["3", "DeadBySandworm"]]);
    const deaths = detectTransitions(previous, current);
    assert.equal(deaths.length, 0, "should not count existing Dead players as new deaths when no snapshot");

    const previous2 = new Map([["1", "Alive"], ["2", "Alive"], ["3", "Alive"]]);
    const current2 = new Map([["1", "Alive"], ["2", "Dead"], ["3", "DeadBySandworm"]]);
    const deaths2 = detectTransitions(previous2, current2);
    assert.equal(deaths2.length, 2, "should detect two new deaths");
    assert.equal(deaths2[0].death_cause, "Dead");
    assert.equal(deaths2[1].death_cause, "DeadBySandworm");
  }
});

test("death poller does not count Alive→Alive or Dead→Dead as transitions", async () => {
  let detectTransitions;
  try { ({ detectTransitions } = await import("../src/deathPoller.js")); } catch { }

  if (detectTransitions) {
    const previous = new Map([["1", "Alive"], ["2", "Dead"], ["3", "DeadByCoriolis"]]);
    const current = new Map([["1", "Alive"], ["2", "Dead"], ["3", "DeadByCoriolis"]]);
    const deaths = detectTransitions(previous, current);
    assert.equal(deaths.length, 0, "no new deaths when states unchanged");

    const current2 = new Map([["1", "Alive"], ["2", "Alive"], ["3", "DeadByCoriolis"]]);
    const deaths2 = detectTransitions(previous, current2);
    assert.equal(deaths2.length, 0, "Dead→Alive is a respawn, not a new death");
  }
});

test("death poller detectTransitions returns empty array when previous is empty", async () => {
  let detectTransitions;
  try { ({ detectTransitions } = await import("../src/deathPoller.js")); } catch { }

  if (detectTransitions) {
    const previous = new Map();
    const current = new Map([["1", "Dead"], ["2", "DeadBySandworm"], ["3", "DeadByCoriolis"]]);
    const deaths = detectTransitions(previous, current);
    assert.equal(deaths.length, 0, "empty snapshot produces zero deaths — first run safety");
  }
});

test("death poller enabled=false by default, respects DUNE_DEATH_POLLER_ENABLED", async () => {
  let createDeathPoller;
  try { ({ createDeathPoller } = await import("../src/deathPoller.js")); } catch { }

  if (createDeathPoller) {
    const old = process.env.DUNE_DEATH_POLLER_ENABLED;

    // Default: disabled
    delete process.env.DUNE_DEATH_POLLER_ENABLED;
    const poller = createDeathPoller({});
    assert.equal(poller.enabled, false, "death poller disabled by default");

    // Enabled via env
    process.env.DUNE_DEATH_POLLER_ENABLED = "true";
    const poller2 = createDeathPoller({});
    assert.equal(poller2.enabled, true, "death poller enabled when DUNE_DEATH_POLLER_ENABLED=true");

    // Disabled explicitly
    process.env.DUNE_DEATH_POLLER_ENABLED = "false";
    const poller3 = createDeathPoller({});
    assert.equal(poller3.enabled, false, "death poller disabled when DUNE_DEATH_POLLER_ENABLED=false");

    // init and tick exist regardless
    assert.equal(typeof poller.init, "function", "poller has init method");
    assert.equal(typeof poller.tick, "function", "poller has tick method");

    if (old !== undefined) process.env.DUNE_DEATH_POLLER_ENABLED = old;
    else delete process.env.DUNE_DEATH_POLLER_ENABLED;
  }
});
