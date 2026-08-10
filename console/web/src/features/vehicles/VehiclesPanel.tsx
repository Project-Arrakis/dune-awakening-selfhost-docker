import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { vehiclesApi, type VehicleModule, type VehicleRow, type VehicleSharedEntry } from "../../api/vehicles";
import { DataTable, type SortDirection } from "../../components/common/DataTable";

type VehiclesPanelProps = {
  onError: (text: string) => void;
  // Read-only page: confirmAction/formatMutationResult are passed by App.tsx for
  // parity with the other panels but intentionally unused here. The confirmAction
  // signature mirrors the other panels so App.tsx can pass confirmDialog directly.
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
  formatMutationResult: (result: unknown) => string;
};

const VEHICLES_AUTO_REFRESH_MS = 15 * 60_000; // 15 minutes — listVehicles is expensive
const VEHICLES_PAGE_SIZES = [25, 50, 100, 200] as const;
const VEHICLES_DEFAULT_PAGE_SIZE = 50;

const VEHICLE_COLUMNS = ["name", "type", "owner", "shared_with", "condition_percent", "fuel_percent", "location"];
const VEHICLE_COLUMN_LABELS: Record<string, string> = {
  name: "Vehicle",
  type: "Type",
  owner: "Owner",
  shared_with: "Shared With",
  condition_percent: "Lowest Condition",
  fuel_percent: "Fuel",
  location: "Location"
};
// shared_with is resolved only on the paged rows server-side, so it has no
// stable sort key; location is a derived (map + partition + coords) display
// string with no single server sort column — both are non-sortable.
const VEHICLE_NON_SORTABLE = ["shared_with", "location"];

type VehiclesCache = {
  q: string;
  page: number;
  pageSize: number;
  sortColumn: string;
  sortDirection: SortDirection;
  rows: VehicleRow[];
  totalCount: number;
  totalVehicles: number;
  supported: boolean;
  reason: string;
  lastFetchedAt: number;
};

let vehiclesCache: VehiclesCache | null = null;

function sameView(cache: VehiclesCache | null, q: string, page: number, pageSize: number, sortColumn: string, sortDirection: SortDirection) {
  return !!cache && cache.q === q && cache.page === page && cache.pageSize === pageSize && cache.sortColumn === sortColumn && cache.sortDirection === sortDirection;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Green ≥66, amber ≥33, red below — the same thresholds the mockup uses.
function meterColor(pct: number) {
  if (pct >= 66) return "var(--success)";
  if (pct >= 33) return "var(--warning)";
  return "var(--danger)";
}

function renderMeter(pct: number | null) {
  if (pct === null) return <span className="muted">—</span>;
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="vehicles-meter-cell">
      <div className="vehicles-meter"><i style={{ width: `${clamped}%`, background: meterColor(clamped) }} /></div>
      <span className="vehicles-meter-pct">{clamped}%</span>
    </div>
  );
}

// Map name + partition id disambiguate the many instances of the same region
// (two "HaggaBasin" partitions, two "DeepDesert" partitions, ...) — shown as the
// subtext under the vehicle name.
function formatMapPartition(row: VehicleRow) {
  const map = String(row.map || "").trim() || "Unknown map";
  return `${map} · partition ${row.partition_id ?? 0}`;
}

// Rounded world coordinates, shown on the first row of the Location column.
function formatCoords(row: VehicleRow) {
  const x = toNumber(row.x);
  const y = toNumber(row.y);
  if (x === null || y === null) return "—";
  return `(${Math.round(x).toLocaleString()}, ${Math.round(y).toLocaleString()})`;
}

// Deep Desert is a 9x9 sector grid, 250k units per cell, spanning +/-1,125,000:
// the letter (A-I) tracks Y descending, the number (1-9) tracks X ascending.
// Only Deep Desert uses this grid; other maps have no documented sector scheme,
// so they show coordinates alone.
function mapGridSector(row: VehicleRow): string | null {
  if (!/deepdesert/i.test(String(row.map || ""))) return null;
  const x = toNumber(row.x);
  const y = toNumber(row.y);
  if (x === null || y === null) return null;
  const letter = String.fromCharCode(65 + Math.max(0, Math.min(8, Math.floor((1125000 - y) / 250000))));
  const number = Math.max(0, Math.min(8, Math.floor((x + 1125000) / 250000))) + 1;
  return `${letter}-${number}`;
}

