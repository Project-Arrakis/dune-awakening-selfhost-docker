import { type ReactNode, useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, FileJson, FolderOpen, Upload } from "lucide-react";
import { ApiError } from "../../api/client";
import { baseBackupsApi, type BaseBackupFailureBody, type BaseBackupRow, type BaseBackupVersion } from "../../api/baseBackups";
import { playersApi } from "../../api/players";
import { DataTable, useSortableRows } from "../../components/common/DataTable";
import { TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { formatUiSentence } from "../../lib/display";

type ConfirmOptions = {
  title?: string;
  confirmLabel?: string;
  warning?: string;
  danger?: boolean;
  details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[];
};

type BaseBackupsViewProps = {
  onError: (text: string) => void;
  confirmAction: (message: string, options?: ConfirmOptions) => Promise<boolean>;
  // Player pawn id. Set when embedded in a player's admin view: the list is
  // that player's backups and imports go to them.
  playerId?: string;
  playerName?: string;
  // Whether that player is online: the backup only appears after they relog.
  playerOnline?: boolean;
  embedded?: boolean;
  // The Bases page's "Bases | Base Backups" toggle, rendered in the title.
  viewSwitch?: ReactNode;
};

type ViewResult = {
  status: "succeeded" | "failed";
  title: string;
  message: string;
  details?: string;
  // Shown as visible text, never hidden in technical details.
  warnings?: string[];
  // Timeouts and results with warnings stay on screen until dismissed or
  // replaced, so an admin who looked away still reads them.
  persistent?: boolean;
};

type ImportTarget = { pawnId: string; name: string; online: boolean };

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function failureBody(error: unknown): BaseBackupFailureBody {
  return error instanceof ApiError ? error.body as BaseBackupFailureBody : {};
}

function formatMs(value: unknown) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "unknown";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

function mapLabel(map: string) {
  return map ? map.replace(/([a-z])([A-Z])/g, "$1 $2") : "—";
}

function timeoutResult(operation: "export" | "import", error: unknown): ViewResult {
  const body = failureBody(error);
  return {
    status: "failed",
    title: operation === "import" ? "Import Timed Out" : "Export Timed Out",
    message: body.error || errorText(error),
    details: [
      `Step: ${body.step || "unknown"}`,
      `Elapsed: ${formatMs(body.elapsedMs)}`,
      `Limit: ${formatMs(body.limitMs)} (${body.timeoutKind === "client_timeout" ? "console query limit" : "database statement limit"})`
    ].join("\n"),
    persistent: true
  };
}

function versionDetails(file?: BaseBackupVersion, server?: BaseBackupVersion) {
  const build = (version?: BaseBackupVersion) => version?.build || version?.steamBuildId || "unknown";
  return [
    { label: "File game build", value: build(file), tone: "danger" as const },
    { label: "This server's build", value: build(server), tone: "accent" as const },
    { label: "File database patches", value: String(file?.appliedPatchesCount ?? "unknown") },
    { label: "This server's database patches", value: String(server?.appliedPatchesCount ?? "unknown") }
  ];
}

async function saveDownload(response: Response, fallbackName: string) {
  const disposition = response.headers.get("content-disposition") || "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] || fallbackName;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function BaseBackupsView({ onError, confirmAction, playerId = "", playerName = "", playerOnline = false, embedded = false, viewSwitch }: BaseBackupsViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<BaseBackupRow[]>([]);
  const [supported, setSupported] = useState(true);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportingId, setExportingId] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ViewResult | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  // Server-wide view only: the receiving player is picked by search.
  const [target, setTarget] = useState<ImportTarget | null>(null);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<ImportTarget[]>([]);

  useEffect(() => { void load(); }, [playerId]);

  useEffect(() => {
    if (!result || result.persistent) return undefined;
    const timeout = window.setTimeout(() => setResult(null), 10400);
    return () => window.clearTimeout(timeout);
  }, [result]);

  function showResult(next: ViewResult) {
    onError("");
    setResult(next);
  }

  async function load() {
    setLoading(true);
    try {
      const response = await baseBackupsApi.list(playerId);
      setSupported(response.supported !== false);
      setMissing(response.missing || []);
      setRows(response.rows || []);
    } catch (error) {
      showResult({ status: "failed", title: "Base Backups Could Not Be Loaded", message: errorText(error) });
    } finally {
      setLoading(false);
    }
  }

  async function handleExport(row: BaseBackupRow) {
    setExportingId(row.id);
    try {
      const response = await baseBackupsApi.download(row.id);
      await saveDownload(response, `base-backup_${row.id}.json`);
      showResult({ status: "succeeded", title: "Base Backup Exported", message: `${row.name} was downloaded.` });
    } catch (error) {
      if (failureBody(error).code === "timeout") showResult(timeoutResult("export", error));
      else showResult({ status: "failed", title: "Base Backup Export Failed", message: errorText(error) });
    } finally {
      setExportingId(null);
    }
  }

  function clearFile() {
    setImportFile(null);
    setFileInputKey((current) => current + 1);
  }

  const importTarget: ImportTarget | null = embedded
    ? (playerId ? { pawnId: playerId, name: playerName || "this player", online: playerOnline } : null)
    : target;

  async function submitImport(file: File, receiver: ImportTarget, allowVersionMismatch: boolean): Promise<void> {
    try {
      const response = await baseBackupsApi.importFile(file, receiver.pawnId, allowVersionMismatch);
      const { counts } = response;
      clearFile();
      showResult({
        status: "succeeded",
        title: "Base Backup Imported",
        message: `${response.name || "The base"} was added to ${receiver.name}'s base backups: ${counts.pieces} pieces, ${counts.placeables} placeables and ${counts.items} stored items. They can redeploy it with the in-game base backup tool.`,
        warnings: response.warnings?.length ? response.warnings : undefined,
        persistent: Boolean(response.warnings?.length)
      });
      await load();
    } catch (error) {
      const body = failureBody(error);
      if (body.code === "version_mismatch" && !allowVersionMismatch) {
        const proceed = await confirmAction(
          `${file.name} was exported from a different game version than this server is running.`,
          {
            title: "Game Version Mismatch",
            confirmLabel: "Import Anyway",
            danger: true,
            warning: "The game's base backup data may have changed between these versions. Importing anyway can leave a backup that fails to redeploy or loses parts of the base.",
            details: versionDetails(body.file, body.server)
          });
        if (proceed) await submitImport(file, receiver, true);
        return;
      }
      if (body.code === "timeout") showResult(timeoutResult("import", error));
      else showResult({ status: "failed", title: "Base Backup Import Failed", message: errorText(error) });
    }
  }

  async function handleImport() {
    if (!importFile || !importTarget) return;
    const confirmed = await confirmAction(
      `Import ${importFile.name} as a base backup for ${importTarget.name}? The backup, its pieces and its stored items are created for them; they can then redeploy it with the in-game base backup tool.`,
      {
        title: "Import Base Backup",
        confirmLabel: "Import",
        warning: importTarget.online ? `${importTarget.name} is online and must log out and back in before the backup appears in their base backup tool.` : undefined
      });
    if (!confirmed) return;
    setResult(null);
    setImporting(true);
    try {
      await submitImport(importFile, importTarget, false);
    } finally {
      setImporting(false);
    }
  }

  // Explicit submit, never search-as-you-type: this queries the server.
  async function submitSearch() {
    setSearching(true);
    try {
      const response = await playersApi.list({ q: query, pageSize: 25 });
      setCandidates((response.rows || []).map((row) => {
        const pawnId = String(row.actor_id ?? row.player_pawn_id ?? "");
        return {
          pawnId,
          name: String(row.character_name || `Player ${pawnId}`),
          online: String(row.online_status || "").toLowerCase() === "online"
        };
      }).filter((candidate) => candidate.pawnId));
      setSearched(true);
    } catch (error) {
      showResult({ status: "failed", title: "Player Search Failed", message: errorText(error) });
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setQuery("");
    setCandidates([]);
    setSearched(false);
  }

  function chooseTarget(candidate: ImportTarget) {
    setTarget(candidate);
    clearSearch();
  }

  const busy = importing || exportingId !== null;
  const sort = useSortableRows(rows as unknown as Record<string, unknown>[]);
  const columns = embedded
    ? ["name", "map", "pieces", "placeables", "items"]
    : ["ownerName", "name", "map", "pieces", "placeables", "items"];
  const Heading = embedded ? "h4" : "h2";

  return <section className={embedded ? "playerAdmin_box base-backups-view" : "panel base-backups-view"}>
    <div className="panel-title">
      <div>
        <Heading>Base Backups</Heading>
        {embedded && <p className="playerAdmin_note">Bases {playerName || "this player"} picked up with the in-game base backup tool.</p>}
      </div>
      {viewSwitch}
      <div className="action-row">
        <button disabled={loading || busy} onClick={() => void load()}>Refresh</button>
      </div>
    </div>

    {result && <div className={`result-panel home-task-result result-${result.status === "succeeded" ? "ok" : "fail"}${result.persistent ? " result-persistent" : ""}`} aria-live="polite">
      <strong>{result.title}</strong>
      <p>{formatUiSentence(result.message)}</p>
      {/* Technical details are debug-only by default; a timeout's step and
          which limit fired are what the admin needs, so they opt in. */}
      {result.warnings && result.warnings.length > 0 && <div className="home-task-result-warnings">
        {result.warnings.map((warning) => <p key={warning}>
          <AlertTriangle size={14} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {formatUiSentence(warning)}
        </p>)}
      </div>}
      {result.details && <TechnicalDetails text={result.details} className={result.persistent ? "base-backup-result-details" : ""} />}
      {result.persistent && <button type="button" onClick={() => setResult(null)}>Dismiss</button>}
    </div>}

    {!supported ? <div className="result-panel result-fail">
      <strong>Base Backups Unavailable</strong>
      <p>This game database does not provide the base backup tables and functions needed for export and import.</p>
      {missing.length > 0 && <TechnicalDetails text={missing.join("\n")} />}
    </div> : <>
      <div className="blueprint-import-row base-backup-import-row">
        <label className="blueprint-file-field">
          <span>Base Backup File</span>
          <span className="blueprint-file-control">
            <FileJson size={18} />
            <span>{importFile ? importFile.name : "Select a JSON file"}</span>
          </span>
          <input ref={fileInputRef} key={fileInputKey} type="file" accept=".json,application/json" disabled={busy} aria-label="Base backup file" onChange={(event) => setImportFile(event.target.files?.[0] || null)} />
        </label>
        <button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()}>
          <FolderOpen size={16} /> Select
        </button>
        <button disabled={!importFile || !importTarget || busy} onClick={() => void handleImport()}>
          <Upload size={16} /> {importing ? "Importing..." : "Import"}
        </button>
        {importFile && <button disabled={busy} onClick={clearFile}>Clear</button>}
      </div>

      {!embedded && <div className="base-backup-target">
        {target ? <p className="base-backup-target-chosen">
          <span>Importing to <strong>{target.name}</strong>{target.online ? " (online)" : ""}</span>
          <button type="button" disabled={busy} onClick={() => setTarget(null)}>Change</button>
        </p> : <>
          <div className="action-row bases-permissions-search-row">
            <input value={query} placeholder="Search for the receiving player" aria-label="Search for the receiving player" disabled={busy}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void submitSearch(); }} />
            <button disabled={searching || busy} onClick={() => void submitSearch()}>Search</button>
            <button disabled={!query && !searched} onClick={clearSearch}>Clear</button>
          </div>
          {searched && !candidates.length && <p className="muted">No players matched that search.</p>}
          {candidates.length > 0 && <ul className="bases-permissions-candidates">
            {candidates.map((candidate) => <li key={candidate.pawnId}>
              <span>{candidate.name}{candidate.online ? " (online)" : ""}</span>
              <button type="button" onClick={() => chooseTarget(candidate)} aria-label={`Import to ${candidate.name}`}>Choose</button>
            </li>)}
          </ul>}
        </>}
      </div>}

      <p className="action-help-note">
        An export includes the base's pieces, placeables, land claim and everything stored in it. Importing creates a new backup for the receiving player, who redeploys it with the in-game base backup tool. The original backup is not changed.
      </p>

      <DataTable
        rows={sort.sortedRows}
        emptyMessage={loading ? "Loading base backups..." : "No base backups found. A base appears here after a player picks it up with the in-game base backup tool."}
        columns={columns}
        columnLabels={{ ownerName: "Owner", name: "Backup" }}
        tableClassName="base-backups-table"
        actionClassName="actions-column"
        renderCell={(row, column) => {
          const backup = row as unknown as BaseBackupRow;
          if (column === "ownerName") return backup.ownerName || "—";
          if (column === "name") return <span title={backup.rawName || backup.name}>{backup.name}</span>;
          if (column === "map") return mapLabel(backup.map);
          const value = Number(row[column] || 0);
          return value > 0 ? value.toLocaleString() : "—";
        }}
        action={(row) => {
          const backup = row as unknown as BaseBackupRow;
          return <span className="icon-toggle-group">
            <button className="icon-toggle-button success" title="Export base backup" aria-label={`Export ${backup.name}`} disabled={busy} onClick={(event) => { event.stopPropagation(); void handleExport(backup); }}><Download size={16} /></button>
          </span>;
        }}
        sortColumn={sort.sortColumn}
        sortDirection={sort.sortDirection}
        onSort={sort.onSort}
        rowKey={(row) => String(row.id)}
      />
    </>}
  </section>;
}
