import { api } from "./client";

export type VehicleModule = {
  templateId: string;
  name: string;
  condition: number | string | null;
  // Null when the DB holds <2 samples of this template_id, so no max can be
  // inferred -- render the raw condition with no bar in that case.
  maxCondition: number | string | null;
  conditionPercent: number | null;
  maxInferred?: boolean | null;
};

export type VehicleSharedEntry = { name: string; rank: number; label: string };

export type VehicleRow = {
  id: string;
  name: string;
  type: string;
  owner: string;
  relationship?: string | null;
  shared_with: VehicleSharedEntry[];
  condition_percent: number | null;
  condition_estimated?: boolean | null;
  // Null when fuel capacity cannot be inferred (<2 samples of the generator
  // template) -- render a muted dash, not a 0% bar.
  current_fuel: number | string | null;
  max_fuel: number | string | null;
  fuel_percent: number | null;
  map: string;
  partition_id: number;
  x: number | string | null;
  y: number | string | null;
  z: number | string | null;
  // Nearest-marker sub-region name for maps with a region table (e.g. Hagga
  // Basin). Absent for maps without one, or when marker data is unavailable.
  region?: string | null;
  modules: VehicleModule[];
};

export type VehiclesListResponse = {
  rows: VehicleRow[];
  totalCount: number;
  totalVehicles: number;
  capabilities: { vehicles?: boolean } & Record<string, unknown>;
  reason?: string;
};

export const vehiclesApi = {
  list: (params: { q?: string; page?: number; pageSize?: number; sortColumn?: string; sortDirection?: "asc" | "desc" } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.page) search.set("page", String(params.page));
    if (params.pageSize) search.set("pageSize", String(params.pageSize));
    if (params.sortColumn) search.set("sortColumn", params.sortColumn);
    if (params.sortDirection) search.set("sortDirection", params.sortDirection);
    const qs = search.toString();
    return api<VehiclesListResponse>(`/api/vehicles${qs ? `?${qs}` : ""}`);
  },
  forPlayer: (playerId: string) => api<VehiclesListResponse>(`/api/players/${encodeURIComponent(playerId)}/vehicles`)
};
