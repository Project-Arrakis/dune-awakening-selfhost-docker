import { describe, expect, it } from "vitest";
import { inventoryDurabilityError } from "./inventoryDurability";

describe("inventory durability validation", () => {
  it("allows a specialization-crafted item to be repaired to its stored maximum", () => {
    expect(inventoryDurabilityError("200", "200", true)).toBe("");
  });

  it("does not impose a global ceiling on a legitimate stored maximum", () => {
    expect(inventoryDurabilityError("250", "250", true)).toBe("");
  });

  it("rejects current durability above a normal item's stored maximum", () => {
    expect(inventoryDurabilityError("200", "100", true)).toBe(
      "Current Durability must be a number between 0 and the item's stored Max Durability."
    );
  });

  it("rejects an invalid stored maximum instead of guessing", () => {
    expect(inventoryDurabilityError("50", "", true)).toBe(
      "This item's stored maximum durability is invalid and cannot be edited safely."
    );
  });
});
