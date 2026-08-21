import { useEffect, useRef, useState } from "react";
import { exchangeApi, type ExchangeTransaction, type ExchangeTransactionParty } from "../../api/exchange";
import { exchangeDisplayLabel } from "./display";

const PAGE_SIZES = [25, 50, 100, 200] as const;
const TIME_OPTIONS = [
  { value: 24, label: "Last 24 Hours" },
  { value: 168, label: "Last 7 Days" },
  { value: 720, label: "Last 30 Days" },
  { value: 2160, label: "Last 90 Days" },
  { value: 0, label: "All Recorded Time" }
] as const;
const PARTY_OPTIONS: { value: ExchangeTransactionParty; label: string }[] = [
  { value: "all", label: "All Parties" },
  { value: "player", label: "Players" },
  { value: "bot", label: "Market Bots" },
  { value: "npc", label: "NPC Broker" }
];

type Props = { onError: (text: string) => void };

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function wholeNumber(value: string) {
  try { return BigInt(value || "0").toLocaleString(); } catch { return "0"; }
}

function transactionTotal(row: ExchangeTransaction) {
  try { return (BigInt(row.units || "0") * BigInt(row.unitPrice || "0")).toLocaleString(); } catch { return "0"; }
}

function capturedTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function partyLabel(row: ExchangeTransaction) {
  if (row.ownerName) return row.ownerName;
  if (row.ownerId) return `Owner ${row.ownerId}`;
  return row.partyType === "npc" ? "NPC Broker" : "Unknown";
}

