import { describe, expect, it } from "vitest";
import { formatAbsoluteDateTime, formatRelativeAge, parseDateValue } from "./display";

describe("formatAbsoluteDateTime", () => {
  it("uses one style for the whole console: short month, no seconds", () => {
    const formatted = formatAbsoluteDateTime("2026-09-19T15:01:09.245Z");
    // Short month name, not a numeric month -- "Sep", never "9/19/2026".
    expect(formatted).toMatch(/[A-Za-z]{3}/);
    expect(formatted).not.toMatch(/^\d+\/\d+\/\d+/);
    // Seconds are shown nowhere else in the app, so they must not appear here.
    expect(formatted).not.toMatch(/:\d{2}:\d{2}/);
    expect(formatted).toContain("2026");
  });

  it("falls back rather than rendering Invalid Date", () => {
    expect(formatAbsoluteDateTime(null)).toBe("Unavailable");
    expect(formatAbsoluteDateTime("")).toBe("Unavailable");
    expect(formatAbsoluteDateTime("not a date")).toBe("Unavailable");
    expect(formatAbsoluteDateTime(null, "Unknown")).toBe("Unknown");
  });

  it("accepts a Date as well as a string", () => {
    const date = new Date("2026-09-19T15:01:09.245Z");
    expect(formatAbsoluteDateTime(date)).toBe(formatAbsoluteDateTime(date.toISOString()));
  });
});

describe("parseDateValue", () => {
  it("returns null for every unusable value rather than an Invalid Date", () => {
    expect(parseDateValue(null)).toBeNull();
    expect(parseDateValue(undefined)).toBeNull();
    expect(parseDateValue("")).toBeNull();
    expect(parseDateValue("nonsense")).toBeNull();
    expect(parseDateValue("2026-09-19T15:01:09Z")).toBeInstanceOf(Date);
  });
});

describe("formatRelativeAge", () => {
  const now = new Date("2026-09-19T12:00:00Z").getTime();
  const ago = (ms: number) => formatRelativeAge(new Date(now - ms), now);

  it("picks the largest unit that fits", () => {
    expect(ago(45 * 1000)).toBe("45s");
    expect(ago(5 * 60 * 1000)).toBe("5m");
    expect(ago(3 * 60 * 60 * 1000)).toBe("3h");
    expect(ago(2 * 24 * 60 * 60 * 1000)).toBe("2d");
    expect(ago(90 * 24 * 60 * 60 * 1000)).toBe("3mo");
    expect(ago(400 * 24 * 60 * 60 * 1000)).toBe("1y");
  });

  it("never renders 0 or a negative age", () => {
    expect(ago(0)).toBe("1s");
    expect(ago(-60 * 1000)).toBe("1s");
  });
});
