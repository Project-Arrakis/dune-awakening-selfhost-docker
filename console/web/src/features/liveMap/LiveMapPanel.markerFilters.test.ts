import { describe, expect, it } from "vitest";
import { mergeMarkerTypeFilters } from "./LiveMapPanel";

describe("live map marker-type filter auto-population", () => {
  it("adds a filter entry, defaulted to visible, for a marker type not already tracked", () => {
    const current = { player: true, vehicle: true, base: true, storage: true };
    const markers = [{ id: "1", type: "poi", x: 0, y: 0 }, { id: "2", type: "resource", x: 0, y: 0 }];

    expect(mergeMarkerTypeFilters(current, markers)).toEqual({
      player: true, vehicle: true, base: true, storage: true, poi: true, resource: true
    });
  });

  it("preserves an operator's existing toggle choice instead of resetting it", () => {
    const current = { player: true, vehicle: false, base: true, storage: true, poi: false };
    const markers = [{ id: "1", type: "poi", x: 0, y: 0 }];

    expect(mergeMarkerTypeFilters(current, markers)).toEqual(current);
  });

  it("returns the same object reference when nothing is missing, to avoid an unnecessary re-render", () => {
    const current = { player: true };
    const markers = [{ id: "1", type: "player", x: 0, y: 0 }];

    expect(mergeMarkerTypeFilters(current, markers)).toBe(current);
  });

  it("handles an empty marker list without adding anything", () => {
    const current = { player: true, vehicle: true, base: true, storage: true };
    expect(mergeMarkerTypeFilters(current, [])).toBe(current);
  });
});
