import { describe, expect, it } from "vitest";
import { isMarkerVisibleForPartition, liveMapSecondsSince } from "./LiveMapPanel";

describe("global (partition_id 0) markers stay visible under any specific partition filter", () => {
  it("shows a global marker (e.g. a POI) regardless of which partition is selected", () => {
    expect(isMarkerVisibleForPartition({ partition_id: 0 }, "3")).toBe(true);
    expect(isMarkerVisibleForPartition({ partition_id: undefined }, "3")).toBe(true);
  });

  it("still filters a partition-scoped marker (e.g. a player) by the selected partition", () => {
    expect(isMarkerVisibleForPartition({ partition_id: 3 }, "3")).toBe(true);
    expect(isMarkerVisibleForPartition({ partition_id: 5 }, "3")).toBe(false);
  });

  it("shows everything when no partition is selected (All Partitions)", () => {
    expect(isMarkerVisibleForPartition({ partition_id: 0 }, "")).toBe(true);
    expect(isMarkerVisibleForPartition({ partition_id: 3 }, "")).toBe(true);
  });
});

describe("liveMapSecondsSince", () => {
  it("returns null for a missing timestamp", () => {
    expect(liveMapSecondsSince(null)).toBe(null);
    expect(liveMapSecondsSince(undefined)).toBe(null);
  });

  it("returns null for an unparseable timestamp instead of NaN", () => {
    expect(liveMapSecondsSince("not-a-date")).toBe(null);
  });

  it("computes non-negative whole seconds elapsed for a real timestamp", () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    const seconds = liveMapSecondsSince(tenSecondsAgo);
    expect(seconds).not.toBeNull();
    expect(seconds as number).toBeGreaterThanOrEqual(9);
    expect(seconds as number).toBeLessThanOrEqual(11);
  });

  it("clamps a timestamp that is (implausibly) in the future to zero, never negative", () => {
    const inTheFuture = new Date(Date.now() + 60_000).toISOString();
    expect(liveMapSecondsSince(inTheFuture)).toBe(0);
  });
});
