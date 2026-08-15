import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAdminPort,
  getServerPorts,
  refreshServerPorts,
  resetServerPortsForTests,
  setAdminPort,
  setServerPorts
} from "./serverPorts";

afterEach(() => {
  resetServerPortsForTests();
  setAdminPort(8088);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  // Upstream review finding (PR #157): the port cache above is
  // populated only once, by App.tsx's initial /api/auth/state fetch on
  // mount. If Port/IGWPort is changed later in the session (via the
  // Maps UI's raw UserEngine.ini save, the only console-driven path
  // that can write these fields), the cache previously stayed stale
  // until a full page reload. refreshServerPorts() re-fetches
  // /api/auth/state on demand and updates the cache in place.
  it("refreshServerPorts() re-fetches /api/auth/state and updates the cache in place", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ config: { ports: { clientBase: 8777, igwBase: 8888 }, port: 9088 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));
    expect(getServerPorts().clientBase).toBe(7777);
    expect(getAdminPort()).toBe(8088);
    await refreshServerPorts();
    expect(getServerPorts().clientBase).toBe(8777);
    expect(getServerPorts().igwBase).toBe(8888);
    expect(getAdminPort()).toBe(9088);
  });

  it("refreshServerPorts() leaves the cache unchanged on a fetch failure or non-OK response", async () => {
    setServerPorts({ clientBase: 8777 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    await refreshServerPorts();
    // a failed refresh must not wipe out the last-known-good cached value
    expect(getServerPorts().clientBase).toBe(8777);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    await expect(refreshServerPorts()).resolves.toBeUndefined();
    expect(getServerPorts().clientBase).toBe(8777);
  });
});
