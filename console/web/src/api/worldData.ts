import { api, post } from "./client";

// The item is a catalog id chosen from the list, or typed text the server resolves.
type StorageItemRequest = ({ itemId: string } | { itemName: string }) & { quantity: number; confirmation: string };

export const worldDataApi = {
  storage: () => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>("/api/storage"),
  storageItems: (id: string) => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/storage/${encodeURIComponent(id)}/items`),
  storageGiveItem: (id: string, body: StorageItemRequest) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/storage/${encodeURIComponent(id)}/give-item`, body),
  storageFillItem: (id: string, body: StorageItemRequest) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/storage/${encodeURIComponent(id)}/fill-item`, body),
  storageExportUrl: (id: string) => `/api/storage/${encodeURIComponent(id)}/export`
};
