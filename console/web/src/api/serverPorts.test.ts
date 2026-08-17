import { afterEach, describe, expect, it } from "vitest";
import {
  getAdminPort,
  getServerPorts,
  resetServerPortsForTests,
  setAdminPort,
  setServerPorts
} from "./serverPorts";

afterEach(() => {
  resetServerPortsForTests();
  setAdminPort(8088);
});

describe("serverPorts frontend cache", () => {
  it("returns stock defaults before any /api/auth/state response has arrived", () => {
    const ports = getServerPorts();
    expect(ports.postgres).toBe(15432);
    expect(ports.rmqGame).toBe(31982);
    expect(getAdminPort()).toBe(8088);
  });

  it("reflects real, non-default values once the server sends them", () => {
    setServerPorts({
      postgres: 16432,
      rmqGame: 32982,
      rmqGameHttp: 32983,
      clientBase: 8777,
      igwBase: 8888
    });
    const ports = getServerPorts();
    expect(ports.postgres).toBe(16432);
    expect(ports.rmqGame).toBe(32982);
    expect(ports.rmqGameHttp).toBe(32983);
    expect(ports.clientBase).toBe(8777);
    expect(ports.igwBase).toBe(8888);
    // Fields not present in this particular server response keep their
    // last-known-good (here, stock default) value rather than being
    // wiped out -- this matters for a server response that's missing
    // the `ports` field entirely (e.g. an older build during a rolling
    // upgrade), and is exactly what a partial update must do.
    expect(ports.director).toBe(11717);
  });

  it("ignores an undefined or null ports payload instead of resetting to stock defaults", () => {
    setServerPorts({ postgres: 16432 });
    setServerPorts(undefined);
    expect(getServerPorts().postgres).toBe(16432);
    setServerPorts(null);
    expect(getServerPorts().postgres).toBe(16432);
  });

  it("admin port only updates for a valid, in-range integer", () => {
    setAdminPort(9088);
    expect(getAdminPort()).toBe(9088);
    // Invalid values must not silently corrupt the cached value.
    setAdminPort(undefined);
    expect(getAdminPort()).toBe(9088);
    setAdminPort(null);
    expect(getAdminPort()).toBe(9088);
    setAdminPort(-1);
    expect(getAdminPort()).toBe(9088);
    setAdminPort(70000);
    expect(getAdminPort()).toBe(9088);
    setAdminPort(1.5);
    expect(getAdminPort()).toBe(9088);
  });
});
