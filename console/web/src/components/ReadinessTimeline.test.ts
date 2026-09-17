import { describe, expect, it } from "vitest";
import { buildReadinessGroups } from "./ReadinessTimeline";

describe("buildReadinessGroups", () => {
  it("shows the real RabbitMQ readiness result instead of the delegated status placeholder", () => {
    const readiness = `=== RabbitMQ game users ===
OK   game server sg.* RMQ connections`;
    const status = `=== RabbitMQ game connections ===
RabbitMQ connection details: Checked by readiness`;

    expect(buildReadinessGroups(readiness, status)["RabbitMQ Game Connections"]).toEqual([
      {
        name: "game server sg.* RMQ connections",
        detail: "",
        status: "Ready",
        kind: "pass"
      }
    ]);
  });
});
