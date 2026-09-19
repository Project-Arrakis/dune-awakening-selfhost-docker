import { describe, expect, it } from "vitest";
import { convertUtcLogTimestamps } from "./logTime";

describe("convertUtcLogTimestamps", () => {
  it("converts bracketed UTC log timestamps without changing the message", () => {
    expect(convertUtcLogTimestamps("[2026-08-24 11:25:41,177][root] INFO: Ready", "America/New_York"))
      .toBe("[2026-08-24 07:25:41,177 EDT][root] INFO: Ready");
  });

  it("converts leading ISO UTC timestamps", () => {
    expect(convertUtcLogTimestamps("2026-01-24T11:25:41.177Z service ready", "America/New_York"))
      .toBe("2026-01-24 06:25:41.177 EST service ready");
  });

  it("leaves unrecognized timestamps and message dates untouched", () => {
    const text = "event date 2026-08-24 11:25:41\nNo timestamp here";
    expect(convertUtcLogTimestamps(text, "America/New_York")).toBe(text);
  });
});