function formatDurability(value: unknown): string {
  const n = toNumber(value);
  return n === null ? "—" : Math.round(n).toLocaleString();
}

function renderVehicleCell(row: Record<string, unknown>, column: string) {
  const vehicle = row as VehicleRow;
  if (column === "name") {
    return (
      <div className="vehicles-name-cell">
        <span className="vehicles-name">{vehicle.name || "—"}</span>
        <span className="vehicles-location">{formatMapPartition(vehicle)}</span>
      </div>
    );
  }
  if (column === "location") {
    const sector = mapGridSector(vehicle);
    return (
      <div className="vehicles-location-cell">
        <span className="vehicles-coords">{formatCoords(vehicle)}</span>
        {sector && <span className="vehicles-grid">Sector {sector}</span>}
      </div>
    );
  }
  if (column === "type") {
    return vehicle.type ? String(vehicle.type) : <span className="muted">—</span>;
  }
  if (column === "owner") {
    return vehicle.owner ? String(vehicle.owner) : <span className="muted">—</span>;
  }
  if (column === "condition_percent") {
    return renderMeter(toNumber(vehicle.condition_percent));
  }
  if (column === "fuel_percent") {
    return renderMeter(toNumber(vehicle.fuel_percent));
  }
  if (column === "shared_with") {
    const shared: VehicleSharedEntry[] = Array.isArray(vehicle.shared_with) ? vehicle.shared_with : [];
    if (!shared.length) return <span className="muted">—</span>;
    return (
      <span className="vehicles-shared-list">
        {shared.map((entry) => (
          <span key={`${entry.name}-${entry.rank}`}>{entry.name} <em>({entry.label})</em></span>
        ))}
      </span>
    );
  }
  const value = row[column];
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

// A locomotion piece's name carries its mount position as a trailing "(Front
// Left)" etc. Split it so the position sits on its own line, smaller — the tier
// name stays the scannable part.
function splitComponentName(name: string): { base: string; position: string | null } {
  const match = /^(.*\S)\s+\((Front|Back|Center) (Left|Right|Center)\)$/.exec(name || "");
  return match ? { base: match[1], position: `${match[2]} ${match[3]}` } : { base: name, position: null };
}

function renderComponent(module: VehicleModule, index: number) {
  const pct = module.conditionPercent;
  const { base, position } = splitComponentName(module.name || "");
  return (
    <div className="vehicles-component-card" key={`${module.templateId}-${index}`}>
      <span className="vehicles-component-name">
        {base}
        {position && <span className="vehicles-component-position">{position}</span>}
      </span>
      {pct === null || pct === undefined
        ? <span className="vehicles-component-meta">{module.condition === null || module.condition === undefined ? "Durability not reported" : `${formatDurability(module.condition)} durability`}</span>
        : <>
            <div className="vehicles-meter"><i style={{ width: `${Math.max(0, Math.min(100, Math.round(pct)))}%`, background: meterColor(pct) }} /></div>
            <span className="vehicles-component-meta">{formatDurability(module.condition)} / {formatDurability(module.maxCondition)} · {Math.round(pct)}%</span>
          </>}
    </div>
  );
}

export function VehiclesPanel({ onError }: VehiclesPanelProps) {
  const [q, setQ] = useState(() => vehiclesCache?.q ?? "");
  const [submittedQ, setSubmittedQ] = useState(() => vehiclesCache?.q ?? "");
  const [page, setPage] = useState(() => vehiclesCache?.page ?? 0);
  const [pageSize, setPageSize] = useState<number>(() => vehiclesCache?.pageSize ?? VEHICLES_DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] = useState(() => vehiclesCache?.sortColumn ?? "name");
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => vehiclesCache?.sortDirection ?? "asc");
  const [rows, setRows] = useState<VehicleRow[]>(() => vehiclesCache?.rows ?? []);
  const [totalCount, setTotalCount] = useState(() => vehiclesCache?.totalCount ?? 0);
  const [totalVehicles, setTotalVehicles] = useState(() => vehiclesCache?.totalVehicles ?? 0);
  const [supported, setSupported] = useState(() => vehiclesCache?.supported ?? true);
  const [reason, setReason] = useState(() => vehiclesCache?.reason ?? "");
  const [loading, setLoading] = useState(() => vehiclesCache === null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const skipNextSearchReset = useRef(true);

  useEffect(() => {
    if (skipNextSearchReset.current) {
      skipNextSearchReset.current = false;
      return;
    }
    setPage(0);
  }, [submittedQ]);

  function submitSearch() {
    setSubmittedQ(q);
  }

  function handleClearSearch() {
    setQ("");
    setSubmittedQ("");
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

  function toggleExpanded(id: string) {
    setExpandedId((current) => (current === id ? null : id));
  }

  const load = useCallback(async (params: { q: string; page: number; pageSize: number; sortColumn: string; sortDirection: SortDirection }, options: { silent?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    if (!options.silent) onError("");
    try {
      const result = await vehiclesApi.list(params);
      if (requestIdRef.current !== requestId) return;
      const nextRows = result.rows || [];
      const nextSupported = result.capabilities?.vehicles !== false;
      setRows(nextRows);
      setTotalCount(result.totalCount || 0);
      setTotalVehicles(result.totalVehicles || 0);
      setSupported(nextSupported);
      setReason(result.reason || "");
      vehiclesCache = {
        q: params.q,
        page: params.page,
        pageSize: params.pageSize,
        sortColumn: params.sortColumn,
        sortDirection: params.sortDirection,
        rows: nextRows,
        totalCount: result.totalCount || 0,
        totalVehicles: result.totalVehicles || 0,
        supported: nextSupported,
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
    const params = { q: submittedQ, page, pageSize, sortColumn, sortDirection };
    const cacheHit = sameView(vehiclesCache, submittedQ, page, pageSize, sortColumn, sortDirection) ? vehiclesCache : null;

    if (cacheHit) {
      setRows(cacheHit.rows);
      setTotalCount(cacheHit.totalCount);
      setTotalVehicles(cacheHit.totalVehicles);
      setSupported(cacheHit.supported);
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
      const currentCache = sameView(vehiclesCache, submittedQ, page, pageSize, sortColumn, sortDirection) ? vehiclesCache : null;
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
  }, [submittedQ, page, pageSize, sortColumn, sortDirection, load]);

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

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Vehicles</h2>
        <div className="action-row">
          <button onClick={() => void load({ q: submittedQ, page, pageSize, sortColumn, sortDirection })}>Refresh</button>
        </div>
      </div>
      {supported
        ? <p className="action-help-note">Total Vehicles: {totalVehicles.toLocaleString()}</p>
        : <p className="action-help-note">{reason || "Vehicles are unsupported by the detected database schema."}</p>}
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
        <DataTable
          rows={rows}
          columns={VEHICLE_COLUMNS}
          columnLabels={VEHICLE_COLUMN_LABELS}
          tableClassName="vehicles-table"
          wrapClassName="vehicles-table-wrap"
          headerTitles
          renderCell={renderVehicleCell}
          nonSortableColumns={VEHICLE_NON_SORTABLE}
          sortColumn={sortColumn}
          sortDirection={sortDirection}
          onSort={handleSort}
          secondaryActionPosition="start"
          secondaryActionLabel=""
          secondaryActionClassName="vehicles-expand-column"
          secondaryAction={(row) => {
            const vehicle = row as VehicleRow;
            const id = String(vehicle.id);
            const isExpanded = expandedId === id;
            const label = `${isExpanded ? "Collapse" : "Show"} components for ${vehicle.name || `vehicle ${id}`}`;
            return <button
              className="vehicles-expand-button"
              title={label}
              aria-label={label}
              aria-expanded={isExpanded}
              onClick={(event) => { event.stopPropagation(); toggleExpanded(id); }}
            >{isExpanded ? <ChevronUp size={14} className="vehicles-expand-chevron" /> : <ChevronDown size={14} className="vehicles-expand-chevron" />}</button>;
          }}
          rowKey={(row) => String((row as VehicleRow).id)}
          onRowClick={(row) => toggleExpanded(String((row as VehicleRow).id))}
          isRowExpanded={(row) => expandedId === String((row as VehicleRow).id)}
          renderExpandedRow={(row) => {
            const vehicle = row as VehicleRow;
            const modules: VehicleModule[] = Array.isArray(vehicle.modules) ? vehicle.modules : [];
            return (
              <div className="vehicles-expanded">
                <p className="vehicles-expanded-header">{modules.length} component{modules.length === 1 ? "" : "s"}</p>
                {modules.length === 0
                  ? <p className="muted">No components fitted.</p>
                  : <div className="vehicles-component-grid">{modules.map(renderComponent)}</div>}
              </div>
            );
          }}
          emptyMessage="No vehicles have been found yet."
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
