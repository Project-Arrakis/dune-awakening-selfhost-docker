import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Unlock } from "lucide-react";
import { basesApi } from "../../api/bases";
import { apiDownload } from "../../api/client";
import { DataTable, useSortableRows } from "../../components/common/DataTable";

type BasesPanelProps = {
  onError: (text: string) => void;
};

type SharedWithEntry = { name: string; rank: number; label: string };

type BaseRow = Record<string, unknown> & {
  base_id: string;
  name: string;
  owner_name: string;
  map: string;
  x: number;
  y: number;
  z: number;
  coordinates: string;
  piece_count: number;
  placeable_count: number;
  shared_with: SharedWithEntry[];
};

const BASES_AUTO_REFRESH_MS = 15 * 60_000; // 15 minutes — listBases is expensive
const BASES_AUTO_REFRESH_RETRY_MS = 60_000; // backoff if a due refresh hasn't landed yet (in-flight/failed)
const BASES_RELATIVE_TIME_TICK_MS = 30_000; // UI-only re-render cadence for "time ago" text — never fetches

type BasesCache = { rows: BaseRow[]; q: string; lastFetchedAt: number };

let basesCache: BasesCache | null = null;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function withCoordinates(row: Record<string, unknown>): BaseRow {
  const x = Math.round(Number(row.x) || 0);
  const y = Math.round(Number(row.y) || 0);
  const z = Math.round(Number(row.z) || 0);
  return { ...row, x, y, z, coordinates: `${x}, ${y}, ${z}` } as BaseRow;
}

function formatRelativeTime(fromMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (diffSec < 45) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
}

function matchesQuery(row: BaseRow, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return String(row.name ?? "").toLowerCase().includes(needle)
    || String(row.owner_name ?? "").toLowerCase().includes(needle);
}

function renderBaseCell(row: Record<string, unknown>, column: string) {
  if (column !== "shared_with") {
    const value = row[column];
    if (Array.isArray(value)) return value.join(", ");
    return value == null || value === "" ? "—" : String(value);
  }
  const sharedWith = Array.isArray(row.shared_with) ? (row.shared_with as SharedWithEntry[]) : [];
  if (!sharedWith.length) return <span className="muted">—</span>;
  return (
    <span className="bases-shared-list">
      {sharedWith.map((entry) => (
        <span key={`${entry.name}-${entry.rank}`}>{entry.name} <em>({entry.label})</em></span>
      ))}
    </span>
  );
}

export function BasesPanel({ onError }: BasesPanelProps) {
  const [q, setQ] = useState(() => basesCache?.q ?? "");
  const [rows, setRows] = useState<BaseRow[]>(() => basesCache?.rows ?? []);
  const [loading, setLoading] = useState(() => basesCache === null);
  const [now, setNow] = useState(() => Date.now());
  const [exportingId, setExportingId] = useState("");
  const refreshInFlight = useRef(false);
  const filteredRows = useMemo(() => rows.filter((row) => matchesQuery(row, q)), [rows, q]);
  const sort = useSortableRows(filteredRows);

  useEffect(() => {
    if (basesCache) basesCache.q = q;
  }, [q]);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (!options.silent) onError("");
    try {
      const result = await basesApi.list();
      const nextRows = (result.rows || []).map(withCoordinates);
      setRows(nextRows);
      basesCache = { ...basesCache, rows: nextRows, q: basesCache?.q ?? "", lastFetchedAt: Date.now() };
    } catch (error) {
      if (!options.silent) onError(errorText(error));
    } finally {
      setLoading(false);
      refreshInFlight.current = false;
    }
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;

    const isStale = () => Date.now() - (basesCache?.lastFetchedAt ?? 0) >= BASES_AUTO_REFRESH_MS;

    const refreshIfStale = async () => {
      if (document.visibilityState === "hidden" || !isStale()) return;
      await load({ silent: true });
    };

    const scheduleNext = () => {
      if (cancelled) return;
      window.clearTimeout(timeoutId);
      const last = basesCache?.lastFetchedAt ?? Date.now();
      const dueIn = last + BASES_AUTO_REFRESH_MS - Date.now();
      const delay = dueIn > 0 ? dueIn : BASES_AUTO_REFRESH_RETRY_MS;
      timeoutId = window.setTimeout(() => { void runAndReschedule(refreshIfStale); }, delay);
    };

    const runAndReschedule = async (fn: () => Promise<void>) => {
      await fn();
      if (!cancelled) scheduleNext();
    };

    void runAndReschedule(basesCache === null ? () => load() : refreshIfStale);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void runAndReschedule(refreshIfStale);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), BASES_RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  async function handleExport(row: BaseRow) {
    const id = String(row.base_id);
    setExportingId(id);
    try {
      const response = await apiDownload(`/api/bases/${encodeURIComponent(id)}/export`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = row.name ? `${String(row.name).replace(/[^a-zA-Z0-9_-]/g, "_")}.json` : `base_${id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setExportingId("");
    }
  }

  if (loading) {
    return <section className="panel">
      <div className="panel-title"><h2>Bases</h2></div>
      <div className="loading-panel">
        <span className="spinner" aria-hidden="true" />
        <strong className="loading-dots">Loading Bases</strong>
      </div>
    </section>;
  }

  const totalBases = rows.length;
  const totalPieces = rows.reduce((sum, row) => sum + Number(row.piece_count || 0), 0);
  const totalPlaceables = rows.reduce((sum, row) => sum + Number(row.placeable_count || 0), 0);
  const lastFetchedAt = basesCache?.lastFetchedAt ?? null;
  const filteredCount = filteredRows.length;
  const rangeStart = filteredCount === 0 ? 0 : 1;

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Bases</h2>
        <div className="action-row">
          {lastFetchedAt !== null && (
            <span className="muted">Refreshed {formatRelativeTime(lastFetchedAt, now)}</span>
          )}
          <button onClick={() => void load()}>Refresh</button>
        </div>
      </div>
      <p className="action-help-note">
        Total Bases: {totalBases.toLocaleString()} · Total Building Pieces: {totalPieces.toLocaleString()} · Total Placeables: {totalPlaceables.toLocaleString()}
      </p>
      <div className="action-row bases-search-row"><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search base or owner name" /></div>
      <p className="action-help-note bases-row-count">
        Showing {rangeStart}-{filteredCount} of {totalBases} rows.
      </p>
      <DataTable
        rows={sort.sortedRows}
        columns={["base_id", "name", "owner_name", "shared_with", "map", "coordinates", "piece_count", "placeable_count"]}
        tableClassName="bases-table"
        actionClassName="actions-column"
        renderCell={renderBaseCell}
        action={(row) => {
          const base = row as BaseRow;
          const id = String(base.base_id);
          return <span className="icon-toggle-group">
            <button className="icon-toggle-button" title="Export base" aria-label="Export base" disabled={exportingId === id} onClick={(event) => { event.stopPropagation(); void handleExport(base); }}><Download size={16} /></button>
            <button className="icon-toggle-button" title="Coming soon" aria-label="Release claim" disabled><Unlock size={16} /></button>
          </span>;
        }}
        sortColumn={sort.sortColumn}
        sortDirection={sort.sortDirection}
        onSort={sort.onSort}
        rowKey={(row) => String(row.base_id)}
        emptyMessage="No bases have been found yet."
      />
    </section>
  );
}
