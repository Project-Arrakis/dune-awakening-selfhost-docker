import { describe, expect, it } from "vitest";
import { journeyActionsAvailable } from "./journeySafety";

describe("journey mutation safety", () => {
  it("keeps supported tutorial actions available", () => {
    expect(journeyActionsAvailable("Tutorial")).toBe(true);
  });

  it.each(["Story", "Contract", "Codex"])("allows offline-safe %s progression actions", (category) => {
    expect(journeyActionsAvailable(category)).toBe(true);
  });

  it("rejects unknown categories", () => {
    expect(journeyActionsAvailable("Unknown")).toBe(false);
  });
});
