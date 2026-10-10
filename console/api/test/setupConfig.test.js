import test from "node:test";
import assert from "node:assert/strict";
import { SETUP_CONFIG_KEYS, validHostDatacenterId } from "../src/services/setupConfig.js";

test("setup config exposes a dedicated Datacenter ID setting", () => {
  assert.equal(SETUP_CONFIG_KEYS.includes("HOST_DATACENTER_ID"), true);
  assert.equal(SETUP_CONFIG_KEYS.includes("SERVER_PROVIDER"), true, "legacy Provider must remain readable during upgrades");
});

test("Datacenter ID accepts hostnames and short IDs", () => {
  for (const value of ["dune-docker", "dune.example.com", "server-01.eu.example.com"]) {
    assert.equal(validHostDatacenterId(value), true, value);
  }
});

test("Datacenter ID rejects values that cannot be safe host identities", () => {
  for (const value of ["", " bad.example.com", "bad.example.com ", "https://example.com", "bad_name", "-bad", "bad.", "a".repeat(254)]) {
    assert.equal(validHostDatacenterId(value), false, value);
  }
});
