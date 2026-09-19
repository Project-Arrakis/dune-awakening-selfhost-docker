import { describe, expect, it } from "vitest";
import type { Task } from "../../api/setup";
import { gameUpdateTerminalStatus, isDetachedStackUpdateTask, isUpdatedConsoleReady, summarizeStackUpdateProgress } from "./UpdatesPanel";
import { parseUpdateTask } from "./updateUtils";

function detachedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    type: "updates",
    operation: "selfUpdateApply",
    status: "running",
    currentStep: "Update helper running",
    progressMessage: "Update helper is running.",
    logLines: [{ timestamp: "2026-08-18T07:00:00Z", stream: "stdout", line: "Update helper started: helper-id" }],
    warnings: [],
    startedAt: "2026-08-18T07:00:00Z",
    finishedAt: null,
    errorMessage: null,
    ...overrides
  };
}

describe("detached console update progress", () => {
  it("recognizes a running handoff without falsely marking the API task succeeded", () => {
    const task = detachedTask();
    expect(isDetachedStackUpdateTask(task)).toBe(true);
    expect(task.status).toBe("running");
  });

  it("uses durable helper stages instead of time-simulated progress", () => {
    const summary = summarizeStackUpdateProgress(detachedTask(), {
      runId: "123e4567-e89b-42d3-a456-426614174000",
      state: "running",
      stage: "building",
      percent: 82,
      message: "Building the updated web console."
    });
    expect(summary).toEqual({
      title: "Building Web Console",
      percent: 82,
      message: "Building the updated web console."
    });
  });

  it("shows a durable helper failure and enables a truthful terminal result", () => {
    const task = detachedTask({ status: "failed", errorMessage: "Console build timed out.", finishedAt: "2026-08-18T07:30:00Z" });
    const summary = summarizeStackUpdateProgress(task, {
      runId: task.id,
      state: "failed",
      stage: "failed",
      percent: 100,
      message: "Console build timed out."
    });
    expect(summary.title).toBe("Console Update Failed");
    expect(summary.message).toBe("Console build timed out.");
  });

  it("clears a stale completed task after the replacement Console answers", () => {
    expect(isUpdatedConsoleReady({
      runId: "123e4567-e89b-42d3-a456-426614174000",
      state: "succeeded",
      stage: "complete",
      percent: 100,
      message: "Update complete.",
      consoleReplaced: true
    }, "v1.3.97", "v1.3.98")).toBe(true);
  });

  it("keeps waiting when the old Console still answers with the wrong version", () => {
    expect(isUpdatedConsoleReady({
      runId: "123e4567-e89b-42d3-a456-426614174000",
      state: "succeeded",
      stage: "complete",
      percent: 100,
      message: "Update complete.",
      consoleReplaced: false
    }, "v1.3.97", "v1.3.98")).toBe(false);
  });
});

describe("game update terminal status", () => {
  it("replaces the raw update-check exit code with helpful retry guidance", () => {
    const task = detachedTask({
      operation: "updateCheck",
      status: "failed",
      errorMessage: "dune update check failed with exit 2",
      logLines: [{ timestamp: "2026-09-19T14:30:00Z", stream: "stderr", line: "SteamCMD metadata check timed out after 45s." }]
    });

    expect(parseUpdateTask(task)).toMatchObject({
      status: "Check Failed",
      reason: "Steam did not finish the game update check in time. Try again in a few minutes. No game files were changed."
    });
  });

  it("replaces a stale Updating badge with the task failure", () => {
    const task = detachedTask({
      operation: "updateApply",
      status: "failed",
      currentStep: "Failed",
      progressMessage: "Database update exited with status 1.",
      errorMessage: "Database update exited with status 1."
    });

    expect(gameUpdateTerminalStatus(task, { status: "Updating", current: "24653560", latest: "25351779" })).toEqual({
      status: "Update Failed",
      current: "24653560",
      latest: "25351779",
      reason: "Database update exited with status 1."
    });
  });
});
