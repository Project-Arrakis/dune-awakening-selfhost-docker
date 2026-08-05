import { describe, expect, it } from "vitest";
import { MODIFIED_CATEGORY, modifierEmptyMessage } from "./MapsPanel";

describe("modifier grid empty state", () => {
  it("reports loading before the settings schema arrives", () => {
    // Previously showed "Select a modifier category." next to an empty dropdown.
    expect(modifierEmptyMessage(false, 0, "")).toBe("Settings schema is loading.");
    expect(modifierEmptyMessage(false, 0, "spice")).toBe("Settings schema is loading.");
  });

  it("reports an empty schema separately from a category prompt", () => {
    expect(modifierEmptyMessage(true, 0, "")).toBe("No modifiers available for this target.");
  });

  it("keeps the filter and category prompts once fields exist", () => {
    expect(modifierEmptyMessage(true, 22, "spice")).toBe("No modifiers match your filter.");
    expect(modifierEmptyMessage(true, 22, "   ")).toBe("Select a modifier category.");
    expect(modifierEmptyMessage(true, 22, "")).toBe("Select a modifier category.");
  });

  it("explains an empty Modified category instead of prompting for a category", () => {
    expect(modifierEmptyMessage(true, 22, "", MODIFIED_CATEGORY)).toBe("Every setting is at its default value.");
    // A filter that matches nothing is still the more specific reason.
    expect(modifierEmptyMessage(true, 22, "spice", MODIFIED_CATEGORY)).toBe("No modifiers match your filter.");
  });
});
