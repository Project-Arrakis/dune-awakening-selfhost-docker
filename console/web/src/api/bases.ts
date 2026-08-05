import { api, post } from "./client";

export type RefillDeviceResult = {
  placeableId: string;
  type: string;
  label: string;
  fuelName: string;
  before: number;
  after: number;
  added: number;
  capped?: boolean;
  skipped?: string;
};

export type QueuedRefill = {
  baseId: number;
  map: string;
  partitionId: number;
  queuedAt: string;
  attempts: number;
  lastError: string;
};

export type PendingRefills = {
  supported: boolean;
  total: number;
  pending: QueuedRefill[];
  byTarget: { map: string; partitionId: number; partitionMap: string; dimensionIndex: number; count: number }[];
};

export type AutoRefillBase = {
  baseId: number;
  enabledAt: string;
  lastCheckedAt: string;
  lastQueuedAt: string;
  // null when the base has no recognised generators, which is not the same as 0.
  lastLowestPercent: number | null;
  // Completed queue cycles that never brought the fuel back up. At the cap the
  // scan stops queueing this base and stamps stalledAt.
  consecutiveQueues: number;
  stalledAt: string;
};

export type AutoRefillState = {
  supported: boolean;
  thresholdPercent: number;
  intervalHours: number;
  nextRunAt: string;
  lastRunAt: string;
  lastRunStatus: string;
  lastRunDetail: string;
  total: number;
  bases: AutoRefillBase[];
};

// rank 1/2/3 = Owner/Co-Owner/Associate, confirmed in both directions against a
// live server: the game's own Permissions panel writes exactly these values.
// The 5/4/3 badges the game UI shows beside those labels are decoration, not
// ranks -- no row in permission_actor_rank ever holds a 4 or 5.
export type BasePermissionRank = 1 | 2 | 3;

export type BasePermissionEntry = {
  playerId: string;
  name: string;
  rank: BasePermissionRank;
  label: string;
  // False when this row names an actor that is not the account's
  // player_controller_id. The game ignores such rows, but they are shown rather
  // than hidden -- it is a state the console can see and the game client cannot.
  canonical: boolean;
};

export type BasePermissions = {
  supported: boolean;
  baseId: number;
  actorId: string;
  map: string;
  mapNameId: number;
  entries: BasePermissionEntry[];
  reason?: string;
};

export type BasePermissionCandidate = { playerId: string; name: string };

export type SetBasePermissionsResult = {
  ok: boolean;
  baseId: number;
  actorId: string;
  map: string;
  added: number;
  reranked: number;
  removed: number;
  total: number;
  message: string;
};

export const basesApi = {
  list: (params: { q?: string; page?: number; pageSize?: number; sortColumn?: string; sortDirection?: "asc" | "desc" } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.page) search.set("page", String(params.page));
    if (params.pageSize) search.set("pageSize", String(params.pageSize));
    if (params.sortColumn) search.set("sortColumn", params.sortColumn);
    if (params.sortDirection) search.set("sortDirection", params.sortDirection);
    const qs = search.toString();
    return api<{ rows: Record<string, unknown>[]; totalCount: number; totalBases: number; totalPieces: number; totalPlaceables: number; capabilities: Record<string, unknown>; reason?: string }>(`/api/bases${qs ? `?${qs}` : ""}`);
  },
  // A refill for a map that is currently running comes back as
  // `result.queued`: the write is deferred to the next time that map is down.
  refillGenerators: (baseId: string) =>
    post<{
      supported: boolean;
      result?: {
        ok: boolean;
        baseId: number;
        queued?: boolean;
        map?: string;
        partitionId?: number;
        totalAdded?: number;
        devices?: RefillDeviceResult[];
      };
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}/refill-generators`, {}),
  cancelQueuedRefill: (baseId: string) =>
    api<{ supported: boolean; result?: { ok: boolean; baseId: number; pending: number }; reason?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/queued-refill`, { method: "DELETE" }),
  pendingRefills: () => api<PendingRefills>("/api/bases/pending-refills"),
  autoRefill: () => api<AutoRefillState>("/api/bases/auto-refill"),
  setAutoRefill: (baseId: string, enabled: boolean) =>
    post<{ ok: boolean; baseId: number; enabled: boolean; total: number }>(
      `/api/bases/${encodeURIComponent(baseId)}/auto-refill`, { enabled }),
  permissions: (baseId: string) =>
    api<BasePermissions>(`/api/bases/${encodeURIComponent(baseId)}/permissions`),
  // A whole roster, not a delta: the server diffs it against current state and
  // applies the difference through the game's own stored procedures in one
  // transaction. Changes reach a running map immediately -- no restart.
  setPermissions: (baseId: string, entries: { playerId: string; rank: BasePermissionRank }[]) =>
    api<{ supported: boolean; result?: SetBasePermissionsResult; reason?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/permissions`,
      { method: "PUT", body: JSON.stringify({ entries }) }),
  permissionCandidates: (q: string, limit = 25) => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    search.set("limit", String(limit));
    return api<{ supported: boolean; rows: BasePermissionCandidate[]; reason?: string }>(
      `/api/bases/permission-candidates?${search.toString()}`);
  }
};
