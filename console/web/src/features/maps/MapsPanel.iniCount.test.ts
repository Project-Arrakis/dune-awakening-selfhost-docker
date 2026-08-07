import { describe, expect, it } from "vitest";
import { countIniOverrides } from "./MapsPanel";

const header = [
  "; Experimental: Engine.ini for the Dune: Awakening client.",
  "; Generated from Docker UserEngine.ini values for global UserEngine.",
  "; Copy these sections into Saved/Config/WindowsClient/Engine.ini while the game is closed.",
  "; Only settings changed from the default are listed. Delete any keys from an earlier copy that are not here.",
].join("\n");

describe("client ini override count", () => {
  it("counts nothing in a header-only export", () => {
    expect(countIniOverrides(header + "\n")).toBe(0);
    expect(countIniOverrides("")).toBe(0);
  });

  it("counts setting lines but not comments or section headers", () => {
    const content = `${header}\n\n[ConsoleVariables]\nVehicle.MaxVehiclesPerPlayer=25\nHydration.SunExposureEnabled=0\n`;
    expect(countIniOverrides(content)).toBe(2);
  });

  it("counts across multiple sections and tolerates CRLF and indentation", () => {
    const content = "[A]\r\nOne=1\r\n\r\n[B]\r\n  Two=2\r\n; trailing note\r\n";
    expect(countIniOverrides(content)).toBe(2);
  });
});
