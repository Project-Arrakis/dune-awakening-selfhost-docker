import { api } from "./client";

export const basesApi = {
  list: (q = "") => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/bases${q ? `?q=${encodeURIComponent(q)}` : ""}`)
};
