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
  // Inventory volume of one unit; absent when the console does not know it.
  volume?: number;
  requiredDlc?: string;
  requiredSteamDlc?: string;
};

// Shared module-level cache: the full catalog (~2,600 items) is identical
// for every consumer within one page load, and both ItemCatalogSelector and
// ItemCatalogCombobox below fetch it independently -- without this, opening
// a container's contents overlay (which renders the Give and Fill comboboxes
// side by side) would issue two redundant full-catalog requests every time.
let cachedCatalog: CatalogItem[] | null = null;
let cachedCatalogPromise: Promise<CatalogItem[]> | null = null;

// For tests that need a different catalog from the one already cached.
export function clearCatalogCache() {
  cachedCatalog = null;
  cachedCatalogPromise = null;
}

export async function loadFullCatalog(): Promise<CatalogItem[]> {
  if (cachedCatalog) return cachedCatalog;
  if (!cachedCatalogPromise) {
    cachedCatalogPromise = adminApi.itemCatalog("", 10000).then((result) => {
      cachedCatalog = (result.rows || []).map((item) => ({ ...item, id: item.itemId || item.id }));
      return cachedCatalog;
    }).catch((error) => {
      // A failed load must not be remembered: the next caller tries again.
      cachedCatalogPromise = null;
      throw error;
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
          return <tr className={active ? "active" : ""} key={`${item.id}-${item.name}-${item.source}`} title={fullName} onClick={() => onSelect(active ? null : item)}>
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
        return <button type="button" className={`catalog-item-option ${active ? "active" : ""}`} key={`${item.id}-${item.name}-${item.source}`} title={fullName} onClick={() => onSelect(active ? null : item)}>
          <CatalogItemThumb item={item} />
          <span>
            <strong>{fullName}</strong>
            <small>{item.id}{item.category ? ` - ${titleCase(item.category)}` : ""}</small>
            {item.requiredDlc && <small>Requires {item.requiredDlc}</small>}
          </span>
        </button>;
      })}
      {!loading && !filteredItems.length && <div className="catalog-empty">No items match your filters.</div>}
    </div>
    {selected && <div className="catalog-selected-item">
      <CatalogItemThumb item={selected} large />
      <KeyValueGrid items={[["Item Name", selected.name], ["Item ID", selected.id], ["Category", selected.category ? titleCase(selected.category) : ""], ["Source", selected.source || ""], ["Requires", selected.requiredDlc || ""]]} />
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
// Search matches names (every name the catalog lists for the id), categories and
// catalog ids (template ids, e.g. "Oil" for
// "Fuel Cell"): container contents and the console's messages name items by id.
// An id is shown on a row it was needed to find, and when two items share a name
// and category. Callers submit the chosen item's id.
//
// `filterGroups`, when set, offers only items of those groups; the server
// enforces the same rule.
//
// Every typed word must appear in one of the item's names, its category or its id.
// Lower ranks sort first: the exact name, names that start with the text, the exact
// id, other name or category matches, then matches that needed the id.
const RANK_EXACT_ID = 2;
const RANK_NEEDED_ID = 4;

function containsAll(text: string, words: string[]) {
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// The rank of one item under one of its names, or null when that name does not match.
function rankUnderName(item: CatalogItem, itemName: string, term: string, words: string[]) {
  const label = `${itemName} ${item.category || ""}`;
  if (!containsAll(`${label} ${item.id}`, words)) return null;
  const name = itemName.toLowerCase();
  if (term && name === term) return 0;
  if (term && name.startsWith(term)) return 1;
  if (item.id.toLowerCase() === term) return RANK_EXACT_ID;
  return containsAll(label, words) ? 3 : RANK_NEEDED_ID;
}

function searchCombobox(items: CatalogItem[], otherNames: Map<string, string[]>, text: string, filterGroups?: Set<string>) {
  const term = text.trim().toLowerCase();
  const words = term.split(/\s+/).filter(Boolean);
  const found: { item: CatalogItem; rank: number }[] = [];
  for (const item of items) {
    if (filterGroups && !(item.group && filterGroups.has(item.group))) continue;
    const ranks = [item.name, ...(otherNames.get(item.id) || [])]
      .map((name) => rankUnderName(item, name, term, words))
      .filter((rank) => rank !== null);
    if (ranks.length) found.push({ item, rank: Math.min(...ranks) });
  }
  return found.sort((a, b) => a.rank - b.rank);
}

const MAX_COMBOBOX_RESULTS = 40;
// The list, and so the pictures it asks for, follows the typing after this pause.
const COMBOBOX_SEARCH_DELAY_MS = 150;

export function ItemCatalogCombobox({
  value,
  onChange,
  onQueryChange,
  filterGroups,
  ariaLabel,
  placeholder = "Type to search items…",
  disabled = false
}: {
  value: CatalogItem | null;
  onChange: (item: CatalogItem | null) => void;
  // Receives the text in the box whenever it changes.
  onQueryChange?: (query: string) => void;
  filterGroups?: Set<string>;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [query, setQuery] = useState(value?.name || "");
  // The text the list was last searched with.
  const [search, setSearch] = useState(query);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const mountedRef = useRef(true);
  // Set when typing drops the selection, so the sync below keeps the typed text.
  const typedOverRef = useRef(false);
  const listId = useMemo(() => `item-combobox-list-${Math.random().toString(36).slice(2)}`, []);

  function load() {
    setLoadState("loading");
    void loadFullCatalog().then(
      (loaded) => {
        if (!mountedRef.current) return;
        setItems(loaded);
        setLoadState("ready");
      },
      () => { if (mountedRef.current) setLoadState("failed"); }
    );
  }

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => { mountedRef.current = false; };
  }, []);

  // Text the component puts in the box itself is searched at once.
  function showText(text: string) {
    setQuery(text);
    setSearch(text);
  }

  function runSearch(text: string) {
    setSearch(text);
    setHighlighted(0);
  }

  useEffect(() => {
    if (query === search) return undefined;
    const timer = setTimeout(() => runSearch(query), COMBOBOX_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, search]);

  useEffect(() => {
    onQueryChange?.(query);
  }, [query]);

  // Keeps the visible text in sync when a parent clears the selection (e.g.
  // after a successful give/fill resets the form) without fighting the
  // user's own typing the rest of the time -- only reacts to value becoming
  // null/changing identity from outside, not to local query edits.
  useEffect(() => {
    const typedOver = typedOverRef.current;
    typedOverRef.current = false;
    if (!value && typedOver) return;
    showText(value?.name || "");
  }, [value]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // The catalog lists a few ids twice, one row per id is shown (the first) and the
  // other rows' names still find it. Some different items share a name and a
  // category, and only their id tells them apart.
  const { unique, otherNames, ambiguous } = useMemo(() => {
    const byId = new Map<string, CatalogItem>();
    const others = new Map<string, string[]>();
    for (const item of items) {
      const first = byId.get(item.id);
      if (!first) byId.set(item.id, item);
      else if (item.name !== first.name) others.set(item.id, [...(others.get(item.id) || []), item.name]);
    }
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const item of byId.values()) {
      const key = `${item.name}|${item.category || ""}`;
      if (seen.has(key)) shared.add(key);
      seen.add(key);
    }
    return { unique: [...byId.values()], otherNames: others, ambiguous: shared };
  }, [items]);

  const matches = useMemo(() => searchCombobox(unique, otherNames, search, filterGroups), [unique, otherNames, search, filterGroups]);
  const results = matches.slice(0, MAX_COMBOBOX_RESULTS);
  const count = results.length;
  const totalCount = matches.length;
  // Typed text the list has not caught up with yet.
  const pending = query !== search;
  const loading = loadState === "loading";
  const listShown = open && (loading || count > 0);
  const optionId = (item: CatalogItem) => `${listId}-${item.id}`;
  const active = listShown && !pending ? results[highlighted] : undefined;

  // The list opens at the bottom of a scrolling dialog: bring it into view.
  useEffect(() => {
    if (open) popupRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open, count, loadState]);

  function choose(item: CatalogItem) {
    onChange(item);
    showText(item.name);
    setOpen(false);
  }

  function highlight(index: number) {
    setHighlighted(index);
    listRef.current?.children[index]?.scrollIntoView?.({ block: "nearest" });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    // These keys act on a search of the text in the box, never on an older list.
    const current = pending ? searchCombobox(unique, otherNames, query, filterGroups).slice(0, MAX_COMBOBOX_RESULTS) : results;
    const from = pending ? 0 : highlighted;
    if (pending) runSearch(query);
    if (event.key === "Enter") {
      const entry = current[from];
      if (entry) {
        event.preventDefault();
        choose(entry.item);
      }
      return;
    }
    event.preventDefault();
    highlight(Math.max(0, Math.min(from + (event.key === "ArrowDown" ? 1 : -1), current.length - 1)));
  }

  return <div
    className="item-combobox"
    ref={containerRef}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
  >
    <input
      ref={inputRef}
      type="text"
      role="combobox"
      aria-expanded={listShown}
      aria-controls={listShown ? listId : undefined}
      aria-activedescendant={active ? optionId(active.item) : undefined}
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
        if (value) {
          typedOverRef.current = true;
          onChange(null);
        }
      }}
      onFocus={() => { setOpen(true); if (loadState === "failed") load(); }}
      onClick={() => { if (loadState === "failed") { setOpen(true); load(); } }}
      onKeyDown={handleKeyDown}
    />
    <div className={open ? "item-combobox-popup open" : "item-combobox-popup"} ref={popupRef}>
      {listShown && <ul className="item-combobox-list" id={listId} role="listbox" tabIndex={-1} aria-busy={loading} ref={listRef}>
        {results.map(({ item, rank }, index) => (
          <li
            key={item.id}
            id={optionId(item)}
            role="option"
            aria-selected={index === highlighted}
            className={index === highlighted ? "highlighted" : ""}
            onMouseDown={(event) => { event.preventDefault(); choose(item); }}
            onMouseEnter={() => setHighlighted(index)}
          >
            <CatalogItemThumb item={item} small lazy />
            <span>
              <strong>{item.name}</strong>
              {item.category && <small>{titleCase(item.category)}</small>}
              {(rank === RANK_EXACT_ID || rank === RANK_NEEDED_ID || ambiguous.has(`${item.name}|${item.category || ""}`)) && <small data-no-translate>{item.id}</small>}
            </span>
          </li>
        ))}
      </ul>}
      <div onMouseDown={(event) => event.preventDefault()}>
        {/* Always in the page, so that screen readers announce what appears in it. */}
        <div className="item-combobox-status" role="status" aria-live="polite">
          {!open ? "" : loading ? "Loading items…" : loadState === "failed" ? "The item list could not be loaded." : count === 0 ? (search.trim() ? "No matching items." : "Start typing to search…") : totalCount > count ? `Showing ${count} of ${totalCount} matches. Type more to narrow the list.` : ""}
        </div>
        {open && loadState === "failed" && <button type="button" className="item-combobox-retry" onClick={() => { inputRef.current?.focus(); load(); }}>Try again</button>}
      </div>
    </div>
  </div>;
}

export function CatalogItemThumb({ item, large = false, small = false, lazy = false }: { item: CatalogItem; large?: boolean; small?: boolean; lazy?: boolean }) {
  const fallback = "/images/items/image-unavailable.png";
  const src = item.image || `/images/items/${encodeURIComponent(item.itemId || item.id)}.png`;
  const [imageSrc, setImageSrc] = useState(src);
  useEffect(() => {
    setImageSrc(src);
  }, [src]);
  return <div className={large ? "catalog-item-preview large" : small ? "catalog-item-preview small" : "catalog-item-preview"}>
    <img loading={lazy ? "lazy" : undefined} decoding={lazy ? "async" : undefined} src={imageSrc} alt="" onError={() => { if (imageSrc !== fallback) setImageSrc(fallback); }} />
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

// Polymorphic over two different item shapes on purpose: a queued/given
// package item, which carries `itemName` (checked first, unchanged), and a
// CatalogItem from ItemCatalogSelector's own loaded list, which carries
// `name` instead -- that field was never checked here, so every catalog
// picker (grid title and list view's "Item Name" column alike) fell through
// to prettifying the raw id and looked like the id shown twice, once
// formatted and once raw. Package items never carry `name`, so this addition
// cannot change their behavior.
export function catalogItemName(item: { itemName?: string; name?: string; itemId?: string }) {
  if (item.itemName) return item.itemName;
  if (item.name) return item.name;
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
