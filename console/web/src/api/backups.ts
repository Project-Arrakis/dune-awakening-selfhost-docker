import { api, post } from "./client";
import type { Task } from "./setup";

export type BackupIdentityMode = "adopt-backup" | "keep-current";

export function backupIdentityDiffers(currentBattlegroupId: unknown, backupBattlegroupId: unknown) {
  const current = String(currentBattlegroupId || "Unknown");
  const backup = String(backupBattlegroupId || "Unknown");
  return current !== "Unknown" && backup !== "Unknown" && current !== backup;
}

export const backupsApi = {
  list: () => api<{ stdout: string; currentBattlegroupId?: string; rows?: Record<string, unknown>[] }>("/api/backups"),
  create: () => post<{ task: Task }>("/api/backups/create"),
  restore: (backup: string, identityMode: BackupIdentityMode) => post<{ task: Task }>("/api/backups/restore", { backup, identityMode }),
  delete: (backup: string) => api<{ task: Task }>(`/api/backups/${encodeURIComponent(backup)}`, { method: "DELETE" }),
  deleteAll: () => post<{ task: Task }>("/api/backups/delete-all"),
  downloadUrl: (backup: string) => `/api/backups/${encodeURIComponent(backup)}/download`,
  importExternal: (form: FormData) => api<{ ok: boolean; row?: Record<string, unknown>; rows?: Record<string, unknown>[] }>("/api/backups/import-external", { method: "POST", body: form }),
  autoStatus: () => api<{ stdout: string; stderr?: string; exitCode?: number; status?: Record<string, unknown> }>("/api/backups/auto"),
  saveAuto: (body: { enabled: boolean; time: string; retentionDays: number; intervalHours: number }) => post<{ task: Task }>("/api/backups/auto", body)
};
