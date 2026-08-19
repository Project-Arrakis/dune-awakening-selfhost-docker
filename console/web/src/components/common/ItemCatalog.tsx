import { useEffect, useMemo, useRef, useState } from "react";
import { Grid2X2, List } from "lucide-react";
import { adminApi } from "../../api/admin";
import { titleCase } from "../../lib/display";
import { KeyValueGrid } from "./DisplayPrimitives";

export type CatalogItem = {
  name: string;
  id: string;
  itemId?: string;
  category?: string;
  source?: string;
  image?: string;
  group?: string;
};

// Shared module-level cache: the full catalog (~2,600 items) is identical
// for every consumer within one page load, and both ItemCatalogSelector and
// ItemCatalogCombobox below fetch it independently -- without this, opening
// a container's contents overlay (which renders the Give and Fill comboboxes
// side by side) would issue two redundant full-catalog requests every time.
let cachedCatalog: CatalogItem[] | null = null;
let cachedCatalogPromise: Promise<CatalogItem[]> | null = null;

async function loadFullCatalog(): Promise<CatalogItem[]> {
  if (cachedCatalog) return cachedCatalog;
  if (!cachedCatalogPromise) {
    cachedCatalogPromise = adminApi.itemCatalog("", 10000).then((result) => {
      cachedCatalog = (result.rows || []).map((item) => ({ ...item, id: item.itemId || item.id }));
      return cachedCatalog;
    });
  }
  return cachedCatalogPromise;
}

