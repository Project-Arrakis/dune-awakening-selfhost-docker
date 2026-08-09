import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { basesApi, type BaseWater } from "../../api/bases";
import { BaseWaterTab, type BaseWaterAutoRefillProps } from "./BaseWaterTab";

vi.mock("../../api/bases", () => ({ basesApi: { water: vi.fn() } }));

const PAYLOAD: BaseWater = {
  supported: true,
  baseId: 1006,
  containers: [{ type: "waterCistern", name: "Water Cistern", count: 1, stored: 1250, capacity: 5000, percent: 25 }]
};

// Auto-refill is BasesPanel's state; the tab only renders what it is handed.
// Off here so these tests are about the load path and nothing else.
const AUTO_REFILL: BaseWaterAutoRefillProps = {
  supported: false,
  unavailable: false,
  enabled: false,
  saving: false,
  stalledAt: "",
  consecutiveQueues: 0,
  canToggle: false,
  tooltip: "",
  onToggle: () => {},
  onRetry: () => {}
};

// Hands back the resolve/reject of every call, so a test can settle them out of
// the order they were made.
function gatedWater() {
  const gates: Array<{ resolve: (value: BaseWater) => void; reject: (error: unknown) => void }> = [];
  vi.mocked(basesApi.water).mockImplementation(() => new Promise((resolve, reject) => {
    gates.push({ resolve, reject });
  }) as never);
  return gates;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BaseWaterTab", () => {
  // StrictMode double-invokes the load effect, so two requests are genuinely
  // open at once and whichever settles last writes state.
  it("ignores a stale response that settles after a newer one", async () => {
    const gates = gatedWater();
    render(<StrictMode><BaseWaterTab baseId="1006" autoRefill={AUTO_REFILL} /></StrictMode>);
    await waitFor(() => expect(gates.length).toBe(2));

    gates[1].resolve(PAYLOAD);
    expect(await screen.findByText("1,250 / 5,000")).toBeInTheDocument();

    // The older attempt failing afterwards must not replace the loaded levels.
    gates[0].reject(new Error("stale failure"));
    await waitFor(() => expect(screen.getByText("1,250 / 5,000")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(/stale failure/)).toBeNull();
  });

  // Unlike the Inventory tab, this one refetches on a mounted instance:
  // BasesPanel bumps refreshToken after an immediate refill. A refill that
  // lands while the first read is still open must not be overwritten by it.
  it("keeps the refreshed levels when the request it replaced settles late", async () => {
    const gates = gatedWater();
    const { rerender } = render(
      <BaseWaterTab baseId="1006" autoRefill={AUTO_REFILL} refreshToken={0} />);
    await waitFor(() => expect(gates.length).toBe(1));

    // Refill completes and bumps the token while the first read is still open.
    rerender(<BaseWaterTab baseId="1006" autoRefill={AUTO_REFILL} refreshToken={1} />);
    await waitFor(() => expect(gates.length).toBe(2));

    gates[1].resolve({
      ...PAYLOAD,
      containers: [{ type: "waterCistern", name: "Water Cistern", count: 1, stored: 5000, capacity: 5000, percent: 100 }]
    });
    expect(await screen.findByText("5,000 / 5,000")).toBeInTheDocument();

    // The pre-refill read arriving late would otherwise show the old level.
    gates[0].resolve(PAYLOAD);
    await waitFor(() => expect(screen.getByText("5,000 / 5,000")).toBeInTheDocument());
    expect(screen.queryByText("1,250 / 5,000")).toBeNull();
  });
});
