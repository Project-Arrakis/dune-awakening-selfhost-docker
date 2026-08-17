import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getAdminPort, getServerPorts, resetServerPortsForTests, setAdminPort } from "./api/serverPorts";

// Regression coverage for the /api/auth/state -> setServerPorts/setAdminPort
// wiring added alongside console/api/src/config.js's resolvePorts() (see
// PR history) -- confirmed via a Requirement 20 Layer 1 audit that this
// exact call path had zero test coverage before this file was added.
afterEach(() => {
  resetServerPortsForTests();
  setAdminPort(8088);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App populates the shared serverPorts cache from /api/auth/state", () => {
  it("stores real, non-default port values and the admin port from the response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string) => {
      if (String(path).includes("/api/auth/state")) {
        return Promise.resolve(new Response(JSON.stringify({
          authenticated: false,
          csrfToken: null,
          config: {
            port: 9088,
            ports: {
              postgres: 16432,
              rmqGame: 32982,
              rmqGameHttp: 32983,
              clientBase: 8777,
              igwBase: 8888
            }
          }
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    }));

    render(<App />);

    await waitFor(() => {
      expect(getServerPorts().postgres).toBe(16432);
    });
    expect(getServerPorts().rmqGame).toBe(32982);
    expect(getServerPorts().rmqGameHttp).toBe(32983);
    expect(getServerPorts().clientBase).toBe(8777);
    expect(getServerPorts().igwBase).toBe(8888);
    expect(getAdminPort()).toBe(9088);
  });

  it("keeps stock defaults when the server response has no ports field at all (older build during a rolling upgrade)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string) => {
      if (String(path).includes("/api/auth/state")) {
        return Promise.resolve(new Response(JSON.stringify({
          authenticated: false,
          csrfToken: null
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    }));

    render(<App />);

    await waitFor(() => {
      // Nothing to await on directly here since there's no change --
      // this just confirms the app doesn't crash/error on a response
      // missing the new field, and the cache stays at its defaults.
      expect(getServerPorts().postgres).toBe(15432);
    });
    expect(getAdminPort()).toBe(8088);
  });
});
