import { describe, expect, it } from "vitest";
import { configFromSetupState, validDatacenterId } from "./SetupWizard";

describe("SetupWizard Datacenter ID", () => {
  it("loads the dedicated value when configured", () => {
    expect(configFromSetupState({
      HOST_DATACENTER_ID: "ping.example.com",
      SERVER_PROVIDER: "legacy-provider"
    }).HOST_DATACENTER_ID).toBe("ping.example.com");
  });

  it("migrates the legacy Provider value for an existing installation", () => {
    expect(configFromSetupState({ SERVER_PROVIDER: "legacy-provider" }).HOST_DATACENTER_ID).toBe("legacy-provider");
  });

  it("validates hostnames and short IDs", () => {
    expect(validDatacenterId("ping.example.com")).toBe(true);
    expect(validDatacenterId("dune-docker")).toBe(true);
    expect(validDatacenterId("https://example.com")).toBe(false);
  });
});
