import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { liveMapApi } from "../../api/liveMap";
import { LiveMapPanel } from "./LiveMapPanel";

vi.mock("../../api/liveMap", () => ({
  liveMapApi: {
    markers: vi.fn(),
    teleportPlayer: vi.fn()
  }
}));

const map = {
  key: "HaggaBasin",
  label: "Hagga Basin",
  actorMap: "HaggaBasin",
  image: "",
  width: 1000,
  height: 1000,
  minX: 0,
  maxX: 1000,
  minY: 0,
  maxY: 1000,
  flipY: false,
  defaultPartitionId: 1
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(liveMapApi.markers).mockResolvedValue({
    rows: [{ id: 31573, type: "base", name: "Desert Home", base_type: "Sub-Fief", owner_name: "Chani", map: "HaggaBasin", partition_id: 1, x: 500, y: 500, z: 20 }],
    overlays: {},
    capabilities: { bases: true },
    map,
    maps: { HaggaBasin: map },
    defaultMap: "HaggaBasin",
    partitions: [{ map: "HaggaBasin", partition_id: 1, name: "Sietch New", marker_count: 1 }]
  });
});

it("shows a base owner and opens that exact base from the marker drawer", async () => {
  const onOpenBase = vi.fn();
  render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={onOpenBase}
  />);

  fireEvent.click(await screen.findByTitle("Base: Desert Home"));
  expect(screen.getByText("Sub-Fief")).toBeInTheDocument();
  expect(screen.getByText("Owner")).toBeInTheDocument();
  expect(screen.getByText("Chani")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open in Bases" }));
  await waitFor(() => expect(onOpenBase).toHaveBeenCalledWith("31573"));
});
