import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApi, type ScheduledMapMessage } from "../../api/admin";
import { ScheduledMapMessages } from "./ScheduledMapMessages";

vi.mock("../../api/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/admin")>();
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      mapChatSchedules: vi.fn(),
      saveMapChatSchedule: vi.fn(),
      deleteMapChatSchedule: vi.fn(),
      runMapChatSchedule: vi.fn()
    }
  };
});

const mapOptions = [{ key: "HaggaBasin|0", label: "HaggaBasin (Sietch New)", chatRegion: "HaggaBasin", dimension: 0 }];

function savedSchedule(): ScheduledMapMessage {
  return {
    id: "schedule-1234",
    name: "Morning Report",
    enabled: true,
    mapName: "HaggaBasin",
    dimension: 0,
    message: "Dawn over Hagga Basin.",
    frequency: "daily",
    daysOfWeek: [],
    time: "09:00",
    timezone: "UTC",
    nextRunAt: "2026-08-24T09:00:00.000Z",
    createdAt: "2026-08-23T08:00:00.000Z",
    updatedAt: "2026-08-23T08:00:00.000Z",
    lastAttemptAt: "",
    lastDeliveredAt: "",
    lastStatus: "never",
    lastError: "",
    lastRecipients: 0
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminApi.mapChatSchedules).mockResolvedValue({ version: 1, schedules: [] });
});

describe("ScheduledMapMessages", () => {
  it("creates a schedule from the clean empty state", async () => {
    const schedule = savedSchedule();
    vi.mocked(adminApi.saveMapChatSchedule).mockResolvedValue({ ok: true, schedule, schedules: [schedule] });
    render(<ScheduledMapMessages mapOptions={mapOptions} confirmAction={vi.fn().mockResolvedValue(true)} onDelivery={vi.fn()} />);

    expect(await screen.findByText("No scheduled messages yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Schedule" }));
    fireEvent.change(screen.getByLabelText("Schedule Name"), { target: { value: "Morning Report" } });
    fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: "Dawn over Hagga Basin." } });
    fireEvent.click(screen.getByRole("button", { name: "Save Schedule" }));

    await waitFor(() => expect(adminApi.saveMapChatSchedule).toHaveBeenCalledWith(expect.objectContaining({ name: "Morning Report", message: "Dawn over Hagga Basin.", mapName: "HaggaBasin", dimension: 0 })));
    expect(await screen.findByText(/Daily at 09:00 · UTC/)).toBeInTheDocument();
  });

  it("shows weekday controls only for weekly schedules", async () => {
    render(<ScheduledMapMessages mapOptions={mapOptions} confirmAction={vi.fn().mockResolvedValue(true)} onDelivery={vi.fn()} />);
    await screen.findByText("No scheduled messages yet");
    fireEvent.click(screen.getByRole("button", { name: "Add Schedule" }));
    expect(screen.queryByText("Send On")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "weekly" } });
    expect(screen.getByText("Send On")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "true");
  });
});
