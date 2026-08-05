import { describe, expect, it } from "vitest";
import { journeyActionsAvailable } from "./journeySafety";

describe("journey mutation safety", () => {
  it("keeps supported tutorial actions available", () => {
    expect(journeyActionsAvailable("Tutorial")).toBe(true);
  });

  it.each(["Story", "Contract", "Codex"])("keeps %s progression read-only", (category) => {
    expect(journeyActionsAvailable(category)).toBe(false);
  });
});
