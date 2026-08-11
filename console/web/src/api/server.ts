import { api, post } from "./client";
import type { Task } from "./setup";

export type PerformanceSnapshot = {
  cpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number; availableBytes: number; percent: number | null };
  disk: { usedBytes: number; totalBytes: number; freeBytes: number; percent: number | null };
  uptimeSeconds: number;
  uptime: string;
  sampledAt: string;
};

export type RestartQueueSettings = {
  enabled: boolean;
  defaultCountdownMinutes: number;
  broadcastCheckpoints: number[];
  broadcastDurationSec: number;
  recoveryGraceMinutes: number;
};

export type RestartQueueEntry = {
  id: string;
  status: "counting" | "restarting";
  target: "battlegroup" | "map";
  mapLabel: string;
  requestedBy: string;
  startedAt: string;
  restartAt: number;
  countdownMinutes: number;
  remainingSeconds: number;
  sentCheckpoints: number[];
};

export type RestartQueueState = { entries: RestartQueueEntry[] };

export type RestartQueueResponse = {
  settings: RestartQueueSettings;
  defaults: RestartQueueSettings;
  state: RestartQueueState;
  playersOnline: number | null;
  playersOnlineSupported: boolean;
};

export type SaveRestartQueueBody = {
  enabled: boolean;
  defaultCountdownMinutes: number;
  broadcastCheckpoints: number[] | string;
  broadcastDurationSec?: number;
  recoveryGraceMinutes?: number;
};

// A gated restart endpoint returns the normal { task } when it runs, or
// { queued: true, ... } when the Restart Queue captured it into a countdown.
export type RestartDispatchResponse = {
  task?: Task;
  queued?: boolean;
  online?: number;
  entryId?: string;
  state?: RestartQueueState;
};

function immediateQuery(immediate?: boolean) {
  return immediate ? "?restartQueue=immediate" : "";
}

export const serverApi = {
  status: () => api<{ stdout: string }>("/api/server/status"),
  performance: () => api<PerformanceSnapshot>("/api/server/performance"),
  readiness: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/server/readiness"),
  ports: () => api<{ stdout: string }>("/api/server/ports"),
  services: () => api<{ stdout: string }>("/api/server/services"),
  doctor: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/server/doctor"),
  fixNetworkBinding: () => post<{ task: Task }>("/api/server/network-bind/fix"),
  cleanupDockerImages: () => post<{ task: Task }>("/api/server/storage/cleanup-images", { confirmation: "CLEAN OBSOLETE DUNE IMAGES" }),
  cleanupDockerBuildCache: () => post<{ task: Task }>("/api/server/storage/cleanup-build-cache", { confirmation: "CLEAN DOCKER BUILD CACHE" }),
  start: () => post<{ task: Task }>("/api/server/start"),
  stop: () => post<{ task: Task }>("/api/server/stop"),
  restart: (opts?: { immediate?: boolean }) => post<RestartDispatchResponse>(`/api/server/restart${immediateQuery(opts?.immediate)}`),
  restartService: (service: string, opts?: { immediate?: boolean }) => post<RestartDispatchResponse>(`/api/server/restart-service${immediateQuery(opts?.immediate)}`, { service }),
  saveConfig: (body: { title?: string; mode?: "public" | "local" }) => post<{ task: Task }>("/api/server/config", body),
  saveFuncomToken: (token: string) => post<{ task: Task }>("/api/server/funcom-token", { token }),
  checkFuncomToken: (since: string) => api<{ ok: boolean; mismatch: boolean; checkedSince: string; details?: string }>(`/api/server/funcom-token/check?since=${encodeURIComponent(since)}`),
  restartSchedule: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/server/restart-schedule"),
  saveRestartSchedule: (body: { enabled: boolean; time: string; notifyMinutes?: number }) => post<{ task: Task }>("/api/server/restart-schedule", body),
  restartQueue: () => api<RestartQueueResponse>("/api/server/restart-queue"),
  saveRestartQueue: (body: SaveRestartQueueBody) => post<{ ok: boolean; settings: RestartQueueSettings; defaults: RestartQueueSettings; state: RestartQueueState }>("/api/server/restart-queue", body),
  cancelRestartQueue: (body: { id: string }) => post<{ ok: boolean; state: RestartQueueState }>("/api/server/restart-queue/cancel", body),
  restartQueueRestartNow: (body: { id: string }) => post<{ ok: boolean; state: RestartQueueState }>("/api/server/restart-queue/restart-now", body),
  ipChangeRestart: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/server/ip-change-restart"),
  saveIpChangeRestart: (body: { enabled: boolean; intervalMinutes?: number; notifyMinutes?: number }) => post<{ task: Task }>("/api/server/ip-change-restart", body),
  checkIpChangeRestartNow: () => post<{ task: Task }>("/api/server/ip-change-restart/check"),
  shutdownProtection: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/server/shutdown-protection"),
  saveShutdownProtection: (body: { enabled: boolean }) => post<{ task: Task }>("/api/server/shutdown-protection", body),
  removeShutdownProtection: () => post<{ task: Task }>("/api/server/shutdown-protection/remove")
};
