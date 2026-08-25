import { api, post } from "./client";
import type { Task } from "./setup";

export type LiveMapMarker = {
  id: number | string;
  // Every call site already treats this as an arbitrary string (String(marker.type))
  // rather than exhaustively matching the union below -- widened so a marker type
  // introduced later (see issue #462) type-checks without a further change here.
  type: string;
  name?: string;
  map?: string;
  partition_id?: number;
  x?: number;
  y?: number;
  z?: number;
  [key: string]: unknown;
};

export type LiveMapConfig = {
  key: string;
  label: string;
  actorMap: string;
  image: string;
  width: number;
  height: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  flipY: boolean;
  defaultPartitionId: number | string;
};

export type LiveMapPartition = {
  map: string;
  partition_id: number;
  name: string;
  marker_count: number;
};

export const liveMapApi = {
  capabilities: () => api<Record<string, unknown>>("/api/map/capabilities"),
  markers: (map = "") => api<{ rows: LiveMapMarker[]; overlays: Record<string, string>; capabilities: Record<string, unknown>; map: LiveMapConfig; maps: Record<string, LiveMapConfig>; defaultMap: string; partitions: LiveMapPartition[] }>(`/api/map/markers${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  teleportPlayer: (body: { playerId: string; x: number; y: number; z: number; yaw?: number; partitionId?: number; online?: boolean }) => post<{ ok?: boolean; task?: Task; message?: string; path?: "live" | "offline"; supported?: boolean; reason?: string }>("/api/map/teleport-player", body),
  partitions: () => api<{ rows: LiveMapPartition[] }>("/api/map/partitions"),
  players: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/players${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  bases: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/bases${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  storage: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/storage${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  services: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/services${map ? `?map=${encodeURIComponent(map)}` : ""}`)
};