export function ItemCatalogSelector({ label = "Select Item", selected, onSelect, placeholder = "Filter loaded item catalog" }: { label?: string; selected: CatalogItem | null; onSelect: (item: CatalogItem | null) => void; placeholder?: string }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  async function load() {
    setLoading(true);
    try {
      const result = await adminApi.itemCatalog("", 10000);
      setItems((result.rows || []).map((item) => ({ ...item, id: item.itemId || item.id })));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const categoryCounts = items.reduce<Record<string, number>>((counts, item) => {
    const key = item.category || "uncategorized";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const categories = ["all", ...Object.keys(categoryCounts).sort()];
  const filteredItems = items.filter((item) => {
    const matchesCategory = category === "all" || item.category === category;
    const haystack = `${item.name} ${item.id} ${item.category || ""} ${item.source || ""}`.toLowerCase();
    return matchesCategory && (!query.trim() || haystack.includes(query.trim().toLowerCase()));
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id, undefined, { sensitivity: "base" }));

  return <div className="catalog-selector">
    <div className="catalog-filter-row">
      <label className="compact-select catalog-category-select">Choose Category
        <select value={category} onChange={(event) => { setCategory(event.target.value); onSelect(null); }}>
          {categories.map((option) => <option key={option} value={option}>{option === "all" ? `All Categories (${items.length})` : `${titleCase(option)} (${categoryCounts[option] || 0})`}</option>)}
        </select>
      </label>
      <div className="catalog-search-tools">
        <input className="catalog-filter-input" aria-label="Filter Items" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} />
        <div className="catalog-view-toggle" aria-label="Item catalog view">
          <button type="button" className={viewMode === "grid" ? "active" : ""} title="Grid view" aria-label="Grid view" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}><Grid2X2 size={17} /></button>
          <button type="button" className={viewMode === "list" ? "active" : ""} title="List view" aria-label="List view" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}><List size={18} /></button>
        </div>
      </div>
    </div>
    <div className={`catalog-item-picker ${viewMode === "list" ? "list-view" : "grid-view"}`} aria-label={label}>
      {loading ? <div className="catalog-loading">Loading Items...</div> : viewMode === "list" ? <table className="catalog-item-table">
        <thead><tr><th>Preview</th><th>Item Name</th><th>Item ID</th><th>Category</th><th>Source</th></tr></thead>
        <tbody>{filteredItems.map((item) => {
          const active = selected?.id === item.id && selected?.name === item.name;
          const fullName = catalogItemName(item);
          return <tr className={active ? "active" : ""} key={`${item.id}-${item.name}-${item.source}`} title={fullName} onClick={() => onSelect(item)}>
            <td><CatalogItemThumb item={item} small /></td>
            <td className="catalog-item-name-cell">{fullName}</td>
            <td>{item.id}</td>
            <td>{item.category ? titleCase(item.category) : ""}</td>
            <td>{item.source || ""}</td>
          </tr>;
        })}</tbody>
      </table> : filteredItems.map((item) => {
        const active = selected?.id === item.id && selected?.name === item.name;
        const fullName = catalogItemName(item);
        return <button type="button" className={`catalog-item-option ${active ? "active" : ""}`} key={`${item.id}-${item.name}-${item.source}`} title={fullName} onClick={() => onSelect(item)}>
          <CatalogItemThumb item={item} />
          <span>
            <strong>{fullName}</strong>
            <small>{item.id}{item.category ? ` - ${titleCase(item.category)}` : ""}</small>
          </span>
        </button>;
      })}
      {!loading && !filteredItems.length && <div className="catalog-empty">No items match your filters.</div>}
    </div>
    {selected && <div className="catalog-selected-item">
      <CatalogItemThumb item={selected} large />
      <KeyValueGrid items={[["Item Name", selected.name], ["Item ID", selected.id], ["Category", selected.category ? titleCase(selected.category) : ""], ["Source", selected.source || ""]]} />
    </div>}
  </div>;
}

// Compact type-to-search dropdown, distinct from ItemCatalogSelector above:
// that component is a full-page category/grid browser (Player Give Items),
// too heavy to stack two-of inside an already-dense modal like the Base
// Inventory contents overlay's Give + Fill panels. This renders as a single
// text input with a short, keyboard-navigable results list -- the same
// underlying catalog data and the same real in-game display name
// (item.name, e.g. "Fuel Cell" for template id "Oil"), just a lighter
// presentation. Found during manual UI review of PR #349 (issue #347): the
// prior plain "Item name or ID" text input required already knowing the
// exact template id or exact in-game name, and offered no way to discover
// what's actually in the catalog.
//
// Search and the results list are both name-only -- the catalog id
// (template id, e.g. "Oil") is a database/backend concept a player never
// sees in-game and is never typed here, so it is neither searched nor
// displayed. Give/Fill still submit `itemId` under the hood (the exact
// catalog id of whichever item was chosen), just never as something the
// player types or reads.
//
// `filterGroups`, when set, restricts results to catalog items whose
// `group` field is in the set -- used by the Fill panel to show only
// raw/refined resources and components, mirroring FILLABLE_GROUPS
// (adminCatalog.js) so a player never sees an option the server would
// reject anyway.
const MAX_COMBOBOX_RESULTS = 40;

export function ItemCatalogCombobox({
  value,
  onChange,
  filterGroups,
  ariaLabel,
  placeholder = "Type to search items…",
  disabled = false
}: {
  value: CatalogItem | null;
  onChange: (item: CatalogItem | null) => void;
  filterGroups?: Set<string>;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [query, setQuery] = useState(value?.name || "");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listId = useMemo(() => `item-combobox-list-${Math.random().toString(36).slice(2)}`, []);

  useEffect(() => {
    let cancelled = false;
    void loadFullCatalog().then((loaded) => { if (!cancelled) setItems(loaded); });
    return () => { cancelled = true; };
  }, []);

  // Keeps the visible text in sync when a parent clears the selection (e.g.
  // after a successful give/fill resets the form) without fighting the
  // user's own typing the rest of the time -- only reacts to value becoming
  // null/changing identity from outside, not to local query edits.
  useEffect(() => {
    setQuery(value?.name || "");
  }, [value]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const pool = filterGroups ? items.filter((item) => item.group && filterGroups.has(item.group)) : items;
  const term = query.trim().toLowerCase();
  const results = (term
    ? pool.filter((item) => item.name.toLowerCase().includes(term))
    : pool
  ).slice(0, MAX_COMBOBOX_RESULTS);

  function choose(item: CatalogItem) {
    onChange(item);
    setQuery(item.name);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      if (results[highlighted]) {
        event.preventDefault();
        choose(results[highlighted]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return <div className="item-combobox" ref={containerRef}>
    <input
      type="text"
      role="combobox"
      aria-expanded={open}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-label={ariaLabel}
      className="item-combobox-input"
      value={query}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => {
        setQuery(event.target.value);
        setHighlighted(0);
        setOpen(true);
        // Typing after a selection un-commits it -- the previously chosen
        // item's id must never be submitted alongside now-different text,
        // which would silently give/fill the wrong item.
        if (value) onChange(null);
      }}
      onFocus={() => setOpen(true)}
      onKeyDown={handleKeyDown}
    />
    {open && <ul className="item-combobox-list" id={listId} role="listbox">
      {results.map((item, index) => (
        <li
          key={item.id}
          role="option"
          aria-selected={index === highlighted}
          className={index === highlighted ? "highlighted" : ""}
          onMouseDown={(event) => { event.preventDefault(); choose(item); }}
          onMouseEnter={() => setHighlighted(index)}
        >
          <CatalogItemThumb item={item} small />
          <span>
            <strong>{item.name}</strong>
            {item.category && <small>{titleCase(item.category)}</small>}
          </span>
        </li>
      ))}
      {results.length === 0 && <li className="item-combobox-empty" aria-disabled="true">
        {term ? "No matching items." : "Start typing to search…"}
      </li>}
    </ul>}
  </div>;
}

export function CatalogItemThumb({ item, large = false, small = false }: { item: CatalogItem; large?: boolean; small?: boolean }) {
  const fallback = "/images/items/image-unavailable.png";
  const src = item.image || `/images/items/${encodeURIComponent(item.itemId || item.id)}.png`;
  const [imageSrc, setImageSrc] = useState(src);
  useEffect(() => {
    setImageSrc(src);
  }, [src]);
  return <div className={large ? "catalog-item-preview large" : small ? "catalog-item-preview small" : "catalog-item-preview"}>
    <img src={imageSrc} alt="" onError={() => { if (imageSrc !== fallback) setImageSrc(fallback); }} />
  </div>;
}

export function normalizeItemGrade(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(5, Math.trunc(numeric)));
}

export function itemGrade(item: { quality?: unknown; grade?: unknown; durability?: unknown }) {
  return normalizeItemGrade(item.quality ?? item.grade ?? item.durability ?? 0);
}

export function grantItemDurability() {
  return 1;
}

export function catalogItemMinimumGrade(item?: { itemId?: string; id?: string; source?: string; category?: string } | null) {
  const id = String(item?.itemId || item?.id || "");
  const source = String(item?.source || "").toLowerCase();
  const category = String(item?.category || "").toLowerCase();
  return source.includes("augment") || category.includes("augment") || /^T\d+_Augment_/i.test(id) ? 1 : 0;
}

export function catalogItemIsSchematic(item?: { itemId?: string; id?: string; source?: string; category?: string } | null) {
  const id = String(item?.itemId || item?.id || "");
  const source = String(item?.source || "").toLowerCase();
  const category = String(item?.category || "").toLowerCase();
  return category === "schematics" || source === "schematics" || /^schematic(pattern|_)/i.test(id) || /_schematic$/i.test(id) || /schematic$/i.test(id);
}

export function packageItemTextLine(item: { itemName?: string; itemId?: string; quantity?: unknown; quality?: unknown; grade?: unknown; durability?: unknown; augments?: string[]; augmentQuality?: unknown }) {
  const augments = Array.isArray(item.augments) && item.augments.length ? item.augments.join("|") : "";
  const augmentQuality = augments ? Math.max(1, Math.min(5, normalizeItemGrade(item.augmentQuality ?? 1) || 1)) : "";
  return `${item.itemId || item.itemName || ""},${Number(item.quantity) || 1},${itemGrade(item)},${augments},${augmentQuality}`;
}

export function ItemGradeSelect({ value, onChange, minGrade = 0, disabled = false, emptyWhenDisabled = false }: { value: string; onChange: (value: string) => void; minGrade?: number; disabled?: boolean; emptyWhenDisabled?: boolean }) {
  const min = Math.max(0, Math.min(5, Math.trunc(Number(minGrade) || 0)));
  const selected = Math.max(min, normalizeItemGrade(value));
  const selectedValue = disabled && emptyWhenDisabled ? "" : String(selected);
  return <select className="package-item-durability-input" value={selectedValue} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    {emptyWhenDisabled && <option value=""></option>}
    {[0, 1, 2, 3, 4, 5].filter((grade) => grade >= min).map((grade) => <option key={grade} value={grade}>{grade}</option>)}
  </select>;
}

export function catalogItemName(item: { itemName?: string; itemId?: string }) {
  if (item.itemName) return item.itemName;
  if (item.itemId) return friendlyCatalogName(item.itemId);
  return "Unknown";
}

export function PackageItemPreview({ item }: { item: { itemId?: string; image?: string } }) {
  const catalogItem = { id: item.itemId || "", name: item.itemId || "Item", image: item.image } as CatalogItem;
  return <CatalogItemThumb item={catalogItem} small />;
}

export function catalogItemId(item: { itemId?: string }) {
  return item.itemId || "Resolved on grant";
}

export function friendlyCatalogName(value: string) {
  return value.replace(/^[-*]\s*/, "").replace(/^\/Game\/.*\//, "").replaceAll("_", " ").trim();
}