export function ExchangeTransactionsTab({ onError }: Props) {
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [hours, setHours] = useState(168);
  const [party, setParty] = useState<ExchangeTransactionParty>("all");
  const [exchangeId, setExchangeId] = useState("");
  const [submittedExchangeId, setSubmittedExchangeId] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [rows, setRows] = useState<ExchangeTransaction[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [summary, setSummary] = useState({ events: 0, units: "0", solari: "0", firstCapturedAt: null as string | null });
  const [retentionDays, setRetentionDays] = useState(0);
  const [supported, setSupported] = useState(true);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const requestId = useRef(0);

  useEffect(() => { setPage(0); }, [submittedQ, submittedExchangeId, hours, party, pageSize]);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    onError("");
    exchangeApi.transactions({ q: submittedQ, exchangeId: submittedExchangeId, hours, party, page, pageSize })
      .then((result) => {
        if (requestId.current !== currentRequest) return;
        setRows(result.rows || []);
        setTotalCount(result.totalCount || 0);
        setSummary(result.summary || { events: 0, units: "0", solari: "0", firstCapturedAt: null });
        setRetentionDays(result.retentionDays || 0);
        setSupported(result.capabilities?.exchangeHistory !== false);
        setReason(result.reason || "");
      })
      .catch((error) => {
        if (requestId.current === currentRequest) onError(errorText(error));
      })
      .finally(() => {
        if (requestId.current === currentRequest) setLoading(false);
      });
  }, [submittedQ, submittedExchangeId, hours, party, page, pageSize, refreshToken, onError]);

  function submitFilters() {
    setSubmittedQ(q.trim());
    setSubmittedExchangeId(exchangeId.trim());
    setRefreshToken((value) => value + 1);
  }

  function clearFilters() {
    setQ("");
    setSubmittedQ("");
    setExchangeId("");
    setSubmittedExchangeId("");
    setHours(168);
    setParty("all");
    setRefreshToken((value) => value + 1);
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rangeStart = totalCount ? page * pageSize + 1 : 0;
  const rangeEnd = totalCount ? rangeStart + rows.length - 1 : 0;

  return (
    <div className="exchange-transactions">
      <p className="action-help-note">
        Completed-order activity recorded from the game database. Recording begins when this Console version starts; existing historical rows are not presented as new transactions.
        {retentionDays > 0 ? ` Records older than ${retentionDays.toLocaleString()} days are removed automatically.` : " Records are retained until the database is restored or manually managed."}
      </p>

      <div className="exchange-transaction-summary" aria-label="Transaction Summary">
        <div><span>Recorded Events</span><strong>{summary.events.toLocaleString()}</strong></div>
        <div><span>Units</span><strong>{wholeNumber(summary.units)}</strong></div>
        <div><span>Recorded Value</span><strong>{wholeNumber(summary.solari)} Solari</strong></div>
      </div>

      <div className="action-row exchange-search-row exchange-transaction-filters">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") submitFilters(); }}
          placeholder="Search Item or Owner"
          aria-label="Search Transactions"
        />
        <select aria-label="Transaction Period" value={hours} onChange={(event) => setHours(Number(event.target.value))}>
          {TIME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select aria-label="Transaction Party" value={party} onChange={(event) => setParty(event.target.value as ExchangeTransactionParty)}>
          {PARTY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <input
          className="exchange-id-filter"
          value={exchangeId}
          inputMode="numeric"
          onChange={(event) => setExchangeId(event.target.value.replace(/\D/g, "").slice(0, 19))}
          onKeyDown={(event) => { if (event.key === "Enter") submitFilters(); }}
          placeholder="Exchange ID"
          aria-label="Exchange ID"
        />
        <button onClick={submitFilters}>Apply</button>
        <button onClick={clearFilters}>Clear</button>
        <button onClick={() => { setPage(0); setSubmittedQ(q.trim()); setSubmittedExchangeId(exchangeId.trim()); setRefreshToken((value) => value + 1); }}>Refresh</button>
      </div>

      {!supported && <p className="action-help-note">{reason || "Transaction recording is unsupported by the detected database schema."}</p>}
      {supported && loading && !rows.length && <div className="loading-panel"><span className="spinner" aria-hidden="true" /><strong className="loading-dots">Loading Transactions</strong></div>}
      {supported && !loading && !rows.length && <p className="empty-state">No recorded transactions match these filters.</p>}
      {supported && rows.length > 0 && (
        <div className="table-wrap exchange-table-wrap">
          <table className="data-table exchange-transaction-table">
            <thead><tr><th>Time</th><th>Item</th><th className="exchange-num">Units</th><th className="exchange-num">Unit Price</th><th className="exchange-num">Total</th><th>Party</th><th>Exchange</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} title={`Completion type ${row.completionType} · Order ${row.orderId}`}>
                  <td className="exchange-transaction-time">{capturedTime(row.capturedAt)}</td>
                  <td><div className="exchange-item-cell">
                    {row.icon ? <img className="exchange-item-icon" src={row.icon} alt="" /> : <span className="exchange-item-icon exchange-item-icon-empty" />}
                    <span className="exchange-item-text"><span className="exchange-item-name">{exchangeDisplayLabel(row.displayName)}</span><span className="exchange-item-template">{row.templateId}{row.qualityLevel ? ` · Grade ${row.qualityLevel}` : ""}</span></span>
                  </div></td>
                  <td className="exchange-num">{wholeNumber(row.units)}</td>
                  <td className="exchange-num exchange-price">{wholeNumber(row.unitPrice)}</td>
                  <td className="exchange-num exchange-price">{transactionTotal(row)}</td>
                  <td><span className="exchange-transaction-party-name">{partyLabel(row)}</span><span className={`exchange-owner-badge exchange-owner-${row.partyType}`}>{exchangeDisplayLabel(row.partyType)}</span></td>
                  <td>{row.exchangeId || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {supported && (
        <div className="panel-title exchange-pagination-footer">
          <p className="action-help-note">Showing {rangeStart}-{rangeEnd} of {totalCount.toLocaleString()} events.</p>
          <div className="database-pagination-controls">
            <label className="compact-select">Rows
              <select aria-label="Transaction Rows" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
                {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <button disabled={page === 0} onClick={() => setPage(0)}>First</button>
            <button disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</button>
            <span className="muted database-page-indicator">Page {page + 1} of {totalPages}</span>
            <button disabled={page + 1 >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</button>
            <button disabled={page + 1 >= totalPages} onClick={() => setPage(totalPages - 1)}>Last</button>
          </div>
        </div>
      )}
    </div>
  );
}
