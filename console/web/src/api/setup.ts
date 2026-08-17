import { api, post } from "./client";

export type Check = { name: string; status: "pass" | "warn" | "fail" | "info"; message: string; detail?: string };
export type Task = {
  id: string;
  type: string;
  operation: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  currentStep: string;
  progressMessage: string;
  logLines: { timestamp: string; stream: string; line: string }[];
  warnings: string[];
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
};

export type MultiServerProfile = {
  instance: number;
  client: number;
  client_end: number;
  igw: number;
  igw_end: number;
  postgres: number;
  rmq_admin: number;
  rmq_game: number;
  rmq_game_http: number;
  rmq_game_local_http: number;
  text_router: number;
  director: number;
  admin_web: number;
  prometheus: number;
};
export type MultiServerPlan = { stride: number; profiles: MultiServerProfile[] };

export const setupApi = {
  state: () => api<{ files: Record<string, boolean>; config: Record<string, unknown>; serverConfig?: Record<string, unknown> }>("/api/setup/state"),
  preflight: () => post<{ checks: Check[]; summary: Record<string, number> }>("/api/setup/preflight"),
  writeConfig: (body: Record<string, string>) => post<{ ok: boolean }>("/api/setup/write-config", body),
  writeOAuthConfig: (body: Record<string, string>) => post<{ ok: boolean; changes: string[] }>("/api/setup/write-oauth-config", body),
  saveOAuthSecret: (secret: string) => post<{ ok: boolean }>("/api/setup/save-oauth-secret", { secret }),
  saveToken: (token: string) => post<{ ok: boolean }>("/api/setup/save-token", { token }),
  init: () => post<{ task: Task }>("/api/setup/init"),
  tasks: () => api<{ tasks: Task[] }>("/api/setup/tasks"),
  task: (id: string) => api<{ task: Task }>(`/api/setup/tasks/${id}`),
  // Read-only preview -- computes every instance's ports up to and
  // including the requested one, without touching .env or any generated
  // file. See issue #277 -- the operator must always see the real
  // numbers before committing to a multi-server apply.
  multiServerPlan: (instances: number) => post<{ ok: boolean; plan: MultiServerPlan }>("/api/setup/multi-server-plan", { instances }),
  // Real, disruptive apply: rewrites .env's 11 managed host ports and the
  // Player/Game and IGW base ports, then stops and restarts the entire
  // stack. Always confirm with the operator before calling this -- there
  // is no dry-run/undo from the frontend's side (multi-server-config.py
  // itself takes its own pre-change backup, but this call is a real,
  // committed change the moment the task starts). bindIp is NOT sent --
  // the server always computes it from its own network interfaces
  // (see server.js's multiServerApplyRoute), since the browser has no
  // way to know this host's LAN address.
  multiServerApply: (instance: number, publicIp: string) =>
    post<{ task: Task }>("/api/setup/multi-server-apply", { instance, publicIp })
};
