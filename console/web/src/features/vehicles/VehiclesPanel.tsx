import { useCallback, useEffect, useRef, useState } from "react";
import { vehiclesApi, type VehicleRow, type VehicleStatusFilter } from "../../api/vehicles";
import { SegmentedControl, type SegmentOption } from "../../components/common/SegmentedControl";
import type { SortDirection } from "../../components/common/DataTable";
import { usePendingVehicleDeletes } from "../../lib/usePendingRefills";
import { VehicleTable } from "./VehicleTable";

type VehiclesPanelProps = {
  onError: (text: string) => void;
  // The permissions transfer-to-custodian confirmation reuses App.tsx's
  // confirmDialog, the same way BasesPanel does. formatMutationResult is
  // accepted for prop parity with the other panels but unused here.
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
  formatMutationResult: (result: unknown) => string;
  focusRequest?: { vehicleId: string; nonce: number };
};

const VEHICLES_AUTO_REFRESH_MS = 15 * 60_000; // 15 minutes — listVehicles is expensive
const VEHICLES_PAGE_SIZES = [25, 50, 100, 200] as const;
const VEHICLES_DEFAULT_PAGE_SIZE = 50;
const VEHICLES_DEFAULT_STATUS: VehicleStatusFilter = "owned";
// Short visible labels, with the full rule as the spoken name. "Owned" and
// "Unowned" both leave out vehicles the game has put away, which have their
// own two segments.
const VEHICLES_STATUS_OPTIONS: ReadonlyArray<SegmentOption<VehicleStatusFilter>> = [
  { value: "owned", label: "Owned", ariaLabel: "Owned: has an owner or is in transit, and is not stored for recovery or in vehicle backup" },
  { value: "recovery", label: "Stored for Recovery" },
  { value: "backup", label: "Vehicle Backup" },
  { value: "unowned", label: "Unowned", ariaLabel: "Unowned: no owner and is not in transit, stored for recovery or in vehicle backup" },
  { value: "all", label: "All", ariaLabel: "All vehicles" }
];

type VehiclesViewParams = { q: string; status: VehicleStatusFilter; page: number; pageSize: number; sortColumn: string; sortDirection: SortDirection };

type VehiclesCache = VehiclesViewParams & {
  rows: VehicleRow[];
  totalCount: number;
  totalVehicles: number;
  supported: boolean;
  canEditPermissions: boolean;
  canDeleteVehicle: boolean;
  canQueueDeleteVehicle: boolean;
  storageSupported: boolean;
  canDeleteStoredVehicle: boolean;
  reason: string;
  lastFetchedAt: number;
};

let vehiclesCache: VehiclesCache | null = null;

// The cache outlives a mount on purpose, which makes one test's last view the
// next test's first. Tests clear it so they do not depend on running order.
export function _resetVehiclesCacheForTests() {
  vehiclesCache = null;
  handledFocusNonce = undefined;
}

// The last deep-link request already applied. App.tsx never clears its
// focusRequest, and this panel unmounts whenever another tab is opened, so
// without this every return to the Vehicles tab re-applied the old deep link:
// search forced back to that vehicle's id and the status filter back to All,
// discarding whatever the admin had since chosen. Module-level for the same
// reason the cache is: it has to outlive the mount.
let handledFocusNonce: number | undefined;

function sameView(cache: VehiclesCache | null, view: VehiclesViewParams) {
  return !!cache && cache.q === view.q && cache.status === view.status && cache.page === view.page && cache.pageSize === view.pageSize
    && cache.sortColumn === view.sortColumn && cache.sortDirection === view.sortDirection;
}

// e.g. "Jul 2, 2026 (94 days ago)", in the viewer's locale. Counted in
// calendar days, not elapsed 24-hour periods, so something stored yesterday
// evening reads "yesterday" this morning rather than "today". The game's own
// restore time limit is not in the database, so this can say how long ago,
// never "expired".
function formatStoredAt(value: string | null | undefined, now = Date.now()) {
  const stored = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(stored)) return "Unknown";
  const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.round((startOfDay(now) - startOfDay(stored)) / 86_400_000));
  const date = new Date(stored).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const ago = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `${date} (${ago})`;
}

