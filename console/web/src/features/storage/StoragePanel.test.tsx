import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { serverApi } from "../../api/server";
import { type Task } from "../../api/setup";
import { worldDataApi } from "../../api/worldData";
import { StoragePanel } from "./StoragePanel";

vi.mock("../../api/server", () => ({
  serverApi: {
    restartService: vi.fn()
  }
}));

vi.mock("../../api/worldData", () => ({
  worldDataApi: {
    storage: vi.fn(),
    storageItems: vi.fn(),
    storageGiveItem: vi.fn(),
    storageFillItem: vi.fn()
  }
}));

const mockConfirmAction = vi.fn();
const mockOnError = vi.fn();

function taskFixture(status: Task["status"]): Task {
  return {
    id: "task-1",
    type: "server",
    operation: "restartService",
    status,
    currentStep: "",
    progressMessage: "",
    logLines: [],
    startedAt: "2026-07-31T00:00:00Z",
    finishedAt: null,
    errorMessage: status === "failed" ? "bind failed" : null,
    warnings: [],
  };
}

const defaultProps = {
  onError: mockOnError,
  confirmAction: mockConfirmAction,
  formatMutationResult: (result: unknown) => String(result),
  waitForTask: async (task: { status: string }) => task as never
};

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirmAction.mockResolvedValue(true);
  vi.mocked(worldDataApi.storage).mockResolvedValue({
    rows: [{ id: 105, actor_name: "Dev-1" }],
    capabilities: { storageGiveItem: true, storageFillItem: true }
  });
  vi.mocked(worldDataApi.storageItems).mockResolvedValue({ rows: [], capabilities: {} });
});

describe("StoragePanel", () => {
  it("renders the apply-restart action with a visibility note", async () => {
    render(<StoragePanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Apply Fills (Restart Survival)")).toBeInTheDocument();
    });
    expect(screen.getByText(/Fills become visible in-game after the Survival server restarts/i)).toBeInTheDocument();
  });

  it("restarts the survival service after confirmation and reports success", async () => {
    vi.mocked(serverApi.restartService).mockResolvedValue({
      task: taskFixture("running")
    });
    const waitForTask = vi.fn().mockResolvedValue(taskFixture("succeeded"));
    render(<StoragePanel {...defaultProps} waitForTask={waitForTask} />);
    await waitFor(() => {
      expect(screen.getByText("Apply Fills (Restart Survival)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Apply Fills (Restart Survival)"));
    await waitFor(() => {
      expect(serverApi.restartService).toHaveBeenCalledWith("survival");
      expect(waitForTask).toHaveBeenCalledWith(taskFixture("running"));
      expect(screen.getByText("Restart completed. Container fills are now visible in-game.")).toBeInTheDocument();
    });
  });

  it("uses a danger confirmation dialog that mentions player disconnect", async () => {
    vi.mocked(serverApi.restartService).mockResolvedValue({
      task: taskFixture("running")
    });
    const waitForTask = vi.fn().mockResolvedValue(taskFixture("succeeded"));
    render(<StoragePanel {...defaultProps} waitForTask={waitForTask} />);
    await waitFor(() => {
      expect(screen.getByText("Apply Fills (Restart Survival)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Apply Fills (Restart Survival)"));
    await waitFor(() => {
      expect(mockConfirmAction).toHaveBeenCalledWith(
        expect.stringMatching(/All connected players will be disconnected/i),
        expect.objectContaining({ danger: true, confirmLabel: "Restart Survival" })
      );
    });
  });

  it("does not restart when confirmation is cancelled", async () => {
    mockConfirmAction.mockResolvedValue(false);
    render(<StoragePanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Apply Fills (Restart Survival)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Apply Fills (Restart Survival)"));
    await waitFor(() => {
      expect(serverApi.restartService).not.toHaveBeenCalled();
    });
  });

  it("reports a failed restart task", async () => {
    vi.mocked(serverApi.restartService).mockResolvedValue({
      task: taskFixture("running")
    });
    const waitForTask = vi.fn().mockResolvedValue(taskFixture("failed"));
    render(<StoragePanel {...defaultProps} waitForTask={waitForTask} />);
    await waitFor(() => {
      expect(screen.getByText("Apply Fills (Restart Survival)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Apply Fills (Restart Survival)"));
    await waitFor(() => {
      expect(screen.getByText(/Restart failed: bind failed/i)).toBeInTheDocument();
    });
  });

  it("does not claim success when the task is still running after the poll cap", async () => {
    vi.mocked(serverApi.restartService).mockResolvedValue({
      task: taskFixture("running")
    });
    const waitForTask = vi.fn().mockResolvedValue(taskFixture("running"));
    render(<StoragePanel {...defaultProps} waitForTask={waitForTask} />);
    await waitFor(() => {
      expect(screen.getByText("Apply Fills (Restart Survival)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Apply Fills (Restart Survival)"));
    await waitFor(() => {
      expect(screen.getByText(/Restart is still running/i)).toBeInTheDocument();
    });
  });
});
