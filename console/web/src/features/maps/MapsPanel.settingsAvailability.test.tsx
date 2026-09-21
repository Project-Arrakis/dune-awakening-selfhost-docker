import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsApi } from "../../api/maps";
import { MapsPanel } from "./MapsPanel";

vi.mock("../../api/maps", () => ({
  mapsApi: new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => {
      if (!target[prop]) {
        target[prop] = vi.fn().mockResolvedValue({
          stdout: "",
          exitCode: 0,
          content: "",
          rows: [],
          placements: [],
          tradeCenters: [],
          partitions: [],
          fields: [],
          partition: [],
          partitionEngine: [],
          mapEngine: [],
          game: [],
          engine: [],
          capabilities: {},
          values: {},
          sampledAt: ""
        });
      }
      return target[prop];
    }
  })
}));

vi.mock("../../api/setup", () => ({
  setupApi: new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => {
      if (!target[prop]) target[prop] = vi.fn().mockResolvedValue({});
      return target[prop];
    }
  })
}));

vi.mock("../../lib/usePendingRefills", () => ({
  usePendingRefills: () => ({ pending: null, refresh: () => {} }),
  usePendingQueues: () => ({
    fuel: { pending: null, refresh: () => {} },
    water: { pending: null, refresh: () => {} },
    deletes: { pending: null, refresh: () => {} },
    vehicleDeletes: { pending: null, refresh: () => {} },
    permissions: { pending: null, refresh: () => {} }
  }),
  pendingRefillCountForMap: () => 0,
  pendingRefillCountForPartition: () => 0,
  vehicleDeleteCountForMap: () => 0,
  vehicleDeleteCountForPartition: () => 0,
  childAccessPieceCountForMap: () => 0,
  childAccessPieceCountForPartition: () => 0
}));

function renderMapsPanel() {
  render(<MapsPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    confirmSettingsRestart={vi.fn().mockResolvedValue("manual")}
    waitForTaskWithUpdates={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    restartGate={vi.fn().mockResolvedValue("immediate")}
  />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MapsPanel modifier availability", () => {
  it("keeps credits story maps dynamic and explains their fresh-process lifecycle", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockResolvedValue({
      maps: { stdout: JSON.stringify({ maps: [{ map: "CB_Story_OrbitalMonitor", status: "Ready", mode: "Dynamic", partitionId: "32" }] }) },
      services: { stdout: "" },
      readiness: { stdout: "" }
    });

    renderMapsPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    expect(screen.getByText(/completed instance is retired/i)).toBeVisible();
    expect(screen.getByLabelText("Mode")).toHaveValue("dynamic");
    expect(screen.queryByRole("option", { name: "Always On" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Overmap Active" })).not.toBeInTheDocument();
  });

  it("force despawns the whole map instead of only its first partition", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockResolvedValue({
      maps: { stdout: JSON.stringify({ maps: [{ map: "CB_Overland_S_08", status: "Ready", mode: "Dynamic", partitionId: "29" }] }) },
      services: { stdout: "" },
      readiness: { stdout: "" }
    });
    api.despawn.mockResolvedValue({ task: { id: "task-1", status: "succeeded" } });

    renderMapsPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Force Despawn" }));

    await waitFor(() => expect(api.despawn).toHaveBeenCalledWith("CB_Overland_S_08", "DESPAWN MAP"));
  });

  it("opens settings while the live map-status request is still pending", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockImplementation(() => new Promise(() => {}));
    api.userSettingsSchema.mockResolvedValue({
      engine: [{
        scope: "engine",
        id: "mining_output_multiplier",
        section: "ConsoleVariables",
        key: "Dune.GlobalMiningOutputMultiplier",
        default: "1.0",
        type: "number",
        clientFile: "",
        category: "Multipliers",
        description: "Mining output multiplier."
      }],
      mapEngine: [],
      partitionEngine: [],
      game: [],
      partition: []
    });
    api.userEngine.mockResolvedValue({ stdout: "mining_output_multiplier\t2.0\n", exitCode: 0 });
    api.rawUserSettings.mockImplementation(() => new Promise(() => {}));

    renderMapsPanel();

    expect(await screen.findByText("Loading Maps")).toBeInTheDocument();
    const modifiers = screen.getByRole("button", { name: "Expand Interactive Modifiers" });
    await waitFor(() => expect(modifiers).toBeEnabled());
    expect(api.rawUserSettings).not.toHaveBeenCalled();

    fireEvent.click(modifiers);

    expect(screen.getByRole("tab", { name: "UserEngine" })).toBeVisible();
    expect(screen.getByDisplayValue("2.0")).toBeVisible();
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it("edits native ServerCustomSettings values in the dedicated Custom Settings tab", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockResolvedValue({
      maps: { stdout: JSON.stringify({ maps: [{ map: "Overmap", status: "Ready", mode: "Core Map", partitionId: "2" }] }) },
      services: { stdout: "" },
      readiness: { stdout: "" }
    });
    api.userSettingsSchema.mockResolvedValue({
      engine: [], mapEngine: [], partitionEngine: [], game: [], partition: [],
      serverCustom: [{
        scope: "serverCustom", id: "pvp_mode", section: "/Script/DuneSandbox.UserServerCustomSettings",
        key: "PVPMode", default: "Limited", type: "text", options: ["NoPVP", "Limited", "FullPVP"], clientFile: "", category: "Combat", description: ""
      }, {
        scope: "serverCustom", id: "gathering_amount", section: "/Script/DuneSandbox.UserServerCustomSettings",
        key: "GatheringAmount", default: "1.000000", type: "number", minimum: 0.1, maximum: 10, clientFile: "", category: "Crafting And Resources", description: ""
      }]
    });
    api.userSettingsValues.mockResolvedValue({ stdout: "pvp_mode\tLimited\ngathering_amount\t2.000000\n" });

    renderMapsPanel();
    const modifiers = await screen.findByRole("button", { name: "Expand Interactive Modifiers" });
    await waitFor(() => expect(modifiers).toBeEnabled());
    fireEvent.click(modifiers);
    fireEvent.click(screen.getByRole("tab", { name: "Custom Settings" }));
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "Overmap::2" } });

    expect(await screen.findByDisplayValue("2.000000")).toBeVisible();
    expect(api.userSettingsValues).toHaveBeenCalledWith("serverCustomPartition", "Overmap", "2");
    expect(screen.getByText("ServerCustomSettings.ini", { exact: false })).toBeVisible();

    const pvpMode = screen.getByDisplayValue("Limited");
    expect(pvpMode.tagName).toBe("SELECT");
    expect(pvpMode).toHaveTextContent("NoPVP");
    expect(pvpMode).toHaveTextContent("FullPVP");

    const gatheringAmount = screen.getByDisplayValue("2.000000");
    expect(gatheringAmount).toHaveAttribute("min", "0.1");
    expect(gatheringAmount).toHaveAttribute("max", "10");
    expect(screen.getByText("Allowed: 0.1–10")).toBeVisible();
    fireEvent.change(gatheringAmount, { target: { value: "10.1" } });
    expect(screen.getByText(/supported value within the displayed range/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(gatheringAmount, { target: { value: "10" } });
    expect(screen.queryByText(/supported value within the displayed range/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
