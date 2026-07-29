import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Download, Fuel } from "lucide-react";
import { basesApi, type RefillDeviceResult } from "../../api/bases";
import { apiDownload } from "../../api/client";
import { DataTable, type SortDirection } from "../../components/common/DataTable";

type BasesPanelProps = {
  onError: (text: string) => void;
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string }) => Promise<boolean>;
  formatMutationResult: (result: unknown) => string;
};

type SharedWithEntry = { name: string; rank: number; label: string };

type GeneratorEntry = {
  type: "fuel" | "spice" | "windTurbineOmni" | "windTurbineDirectional";
  name: string;
  fuelName: string;
  fuelCells: number;
  generatorCount: number;
  runtimeSeconds: number;
  // Generators of this type with no accepted fuel units queued in inventory.
  // This deliberately does not claim that a stale burn marker is still active.
  unstockedCount?: number;
};

type BaseRow = Record<string, unknown> & {
  base_id: string;
  name: string;
  base_type: string;
  owner_name: string;
  map: string;
  x: number;
  y: number;
  z: number;
  coordinates: string;
  piece_count: number;
  placeable_count: number;
  shared_with: SharedWithEntry[];
  generatorDataAvailable: boolean;
  generatorCount: number;
  fuelCells: number;
  generatorRuntimeSeconds: number;
  generatorUptimeMultiplier: number;
  generatorUptimeEventLabel: string;
  generatorUptimeEventEndsAt: string;
  generatorUnstockedCount: number;
  generatorAllUnstocked: boolean;
  generators: GeneratorEntry[];
};

function formatRuntime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatEventThroughDate(endsAt: string) {
  const exclusiveEnd = Date.parse(endsAt);
  if (!Number.isFinite(exclusiveEnd)) return "the announced event end";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(exclusiveEnd - 1));
}

function hasNoQueuedFuel(unstockedCount: number | undefined, generatorCount: number) {
  return generatorCount > 0 && (unstockedCount || 0) >= generatorCount;
}

const QUEUED_RESERVE_EXPLANATION = "Queued Reserve counts fuel still in inventory. It excludes fuel currently burning, so the in-game Total Uptime may be higher.";

const BASES_AUTO_REFRESH_MS = 15 * 60_000; // 15 minutes — listBases is expensive
const BASES_PAGE_SIZES = [25, 50, 100, 200] as const;
const BASES_DEFAULT_PAGE_SIZE = 50;

type BasesCache = {
  q: string;
  page: number;
  pageSize: number;
  sortColumn: string;
  sortDirection: SortDirection;
  rows: BaseRow[];
  totalCount: number;
  totalBases: number;
  totalPieces: number;
  totalPlaceables: number;
  lastFetchedAt: number;
};

let basesCache: BasesCache | null = null;

