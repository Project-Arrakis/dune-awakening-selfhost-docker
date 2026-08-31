import { describe, it, expect } from "vitest";
import { encodeRoleNamesForWire, decodeRoleNamesFromWire } from "./discordRoleNames";

// F3, #573: must match the server's wire format exactly (base64url JSON) --
// console/api/src/integrations/discord/roleTiers.js's encodeRoleNames/
// decodeRoleNamesSafe. These are separate implementations (browser vs. Node
// Buffer) of the same contract, so both directions are pinned here.

describe("discordRoleNames wire format", () => {
  it("round-trips a simple map", () => {
    const map = { "100000000000000002": "Heavy Bats" };
    expect(decodeRoleNamesFromWire(encodeRoleNamesForWire(map))).toEqual(map);
  });

  it("round-trips names containing quotes and unicode", () => {
    const map = { "100000000000000002": 'Heavy "Bats" 🦇' };
    expect(decodeRoleNamesFromWire(encodeRoleNamesForWire(map))).toEqual(map);
  });

  it("encodes to pure base64url -- no characters the server's .env writer would need to escape", () => {
    const encoded = encodeRoleNamesForWire({ "100000000000000002": 'quoted "value"' });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("decodes an empty/absent value to an empty map, never throws", () => {
    expect(decodeRoleNamesFromWire("")).toEqual({});
  });

  it("fails safe to {} on malformed base64url or JSON", () => {
    expect(decodeRoleNamesFromWire("not-valid-base64url!!!")).toEqual({});
    expect(decodeRoleNamesFromWire(encodeRoleNamesForWire as unknown as string)).toEqual({});
  });

  it("drops non-string values from a decoded map rather than passing them through", () => {
    const raw = encodeRoleNamesForWire({} as Record<string, string>);
    // Build a map with a non-string value the server-side type would reject too.
    const withBadValue = btoa(JSON.stringify({ "100000000000000002": 42 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeRoleNamesFromWire(withBadValue)).toEqual({});
    expect(raw).toBeTruthy();
  });
});