// dune.recoveredvehiclereason, in words. "Normal" is the everyday case and is
// not shown at all.
const STORED_REASON_LABELS: Record<string, string> = {
  Migrated: "Migrated",
  RecoveredFromLostState: "Recovered from a lost state"
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function VehiclesPanel({ onError, confirmAction, focusRequest }: VehiclesPanelProps) {
  const [q, setQ] = useState(() => vehiclesCache?.q ?? "");
  const [submittedQ, setSubmittedQ] = useState(() => vehiclesCache?.q ?? "");
  const [status, setStatus] = useState<VehicleStatusFilter>(() => vehiclesCache?.status ?? VEHICLES_DEFAULT_STATUS);
  const [page, setPage] = useState(() => vehiclesCache?.page ?? 0);
  const [pageSize, setPageSize] = useState<number>(() => vehiclesCache?.pageSize ?? VEHICLES_DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] = useState(() => vehiclesCache?.sortColumn ?? "name");
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => vehiclesCache?.sortDirection ?? "asc");
  const [rows, setRows] = useState<VehicleRow[]>(() => vehiclesCache?.rows ?? []);
  const [totalCount, setTotalCount] = useState(() => vehiclesCache?.totalCount ?? 0);
  const [totalVehicles, setTotalVehicles] = useState(() => vehiclesCache?.totalVehicles ?? 0);
  const [supported, setSupported] = useState(() => vehiclesCache?.supported ?? true);
  const [canEditPermissions, setCanEditPermissions] = useState(() => vehiclesCache?.canEditPermissions ?? false);
  const [canDeleteVehicle, setCanDeleteVehicle] = useState(() => vehiclesCache?.canDeleteVehicle ?? false);
  const [canQueueDeleteVehicle, setCanQueueDeleteVehicle] = useState(() => vehiclesCache?.canQueueDeleteVehicle ?? false);
  const [storageSupported, setStorageSupported] = useState(() => vehiclesCache?.storageSupported ?? false);
  const [canDeleteStoredVehicle, setCanDeleteStoredVehicle] = useState(() => vehiclesCache?.canDeleteStoredVehicle ?? false);
  const [reason, setReason] = useState(() => vehiclesCache?.reason ?? "");
  const [loading, setLoading] = useState(() => vehiclesCache === null);
  const [deletingId, setDeletingId] = useState("");
  const [cancelingDeleteId, setCancelingDeleteId] = useState("");
  const [deleteStatus, setDeleteStatus] = useState("");
  const [deleteStatusKind, setDeleteStatusKind] = useState<"" | "ok" | "fail">("");
  const { pending: pendingVehicleDeletes, refresh: refreshPendingVehicleDeletes } = usePendingVehicleDeletes(canQueueDeleteVehicle);
  const requestIdRef = useRef(0);
  const skipNextSearchReset = useRef(true);

  useEffect(() => {
    if (deleteStatusKind !== "ok") return undefined;
    const timer = window.setTimeout(() => { setDeleteStatus(""); setDeleteStatusKind(""); }, 10_400);
    return () => window.clearTimeout(timer);
  }, [deleteStatus, deleteStatusKind]);

  useEffect(() => {
    if (skipNextSearchReset.current) {
      skipNextSearchReset.current = false;
      return;
    }
    setPage(0);
  }, [submittedQ]);

  useEffect(() => {
    const id = String(focusRequest?.vehicleId || "").trim();
    if (!id || !/^\d+$/.test(id)) return;
    if (focusRequest?.nonce === handledFocusNonce) return;
    handledFocusNonce = focusRequest?.nonce;
    vehiclesCache = null;
    setQ(id);
    setSubmittedQ(id);
    // The deep-linked vehicle can be in any bucket (unowned, backed up), so
    // the default "Owned" filter could hide the one row being asked for.
    setStatus("all");
    setPage(0);
  }, [focusRequest?.nonce]);

  function submitSearch() {
    setSubmittedQ(q);
  }

  function handleClearSearch() {
    setQ("");
    setSubmittedQ("");
  }

  function changeStatus(nextStatus: VehicleStatusFilter) {
    setStatus(nextStatus);
    setPage(0);
  }

  function handleSort(column: string) {
    setPage(0);
    if (column === sortColumn) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortColumn(column);
    setSortDirection("asc");
  }

  function changePageSize(nextSize: number) {
    setPageSize(nextSize);
    setPage(0);
  }

  const load = useCallback(async (params: VehiclesViewParams, options: { silent?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    if (!options.silent) onError("");
    try {
      const result = await vehiclesApi.list(params);
      if (requestIdRef.current !== requestId) return;
      const nextRows = result.rows || [];
      const nextSupported = result.capabilities?.vehicles !== false;
      const nextCanEditPermissions = result.capabilities?.vehiclePermissions === true;
      const nextCanDeleteVehicle = result.capabilities?.vehicleDelete === true;
      const nextCanQueueDeleteVehicle = result.capabilities?.vehicleDeleteQueue === true;
      const nextStorageSupported = result.capabilities?.vehicleStorage === true;
      const nextCanDeleteStoredVehicle = result.capabilities?.vehicleStoredDelete === true;
      setRows(nextRows);
      // A page past the end -- the last row of the last page was just deleted,
      // or the filter shrank underneath it -- comes back empty. Step back to
      // the real last page instead of showing an empty table at "Page 3 of 2".
      if (!nextRows.length && params.page > 0) {
        setPage(Math.max(0, Math.ceil((result.totalCount || 0) / params.pageSize) - 1));
      }
      setTotalCount(result.totalCount || 0);
      setTotalVehicles(result.totalVehicles || 0);
      setSupported(nextSupported);
      setCanEditPermissions(nextCanEditPermissions);
      setCanDeleteVehicle(nextCanDeleteVehicle);
      setCanQueueDeleteVehicle(nextCanQueueDeleteVehicle);
      setStorageSupported(nextStorageSupported);
      setCanDeleteStoredVehicle(nextCanDeleteStoredVehicle);
      setReason(result.reason || "");
      vehiclesCache = {
        ...params,
        rows: nextRows,
        totalCount: result.totalCount || 0,
        totalVehicles: result.totalVehicles || 0,
        supported: nextSupported,
        canEditPermissions: nextCanEditPermissions,
        canDeleteVehicle: nextCanDeleteVehicle,
        canQueueDeleteVehicle: nextCanQueueDeleteVehicle,
        storageSupported: nextStorageSupported,
        canDeleteStoredVehicle: nextCanDeleteStoredVehicle,
        reason: result.reason || "",
        lastFetchedAt: Date.now()
      };
    } catch (error) {
      if (requestIdRef.current === requestId && !options.silent) onError(errorText(error));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;
    const params = { q: submittedQ, status, page, pageSize, sortColumn, sortDirection };
    const cacheHit = sameView(vehiclesCache, params) ? vehiclesCache : null;

    if (cacheHit) {
      setRows(cacheHit.rows);
      setTotalCount(cacheHit.totalCount);
      setTotalVehicles(cacheHit.totalVehicles);
      setSupported(cacheHit.supported);
      setCanEditPermissions(cacheHit.canEditPermissions);
      setCanDeleteVehicle(cacheHit.canDeleteVehicle);
      setCanQueueDeleteVehicle(cacheHit.canQueueDeleteVehicle);
      setStorageSupported(cacheHit.storageSupported);
      setCanDeleteStoredVehicle(cacheHit.canDeleteStoredVehicle);
      setReason(cacheHit.reason);
      setLoading(false);
    }

    const scheduleNext = () => {
      if (cancelled) return;
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => { void tick(); }, VEHICLES_AUTO_REFRESH_MS);
    };

    const tick = async () => {
      if (document.visibilityState !== "hidden") await load(params, { silent: true });
      scheduleNext();
    };

    void load(params, { silent: Boolean(cacheHit) }).then(scheduleNext);

    const onVisibilityChange = () => {
      const currentCache = sameView(vehiclesCache, params) ? vehiclesCache : null;
      if (document.visibilityState === "visible" && (!currentCache || Date.now() - currentCache.lastFetchedAt >= VEHICLES_AUTO_REFRESH_MS)) {
        void load(params, { silent: true }).then(scheduleNext);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [submittedQ, status, page, pageSize, sortColumn, sortDirection, load]);

  // A vehicle Stored for Recovery still belongs to a player who can get it
  // back, so its delete is a separate route, permission and dialog -- one that
  // names who loses it. Never queued (a stored vehicle is on no running map),
  // and the server refuses while the owner is online.
  async function handleDeleteStoredVehicle(vehicle: VehicleRow) {
    const id = String(vehicle.id);
    const label = vehicle.name || `vehicle ${id}`;
    const owner = vehicle.owner || "its owner";
    const details: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] = [
      { label: "Owner", value: vehicle.owner || "—", tone: "danger" },
      { label: "Stored", value: formatStoredAt(vehicle.stored_at) }
    ];
    if (vehicle.stored_reason && vehicle.stored_reason !== "Normal") {
      details.push({ label: "Reason", value: STORED_REASON_LABELS[vehicle.stored_reason] || vehicle.stored_reason });
    }
    const confirmed = await confirmAction(
      `Delete "${label}"? It is stored for recovery, and ${owner} will no longer be able to recover it. This permanently deletes the vehicle and everything stored in it.`,
      {
        title: "Delete Stored Vehicle",
        confirmLabel: "Delete Stored Vehicle",
        danger: true,
        details,
        warning: "A full database backup is taken automatically before the delete runs. The delete is refused while the owner is online."
      }
    );
    if (!confirmed) return;
    onError("");
    setDeletingId(id);
    try {
      await vehiclesApi.deleteStoredVehicle(id);
      setDeleteStatus(`Stored vehicle "${label}" was deleted.`);
      setDeleteStatusKind("ok");
      vehiclesCache = null;
      await load({ q: submittedQ, status, page, pageSize, sortColumn, sortDirection });
    } catch (error) {
      const text = errorText(error);
      setDeleteStatus(text);
      setDeleteStatusKind("fail");
      onError(text);
    } finally {
      setDeletingId("");
    }
  }

  // No component-count mention here the way Delete Base's dialog cites piece/
  // placeable counts: VehicleRow has no equivalent field, only the fitted
  // modules shown inside the expanded row, which this dialog does not have
  // access to. A full database "SQL Safety Backup" is still taken
  // automatically and unconditionally before any delete SQL runs -- see
  // vehiclesApi.deleteVehicle and docs/console/vehicle-deletion.md.
  async function handleDeleteVehicle(vehicle: VehicleRow) {
    if (canDeleteStoredVehicle && vehicle.lifecycle_state === "VehicleRecovery") return handleDeleteStoredVehicle(vehicle);
    const id = String(vehicle.id);
    const label = vehicle.name || `vehicle ${id}`;
    const confirmed = await confirmAction(
      `Delete "${label}"? This permanently deletes the vehicle and everything stored in it.`,
      {
        title: "Delete Vehicle",
        confirmLabel: "Delete",
        danger: true,
        details: [{ label: "Owner", value: vehicle.owner || "—", tone: "danger" }],
        warning: canQueueDeleteVehicle
          ? "A full database backup is taken automatically before the delete runs. If this vehicle's map is running, the delete is queued and applied the next time that map restarts or stops, so a live server cannot overwrite it. If the map is already down, it is deleted now."
          : "A full database backup is taken automatically before the delete runs, straight to the database. A running game server may not reflect the removal in-game until the map server restarts."
      }
    );
    if (!confirmed) return;
    onError("");
    setDeletingId(id);
    try {
      const response = await vehiclesApi.deleteVehicle(id);
      if (response.result?.queued) {
        setDeleteStatus(`Delete for "${label}" is queued and applies when this map next restarts or stops.`);
        setDeleteStatusKind("ok");
        await refreshPendingVehicleDeletes();
      } else {
        setDeleteStatus(`"${label}" was deleted.`);
        setDeleteStatusKind("ok");
        vehiclesCache = null;
        await load({ q: submittedQ, status, page, pageSize, sortColumn, sortDirection });
      }
    } catch (error) {
      const text = errorText(error);
      setDeleteStatus(text);
      setDeleteStatusKind("fail");
      onError(text);
    } finally {
      setDeletingId("");
    }
  }

  async function handleCancelQueuedDelete(vehicle: VehicleRow) {
    const id = String(vehicle.id);
    const label = vehicle.name || `vehicle ${id}`;
    const confirmed = await confirmAction(`Cancel the queued delete for "${label}"?`, {
      title: "Cancel Queued Delete",
      confirmLabel: "Cancel Delete"
    });
    if (!confirmed) return;
    onError("");
    setCancelingDeleteId(id);
    try {
      await vehiclesApi.cancelQueuedDelete(id);
      setDeleteStatus(`Queued delete for "${label}" was canceled.`);
      setDeleteStatusKind("ok");
      await refreshPendingVehicleDeletes();
    } catch (error) {
      const text = errorText(error);
      setDeleteStatus(text);
      setDeleteStatusKind("fail");
      onError(text);
    } finally {
      setCancelingDeleteId("");
    }
  }

  if (loading && !rows.length) {
    return (
      <section className="panel">
        <div className="loading-panel">
          <span className="spinner" aria-hidden="true" />
          <strong className="loading-dots">Loading Vehicles</strong>
        </div>
      </section>
    );
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rangeStart = totalCount === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = totalCount === 0 ? 0 : rangeStart + rows.length - 1;
  const hasPreviousPage = page > 0;
  const hasNextPage = page + 1 < totalPages;
  const queuedDeleteVehicleIds = new Set((pendingVehicleDeletes?.pending || []).map((entry) => String(entry.vehicleId)));

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Vehicles</h2>
        <div className="action-row">
          <button onClick={() => void load({ q: submittedQ, status, page, pageSize, sortColumn, sortDirection })}>Refresh</button>
        </div>
      </div>
      {supported && <SegmentedControl
        name="vehicles-status-filter"
        ariaLabel="Vehicles shown"
        value={status}
        options={VEHICLES_STATUS_OPTIONS}
        onChange={changeStatus}
        groupClassName="segmented-control vehicles-status-segments"
      />}
      {supported
        ? <p className="action-help-note">Total Vehicles: {status === "all" && !submittedQ ? totalVehicles.toLocaleString() : `${totalCount.toLocaleString()} of ${totalVehicles.toLocaleString()}`}</p>
        : <p className="action-help-note">{reason || "Vehicles are unsupported by the detected database schema."}</p>}
      {deleteStatus && <p
        className={`inline-task-result${deleteStatusKind ? ` result-${deleteStatusKind}` : ""}`}
        role={deleteStatusKind === "fail" ? "alert" : "status"}
        onAnimationEnd={() => { if (deleteStatusKind === "ok") { setDeleteStatus(""); setDeleteStatusKind(""); } }}
      ><strong>{deleteStatus}</strong></p>}
      {supported && <>
        <div className="action-row vehicles-search-row">
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") submitSearch(); }}
            placeholder="Search name, type, owner, or map"
          />
          <button onClick={submitSearch}>Search</button>
          <button onClick={handleClearSearch} disabled={!q && !submittedQ}>Clear</button>
        </div>
        <VehicleTable
          rows={rows}
          sortColumn={sortColumn}
          sortDirection={sortDirection}
          onSort={handleSort}
          emptyMessage={status === "all" && !submittedQ ? "No vehicles have been found yet." : "No vehicles match this filter."}
          canEditPermissions={canEditPermissions}
          focusVehicleId={focusRequest?.vehicleId}
          focusNonce={focusRequest?.nonce}
          confirmAction={confirmAction}
          // Owner and Shared With are rendered from the list response, so a
          // saved roster has to refetch or the row above keeps showing the
          // pre-edit names.
          onPermissionsSaved={() => {
            vehiclesCache = null;
            void load({ q: submittedQ, status, page, pageSize, sortColumn, sortDirection }, { silent: true });
          }}
          canDeleteVehicle={canDeleteVehicle}
          storageSupported={storageSupported}
          canDeleteStoredVehicle={canDeleteStoredVehicle}
          onError={onError}
          queuedDeleteVehicleIds={queuedDeleteVehicleIds}
          deletingId={deletingId}
          cancelingDeleteId={cancelingDeleteId}
          onDeleteVehicle={(vehicle) => void handleDeleteVehicle(vehicle)}
          onCancelQueuedDelete={(vehicle) => void handleCancelQueuedDelete(vehicle)}
        />
        <div className="panel-title vehicles-pagination-footer">
          <p className="action-help-note">Showing {rangeStart}-{rangeEnd} of {totalCount} vehicles.</p>
          <div className="database-pagination-controls">
            <label className="compact-select">
              Rows
              <select value={String(pageSize)} onChange={(event) => changePageSize(Number(event.target.value))}>
                {VEHICLES_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <button disabled={!hasPreviousPage} onClick={() => setPage(0)}>First</button>
            <button disabled={!hasPreviousPage} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="muted database-page-indicator">Page {page + 1} of {totalPages}</span>
            <button disabled={!hasNextPage} onClick={() => setPage(page + 1)}>Next</button>
            <button disabled={!hasNextPage} onClick={() => setPage(totalPages - 1)}>Last</button>
          </div>
        </div>
      </>}
    </section>
  );
}
