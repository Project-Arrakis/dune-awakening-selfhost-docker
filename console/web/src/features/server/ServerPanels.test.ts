import { describe, expect, it } from "vitest";
import { containerStatusLineHas, isHomeStopComplete } from "./ServerPanels";

// Keep the shared parser tolerant of docker ps-style column padding while
// requiring an exact container-name match.
describe("containerStatusLineHas", () => {
  it("matches a start-anchored status pattern across multiple spaces of padding", () => {
    expect(containerStatusLineHas("dune-postgres", "dune-postgres   Up 5 minutes", /^Up\b/i)).toBe(true);
  });

  it("matches a start-anchored status pattern with only a single space", () => {
    expect(containerStatusLineHas("dune-postgres", "dune-postgres Up 5 minutes", /^Up\b/i)).toBe(true);
  });

  it("does not match a different container name", () => {
    expect(containerStatusLineHas("dune-postgres", "dune-postgres-backup   Up 5 minutes", /^Up\b/i)).toBe(false);
  });

  it("still matches a mid-string status pattern (e.g. missing/stopped) regardless of padding", () => {
    expect(containerStatusLineHas("dune-rmq-game", "dune-rmq-game     stopped", /\b(missing|stopped|exited|dead|not running)\b/i)).toBe(true);
  });
});

describe("isHomeStopComplete", () => {
  const requiredContainers = [
    "dune-postgres",
    "dune-rmq-admin",
    "dune-rmq-game",
    "dune-text-router",
    "dune-director",
    "dune-server-gateway",
    "dune-server-survival-1",
    "dune-server-overmap"
  ];

  it("recognizes stopped containers even when status output pads names with multiple spaces", () => {
    const lines = requiredContainers.map((name) => `${name}     stopped`);
    const status = ["=== Containers ===", "SERVICE   STATUS", ...lines, "=== Listeners ==="].join("\n");
    expect(isHomeStopComplete(status, "")).toBe(true);
  });

  it("does not report stop-complete for a running container list", () => {
    const lines = requiredContainers.map((name) => `${name} Up 5 minutes`);
    const status = ["=== Containers ===", "SERVICE STATUS", ...lines, "=== Listeners ==="].join("\n");
    expect(isHomeStopComplete(status, "")).toBe(false);
  });
});
