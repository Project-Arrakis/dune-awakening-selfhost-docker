import { describe, it, expect } from "vitest";
import { elevationIntervals } from "./renderer";

// The interval is what makes the elevation lines readable or useless, and both
// failure modes were hit while building this: derived from horizontal scale
// alone it landed on 5,000 uu at 199 uu/px, so a 6,000 uu formation got a single
// line; and letting sand track rock all the way out put sand at 40,000 uu, wider
// than the whole ~21,600 uu sand field, so those lines vanished entirely.
describe("elevationIntervals", () => {
  it("never goes finer than the base, however far you zoom in", () => {
    for (const uuPerPixel of [0.5, 10, 100, 166]) {
      const [rock] = elevationIntervals(uuPerPixel);
      expect(rock).toBeGreaterThanOrEqual(200);
    }
    // At a scale where 1.5x uuPerPixel is under the 250 floor, every zoom level
    // shares one interval, so lines do not crawl as you zoom.
    expect(elevationIntervals(10)[0]).toBe(elevationIntervals(100)[0]);
  });

  it("coarsens as you zoom out", () => {
    const close = elevationIntervals(229)[0];
    const far = elevationIntervals(3373)[0];
    expect(far).toBeGreaterThan(close);
  });

  it("snaps to a 1-2-5 sequence rather than arbitrary values", () => {
    for (const uuPerPixel of [50, 229, 700, 1500, 3373, 9000]) {
      const [rock] = elevationIntervals(uuPerPixel);
      const mantissa = rock / Math.pow(10, Math.floor(Math.log10(rock)));
      expect([1, 2, 5]).toContain(Math.round(mantissa));
    }
  });

  it("keeps sand coarser than rock but caps it so it cannot exceed the dune relief", () => {
    const [rockClose, sandClose] = elevationIntervals(229);
    expect(sandClose).toBe(rockClose * 8);

    // Zoomed out, the uncapped value would be 40,000 -- past the ~21,600 uu the
    // sand field spans, which erased the sand lines completely.
    const [rockFar, sandFar] = elevationIntervals(3373);
    expect(rockFar * 8).toBeGreaterThan(2500);
    expect(sandFar).toBe(2500);
  });

  it("stays finite and positive at degenerate scales", () => {
    for (const uuPerPixel of [0, -1, Number.EPSILON]) {
      const [rock, sand] = elevationIntervals(uuPerPixel);
      expect(Number.isFinite(rock)).toBe(true);
      expect(rock).toBeGreaterThan(0);
      expect(sand).toBeGreaterThan(0);
    }
  });
});