function sameView(cache: BasesCache | null, q: string, page: number, pageSize: number, sortColumn: string, sortDirection: SortDirection) {
  return !!cache && cache.q === q && cache.page === page && cache.pageSize === pageSize && cache.sortColumn === sortColumn && cache.sortDirection === sortDirection;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Report what actually changed per device rather than a generic "Action
// completed." — "nothing was added" is a meaningful outcome here, not a failure.
function summarizeRefill(response: { result?: { totalAdded: number; devices: RefillDeviceResult[] } }) {
  const result = response.result;
  if (!result || !Array.isArray(result.devices)) return "";
  const changed = result.devices.filter((device) => (device.added || 0) > 0);
  if (!changed.length) return `All ${result.devices.length} device${result.devices.length === 1 ? " was" : "s were"} already full. Nothing added.`;
  const detail = changed
    .map((device) => `${device.label}: +${device.added} ${device.fuelName}${device.added === 1 ? "" : "s"}${device.capped ? " (capped by inventory space)" : ""}`)
    .join(" · ");
  const skipped = result.devices.filter((device) => device.skipped).length;
  return `Added ${result.totalAdded} fuel unit${result.totalAdded === 1 ? "" : "s"} across ${changed.length} device${changed.length === 1 ? "" : "s"}. ${detail}${skipped ? ` · ${skipped} skipped (no inventory)` : ""}`;
}

function withCoordinates(row: Record<string, unknown>): BaseRow {
  const x = Math.round(Number(row.x) || 0);
  const y = Math.round(Number(row.y) || 0);
  const z = Math.round(Number(row.z) || 0);
  return { ...row, x, y, z, coordinates: `${x}, ${y}, ${z}` } as BaseRow;
}

// Columns narrow enough to ellipsize; a title keeps the full value readable.
const TOOLTIP_COLUMNS = new Set(["base_type", "owner_name", "coordinates"]);

function renderBaseCell(row: Record<string, unknown>, column: string) {
  if (column === "name") {
    const name = String(row.name || "");
    return name ? <span className="bases-name" title={name}>{name}</span> : "—";
  }
  if (column === "generators") {
    if (row.generatorDataAvailable === false) return <span className="muted" title="Generator data is unavailable">Unavailable</span>;
    const generatorCount = Number(row.generatorCount) || 0;
    if (!generatorCount) return <span className="muted">—</span>;
    if (row.generatorAllUnstocked) {
      const text = `${generatorCount} · No generators have queued fuel`;
      return (
        <span className="bases-generator-summary" title={`${text}. ${QUEUED_RESERVE_EXPLANATION}`}>
          {generatorCount} · <span className="bases-fuel-alert">No generators have queued fuel</span>
        </span>
      );
    }
    const unstockedCount = Number(row.generatorUnstockedCount) || 0;
    const runtimeSeconds = Number(row.generatorRuntimeSeconds) || 0;
    // The database can verify queued inventory, but active burn timestamps can
    // be stale after a restart/base load. Describe the value as a reserve rather
    // than promising an exact live depletion countdown.
    if (unstockedCount > 0) {
      const text = `${generatorCount} · ${unstockedCount} with no queued fuel · Lowest Queued Reserve ${formatRuntime(runtimeSeconds)}`;
      return (
        <span className="bases-generator-summary" title={`${text}. ${QUEUED_RESERVE_EXPLANATION}`}>
          {generatorCount} · <span className="bases-fuel-alert">{unstockedCount} with no queued fuel</span> <br />
          Lowest Queued Reserve {formatRuntime(runtimeSeconds)}
        </span>
      );
    }
    const text = `${generatorCount} · Lowest Queued Reserve ${formatRuntime(runtimeSeconds)}`;
    return <span className="bases-generator-summary" title={`${text}. ${QUEUED_RESERVE_EXPLANATION}`}>{text}</span>;
  }
  if (TOOLTIP_COLUMNS.has(column)) {
    const value = row[column];
    const text = value == null || value === "" ? "" : String(value);
    return text ? <span className="bases-ellipsis-cell" title={text}>{text}</span> : "—";
  }
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

export function BasesPanel({ onError, confirmAction, formatMutationResult }: BasesPanelProps) {
  const [q, setQ] = useState(() => basesCache?.q ?? "");
  const [submittedQ, setSubmittedQ] = useState(() => basesCache?.q ?? "");
  const [page, setPage] = useState(() => basesCache?.page ?? 0);
  const [pageSize, setPageSize] = useState<number>(() => basesCache?.pageSize ?? BASES_DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] = useState(() => basesCache?.sortColumn ?? "name");
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => basesCache?.sortDirection ?? "asc");
  const [rows, setRows] = useState<BaseRow[]>(() => basesCache?.rows ?? []);
  const [totalCount, setTotalCount] = useState(() => basesCache?.totalCount ?? 0);
  const [totalBases, setTotalBases] = useState(() => basesCache?.totalBases ?? 0);
  const [totalPieces, setTotalPieces] = useState(() => basesCache?.totalPieces ?? 0);
  const [totalPlaceables, setTotalPlaceables] = useState(() => basesCache?.totalPlaceables ?? 0);
  const [loading, setLoading] = useState(() => basesCache === null);
  const [downloadingId, setDownloadingId] = useState("");
  const [refillingId, setRefillingId] = useState("");
  const [refillResult, setRefillResult] = useState("");
  const [canRefill, setCanRefill] = useState(false);
  const [expandedBaseId, setExpandedBaseId] = useState<string | null>(null);
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

  const load = useCallback(async (params: { q: string; page: number; pageSize: number; sortColumn: string; sortDirection: SortDirection }, options: { silent?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    if (!options.silent) onError("");
    try {
      const result = await basesApi.list(params);
      if (requestIdRef.current !== requestId) return;
      const nextRows = (result.rows || []).map(withCoordinates);
      setRows(nextRows);
      setCanRefill(Boolean(result.capabilities?.generatorRefill));
      setTotalCount(result.totalCount || 0);
      setTotalBases(result.totalBases || 0);
      setTotalPieces(result.totalPieces || 0);
      setTotalPlaceables(result.totalPlaceables || 0);
      basesCache = {
        q: params.q,
        page: params.page,
        pageSize: params.pageSize,
        sortColumn: params.sortColumn,
        sortDirection: params.sortDirection,
        rows: nextRows,
        totalCount: result.totalCount || 0,
        totalBases: result.totalBases || 0,
        totalPieces: result.totalPieces || 0,
        totalPlaceables: result.totalPlaceables || 0,
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
    const cacheHit = sameView(basesCache, submittedQ, page, pageSize, sortColumn, sortDirection) ? basesCache : null;

    if (cacheHit) {
      setRows(cacheHit.rows);
      setTotalCount(cacheHit.totalCount);
      setTotalBases(cacheHit.totalBases);
      setTotalPieces(cacheHit.totalPieces);
      setTotalPlaceables(cacheHit.totalPlaceables);
      setLoading(false);
    }

    const scheduleNext = () => {
      if (cancelled) return;
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => { void tick(); }, BASES_AUTO_REFRESH_MS);
    };

    const tick = async () => {
      if (document.visibilityState !== "hidden") await load(params, { silent: true });
      scheduleNext();
    };

    // Always refresh on entry. Cached rows remain visible while the current data is fetched.
    void load(params, { silent: Boolean(cacheHit) }).then(scheduleNext);

    const onVisibilityChange = () => {
      const currentCache = sameView(basesCache, submittedQ, page, pageSize, sortColumn, sortDirection) ? basesCache : null;
      if (document.visibilityState === "visible" && (!currentCache || Date.now() - currentCache.lastFetchedAt >= BASES_AUTO_REFRESH_MS)) {
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

  async function handleDownloadBlueprint(row: BaseRow) {
    const id = String(row.base_id);
    setDownloadingId(id);
    try {
      const response = await apiDownload(`/api/bases/${encodeURIComponent(id)}/export`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const responseFilename = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1];
      anchor.download = responseFilename
        || `${String(row.owner_name || "unknown_player").replace(/[^a-zA-Z0-9_-]/g, "_")}_base_${id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setDownloadingId("");
    }
  }

  async function handleRefillGenerators(base: BaseRow) {
    const id = String(base.base_id);
    const count = Number(base.generatorCount) || 0;
    const confirmed = await confirmAction(
      `Refill ${count} power device${count === 1 ? "" : "s"} at "${base.name || `base ${id}`}" to full fuel?`,
      {
        title: "Refill Generators",
        confirmLabel: "Refill",
        warning: "Refill writes fuel straight to the database. A running game server will not show the new fuel in-game until the map server restarts."
      }
    );
    if (!confirmed) return;
    onError("");
    setRefillingId(id);
    try {
      const response = await basesApi.refillGenerators(id);
      setRefillResult(summarizeRefill(response) || formatMutationResult(response));
      // The module cache still holds pre-refill fuel counts for this view.
      basesCache = null;
      await load({ q: submittedQ, page, pageSize, sortColumn, sortDirection });
    } catch (error) {
      const text = errorText(error);
      setRefillResult(text);
      onError(text);
    } finally {
      setRefillingId("");
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

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rangeStart = totalCount === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = totalCount === 0 ? 0 : rangeStart + rows.length - 1;
  const hasPreviousPage = page > 0;
  const hasNextPage = page + 1 < totalPages;

  function changePageSize(nextSize: number) {
    setPageSize(nextSize);
    setPage(0);
  }

  function toggleExpanded(id: string) {
    setExpandedBaseId((current) => current === id ? null : id);
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

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Bases</h2>
        <div className="action-row">
          <button onClick={() => void load({ q: submittedQ, page, pageSize, sortColumn, sortDirection })}>Refresh</button>
        </div>
      </div>
      <p className="action-help-note">
        Total Bases: {totalBases.toLocaleString()} · Total Building Pieces: {totalPieces.toLocaleString()} · Total Placeables: {totalPlaceables.toLocaleString()}
      </p>
      {canRefill && <><br /><p className="action-help-note">
        Refill writes fuel straight to the database. A running game server will not show the new fuel in-game until the map server restarts.
      </p></>}
      {refillResult && <p className="danger-note">{refillResult}</p>}
      <div className="action-row bases-search-row">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") submitSearch(); }}
          placeholder="Search name, type, or owner"
        />
        <button onClick={submitSearch}>Search</button>
        <button onClick={handleClearSearch} disabled={!q && !submittedQ}>Clear</button>
      </div>
      <DataTable
        rows={rows}
        columns={["base_id", "name", "base_type", "owner_name", "shared_with", "map", "generators", "piece_count", "placeable_count", "coordinates"]}
        columnLabels={{
          base_id: "ID",
          name: "Base Name",
          base_type: "Base Type",
          owner_name: "Owner",
          shared_with: "Shared With",
          map: "Map",
          generators: "Generators",
          piece_count: "Building Pieces",
          placeable_count: "Placeables",
          coordinates: "Coordinates"
        }}
        tableClassName="bases-table"
        headerTitles
        actionClassName="actions-column bases-actions-column"
        renderCell={renderBaseCell}
        action={(row) => {
          const base = row as BaseRow;
          const id = String(base.base_id);
          const refillable = canRefill && base.generatorDataAvailable && (Number(base.generatorCount) || 0) > 0;
          const refillTitle = !canRefill ? "Refill is unsupported on this database"
            : !base.generatorDataAvailable ? "Generator data is unavailable for this base"
            : refillable ? "Refill Generators" : "No generators at this base";
          return <span className="icon-toggle-group">
            <button className="icon-toggle-button" title={refillTitle} aria-label="Refill Generators" disabled={!refillable || refillingId === id} onClick={(event) => { event.stopPropagation(); void handleRefillGenerators(base); }}><Fuel size={16} /></button>
            <button className="icon-toggle-button" title="Download Base as Blueprint" aria-label="Download Base as Blueprint" disabled={downloadingId === id} onClick={(event) => { event.stopPropagation(); void handleDownloadBlueprint(base); }}><Download size={16} /></button>
          </span>;
        }}
        secondaryActionPosition="start"
        secondaryActionLabel=""
        secondaryActionClassName="bases-expand-column"
        secondaryAction={(row) => {
          const base = row as BaseRow;
          const id = String(base.base_id);
          const isExpanded = expandedBaseId === id;
          if (!base.generatorDataAvailable || !base.generatorCount) return null;
          const label = `${isExpanded ? "Collapse" : "Show"} generator details for ${base.name || `base ${id}`}`;
          return <button
            className="bases-expand-button"
            title={label}
            aria-label={label}
            aria-expanded={isExpanded}
            onClick={(event) => { event.stopPropagation(); toggleExpanded(id); }}
          >{isExpanded ? <ChevronUp size={14} className="bases-expand-chevron" /> : <ChevronDown size={14} className="bases-expand-chevron" />}</button>;
        }}
        sortColumn={sortColumn}
        sortDirection={sortDirection}
        onSort={handleSort}
        nonSortableColumns={["generators"]}
        rowKey={(row) => String(row.base_id)}
        onRowClick={(row) => toggleExpanded(String(row.base_id))}
        isRowExpanded={(row) => expandedBaseId === String(row.base_id)}
        renderExpandedRow={(row) => {
          const base = row as BaseRow;
          if (!base.generatorDataAvailable) return <p className="muted">Generator data is currently unavailable.</p>;
          const generators = base.generators ?? [];
          if (!generators.length) return <p className="muted">No generators built at this base.</p>;
          return (
            <div className="bases-generator-breakdown">
              {base.generatorUptimeMultiplier > 1 ? (
                <div className="bases-uptime-event" role="status">
                  <span className="bases-uptime-event-badge">{base.generatorUptimeMultiplier}× Uptime Event</span>
                  <small>Ends {formatEventThroughDate(base.generatorUptimeEventEndsAt)}</small>
                </div>
              ) : null}
              <p className="bases-generator-reserve-note" role="note">
                {QUEUED_RESERVE_EXPLANATION}
              </p>
              {generators.map((generator, index) => (
                <div className="bases-generator-group" key={`${generator.type}-${index}`}>
                  <div className="bases-generator-group-title">{generator.name}</div>
                  <dl className="bases-generator-stats">
                    <dt>Generators</dt>
                    <dd>{generator.generatorCount}</dd>
                    <dt>Fuel Cells <br />Queued</dt>
                    <dd>{generator.fuelCells} {generator.fuelName}{generator.fuelCells === 1 ? "" : "s"}</dd>
                    {!hasNoQueuedFuel(generator.unstockedCount, generator.generatorCount) ? (
                      <>
                        <dt>Lowest Queued <br />Reserve</dt>
                        <dd>{formatRuntime(Number(generator.runtimeSeconds) || 0)}</dd>
                      </>
                    ) : null}
                    {generator.unstockedCount ? (
                      <>
                        <dt>No queued fuel</dt>
                        <dd>{generator.unstockedCount} of {generator.generatorCount}</dd>
                      </>
                    ) : null}
                  </dl>
                </div>
              ))}
            </div>
          );
        }}
        emptyMessage="No bases have been found yet."
      />
      <div className="panel-title bases-pagination-footer">
        <p className="action-help-note">
          Showing {rangeStart}-{rangeEnd} of {totalCount} rows.
        </p>
        <div className="database-pagination-controls">
          <label className="compact-select">
            Rows
            <select value={String(pageSize)} onChange={(event) => changePageSize(Number(event.target.value))}>
              {BASES_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <button disabled={!hasPreviousPage} onClick={() => setPage(0)}>First</button>
          <button disabled={!hasPreviousPage} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted database-page-indicator">Page {page + 1} of {totalPages}</span>
          <button disabled={!hasNextPage} onClick={() => setPage(page + 1)}>Next</button>
          <button disabled={!hasNextPage} onClick={() => setPage(totalPages - 1)}>Last</button>
        </div>
      </div>
    </section>
  );
}
