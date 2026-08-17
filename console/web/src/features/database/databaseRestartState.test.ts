import { beforeEach, describe, expect, it } from "vitest";
import { loadDatabaseRestartTaskId, persistDatabaseRestartTaskId } from "./databaseRestartState";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("database restart browser state", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("persists only an opaque task id in session storage", () => {
    persistDatabaseRestartTaskId(TASK_ID);

    expect(loadDatabaseRestartTaskId()).toBe(TASK_ID);
    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.getItem("arrakis.databaseRestartTaskId")).toBe(TASK_ID);
    expect(window.localStorage.length).toBe(0);
  });

  it("removes legacy result data and rejects invalid task ids", () => {
    window.localStorage.setItem("arrakis.databasePasswordState", JSON.stringify({
      result: { status: "failed", message: "sensitive diagnostic" }
    }));
    window.sessionStorage.setItem("arrakis.databaseRestartTaskId", "not-a-task-id");

    expect(loadDatabaseRestartTaskId()).toBeUndefined();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("clears the task id after the restart finishes", () => {
    persistDatabaseRestartTaskId(TASK_ID);
    persistDatabaseRestartTaskId();

    expect(loadDatabaseRestartTaskId()).toBeUndefined();
  });
});
