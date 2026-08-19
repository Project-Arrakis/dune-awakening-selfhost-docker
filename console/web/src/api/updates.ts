import { api, post } from "./client";
import type { Task } from "./setup";

export type StackUpdateProgress = {
  runId: string;
  state: "pending" | "running" | "succeeded" | "failed";
  stage: string;
  percent: number;
  message: string;
  startedAt?: string | null;
  updatedAt?: string | null;
  finishedAt?: string | null;
};

export const updatesApi = {
  checkGame: (options: { fresh?: boolean } = {}) => post<{ task: Task }>("/api/updates/check-game", options.fresh ? { fresh: true } : {}),
  applyGame: () => post<{ task: Task }>("/api/updates/apply-game"),
  fixSteamcmd: () => post<{ task: Task }>("/api/updates/fix-steamcmd"),
  checkStack: () => post<{ task: Task }>("/api/updates/check-stack"),
  applyStack: () => post<{ task: Task }>("/api/updates/apply-stack"),
  stackProgress: (runId: string) => api<StackUpdateProgress>(`/api/updates/stack-progress?runId=${encodeURIComponent(runId)}`, { cache: "no-store" }),
  autoGameStatus: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/updates/auto-game"),
  saveAutoGame: (body: {
    enabled: boolean;
    intervalMinutes: number;
    applyEnabled: boolean;
    notifyEnabled: boolean;
    notifyMinutes: string;
    waitUntilEmpty: boolean;
    maxWaitMinutes: number;
    confirmation: string;
  }) => post<{ task: Task }>("/api/updates/auto-game", body)
};
