import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { exchangeApi, type ExchangeItem, type ExchangeListing, type ExchangeOwner } from "../../api/exchange";
import { DataTable, type SortDirection } from "../../components/common/DataTable";

const COLUMNS = ["display_name", "quality_level", "category", "tier", "lowest_price", "total_stock", "listing_count"];
const COLUMN_LABELS: Record<string, string> = {
  display_name: "Item",
  quality_level: "Grade",
  category: "Category",
  tier: "Tier",
  lowest_price: "Lowest Price",
  total_stock: "Stock",
  listing_count: "Listings"
};

type ExchangeTableProps = {
  rows: ExchangeItem[];
  owner: ExchangeOwner;
  sortColumn?: string;
  sortDirection?: SortDirection;
  onSort?: (column: string) => void;
  emptyMessage?: string;
};

function itemKey(row: ExchangeItem) {
  return `${row.template_id}:${row.quality_level}`;
}

function fmt(value: number) {
  return Number(value || 0).toLocaleString();
}

function gradeLabel(quality: number) {
  return quality > 0 ? `Q${quality}` : "Standard";
}

function renderCell(row: Record<string, unknown>, column: string) {
  const item = row as ExchangeItem;
  if (column === "display_name") {
    return (
      <div className="exchange-item-cell">
        {item.icon
          ? <img className="exchange-item-icon" src={item.icon} alt="" loading="lazy" />
          : <span className="exchange-item-icon exchange-item-icon-empty" aria-hidden="true" />}
        <span className="exchange-item-text">
          <span className="exchange-item-name">{item.display_name || item.template_id}</span>
          <span className="exchange-item-template" title={item.template_id}>{item.template_id}</span>
        </span>
      </div>
    );
  }
  if (column === "quality_level") return gradeLabel(item.quality_level);
  if (column === "category") return item.category ? String(item.category) : <span className="muted">—</span>;
  if (column === "tier") return item.tier ? `T${item.tier}` : <span className="muted">—</span>;
  if (column === "lowest_price") return <span className="exchange-price">{fmt(item.lowest_price)}</span>;
  if (column === "total_stock") return fmt(item.total_stock);
  if (column === "listing_count") return fmt(item.listing_count);
  const value = row[column];
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function ListingRows({ listings }: { listings: ExchangeListing[] }) {
  if (!listings.length) return <p className="muted">No active listings for this item.</p>;
  return (
    <table className="exchange-listings-table">
      <thead>
        <tr>
          <th>Seller</th>
          <th className="exchange-num">Price</th>
          <th className="exchange-num">Qty</th>
          <th>Grade</th>
        </tr>
      </thead>
      <tbody>
        {listings.map((listing) => (
          <tr key={listing.order_id}>
            <td>
              <span className="exchange-seller-name">{listing.owner_name}</span>
              <span className={`exchange-owner-badge exchange-owner-${listing.owner_type}`}>{listing.owner_type}</span>
            </td>
            <td className="exchange-num exchange-price">{fmt(listing.price)}</td>
            <td className="exchange-num">{fmt(listing.stock)}</td>
            <td>{gradeLabel(listing.quality)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ExchangeTable({ rows, owner, sortColumn, sortDirection, onSort, emptyMessage = "No market listings found." }: ExchangeTableProps) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Listings are cached per (owner, item) because the owner filter changes which
  // sellers are returned; keying by item alone would show a stale set after the
  // filter changes.
  const [listings, setListings] = useState<Record<string, ExchangeListing[]>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    if (expandedKey && !rows.some((row) => itemKey(row) === expandedKey)) setExpandedKey(null);
  }, [expandedKey, rows]);

  async function toggle(row: ExchangeItem) {
    const key = itemKey(row);
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    const cacheKey = `${owner}:${key}`;
    if (listings[cacheKey]) return;
    setLoadingKey(key);
    setErrorKey(null);
    try {
      const result = await exchangeApi.listings(row.template_id, row.quality_level, owner);
      setListings((current) => ({ ...current, [cacheKey]: result.rows || [] }));
    } catch {
      setErrorKey(key);
    } finally {
      setLoadingKey((current) => (current === key ? null : current));
    }
  }

  return (
    <DataTable
      rows={rows}
      columns={COLUMNS}
      columnLabels={COLUMN_LABELS}
      tableClassName="exchange-table"
      wrapClassName="exchange-table-wrap"
      headerTitles
      renderCell={renderCell}
      sortColumn={sortColumn}
      sortDirection={sortDirection}
      onSort={onSort}
      secondaryActionPosition="start"
      secondaryActionLabel=""
      secondaryActionClassName="exchange-expand-column"
      secondaryAction={(row) => {
        const item = row as ExchangeItem;
        const key = itemKey(item);
        const isExpanded = expandedKey === key;
        const label = `${isExpanded ? "Hide" : "Show"} listings for ${item.display_name || item.template_id}`;
        return (
          <button className="exchange-expand-button" title={label} aria-label={label} aria-expanded={isExpanded} onClick={(event) => { event.stopPropagation(); void toggle(item); }}>
            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        );
      }}
      rowKey={(row) => itemKey(row as ExchangeItem)}
      onRowClick={(row) => void toggle(row as ExchangeItem)}
      isRowExpanded={(row) => expandedKey === itemKey(row as ExchangeItem)}
      renderExpandedRow={(row) => {
        const item = row as ExchangeItem;
        const key = itemKey(item);
        return (
          <div className="exchange-listings">
            <p className="exchange-listings-header">{item.display_name || item.template_id} · {gradeLabel(item.quality_level)} · {item.listing_count} listing{item.listing_count === 1 ? "" : "s"}</p>
            {loadingKey === key
              ? <p className="muted">Loading listings…</p>
              : errorKey === key
                ? <p className="muted">Could not load listings. Click again to retry.</p>
                : <ListingRows listings={listings[`${owner}:${key}`] || []} />}
          </div>
        );
      }}
      emptyMessage={emptyMessage}
    />
  );
}
