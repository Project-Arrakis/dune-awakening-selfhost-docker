// Single source of truth, on the frontend side, for every host-facing
// port the console needs to display or reference. These values are
// resolved server-side (console/api/src/config.js's resolvePorts()) and
// delivered once via GET /api/auth/state's `config.ports` field --
// browsers cannot read .env or process.env directly, so the backend is
// always the real source of truth; this module just caches what it
// already sent us instead of every component re-hardcoding stock
// (Instance 1) values. See issue #266 for the audit that found 5
// frontend files hardcoding these instead of reading them from here.
//
// Stock (Instance 1) values below are ONLY the fallback used before the
// first successful /api/auth/state response of this page load (or if a
// future response is ever missing the field) -- they must stay in sync
// with config.js's resolvePorts() defaults, not be treated as this
// module's own independent source of truth.
//
// CALLER CONTRACT (read before adding a new consumer): getServerPorts()/
// getAdminPort() are read imperatively, not via a React hook/context --
// a component that calls them gets whatever is cached AT THAT MOMENT,
// and will NOT automatically re-render if setServerPorts()/setAdminPort()
// is called again later. Today this is safe because every consumer
// (PortChecklist, ReadinessTimeline, SetupWizard) only renders after
// App.tsx's auth/setup-loaded gate has already resolved the same
// /api/auth/state promise that populates this cache -- see
// App.tsx's top-level useEffect. That ordering is a real invariant this
// module depends on, not enforced by the type system: if a future
// change ever renders one of these components before that gate (e.g. a
// pre-auth status widget), it will silently show stock defaults with no
// error. If you add a consumer that needs live updates after mount
// (e.g. if /api/auth/state is ever re-fetched later in the session),
// convert this to a React context/hook instead of extending the
// imperative-read pattern further.
export interface ServerPorts {
  postgres: number;
  rmqAdmin: number;
  rmqGame: number;
  rmqGameHttp: number;
  rmqGameLocalHttp: number;
  textRouter: number;
  director: number;
  metricsPrometheus: number;
  clientBase: number;
  clientBaseSecondary: number;
  igwBase: number;
  igwBaseSecondary: number;
}

const STOCK_DEFAULTS: ServerPorts = {
  postgres: 15432,
  rmqAdmin: 32573,
  rmqGame: 31982,
  rmqGameHttp: 31983,
  rmqGameLocalHttp: 15672,
  textRouter: 5059,
  director: 11717,
  metricsPrometheus: 9090,
  clientBase: 7777,
  clientBaseSecondary: 7778,
  igwBase: 7888,
  igwBaseSecondary: 7889
};

// Admin Web port is a separate top-level field on the server's config
// object (config.port, not config.ports.*) since it's the port this
// page is itself being served on, not part of the game-stack port
// table -- kept here anyway so every consumer has exactly one place to
// read any server-resolved port from, matching this module's purpose.
const STOCK_ADMIN_PORT_DEFAULT = 8088;
let cachedAdminPort: number = STOCK_ADMIN_PORT_DEFAULT;

export function setAdminPort(port: number | undefined | null) {
  if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) {
    cachedAdminPort = port;
  }
}

export function getAdminPort(): number {
  return cachedAdminPort;
}

let cached: ServerPorts = STOCK_DEFAULTS;

/** Called once per /api/auth/state response (see App.tsx) with whatever
 * the server actually sent -- partial/missing fields fall back to the
 * last-known-good value (or the stock default on first load), so a
 * server response that's missing `ports` entirely (e.g. an older server
 * build during a rolling upgrade) never wipes out already-cached real
 * values with stock ones. */
export function setServerPorts(ports: Partial<ServerPorts> | undefined | null) {
  if (!ports) return;
  cached = { ...cached, ...ports };
}

export function getServerPorts(): ServerPorts {
  return cached;
}

/** Test-only escape hatch to reset to stock defaults between test cases. */
export function resetServerPortsForTests() {
  cached = STOCK_DEFAULTS;
}
