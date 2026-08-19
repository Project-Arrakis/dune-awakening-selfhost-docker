import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, ChevronDown, ChevronRight, LayoutGrid, List, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import {
  CatalogItemThumb,
  ItemCatalogSelector,
  ItemGradeSelect,
  catalogItemMinimumGrade,
  type CatalogItem
} from "../../components/common/ItemCatalog";
import { AugmentDropdown } from "../../components/common/AugmentDropdown";
import { augmentLimitForItem, filterAugmentsForItem, formatAugmentOptions, itemCanUseAugments } from "../../lib/augmentEligibility";
import { adminApi } from "../../api/admin";
import {
  basesApi,
  type BaseContainerSlots,
  type BaseInventory,
  type BaseInventoryContainer,
  type BaseInventoryGroupKey,
  type BaseInventoryItem,
  type BaseInventorySlot
} from "../../api/bases";

type BaseInventoryTabProps = {
  baseId: string;
  baseName: string;
  onError: (message: string) => void;
  // Shape copied from BasePermissionsTab, which is what BasesPanel actually
  // passes -- it carries `warning`, which the non-storage delete needs.
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
};

// Guards a corrupt or absurd max_item_count from rendering tens of thousands
// of cells. Above this the modal stays in list mode.
const GRID_CELL_CAP = 200;

type ContentsView = "list" | "grid";

// Lays one inventory's slots into a fixed grid. position_index has no unique
// constraint in the schema and is not validated against max_item_count, so all
// three of "sparse", "two slots claim the same index" and "index past the end"
// are reachable. Anything that cannot be placed goes to `overflow` and is
// rendered below the grid -- never dropped, because an item the delete button
// cannot reach is the worst outcome here.
function layoutSlots(inventory: { maxSlots: number; slots: BaseInventorySlot[] }) {
  const size = Math.min(Math.max(0, inventory.maxSlots), GRID_CELL_CAP);
  const cells: (BaseInventorySlot | null)[] = new Array(size).fill(null);
  const overflow: BaseInventorySlot[] = [];
  for (const slot of inventory.slots) {
    const at = slot.positionIndex;
    if (at !== null && Number.isInteger(at) && at >= 0 && at < size && cells[at] === null) cells[at] = slot;
    else overflow.push(slot);
  }
  return { cells, overflow };
}

// The rollup is capped so the tab cannot blow out the height of an already
// expanded table row; "Show all" lifts it.
const ITEM_PREVIEW_LIMIT = 25;

type GroupFilter = BaseInventoryGroupKey | "all";
type ViewMode = "items" | "containers";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Falls back to the type when a placeable has never been renamed in-game --
// the backend returns "" rather than the game's '##'-prefixed default.
function containerLabel(container: { name: string; typeName: string; placeableId: string }) {
  return container.name || `${container.typeName} #${container.placeableId}`;
}

export function BaseInventoryTab({ baseId, baseName, onError, confirmAction }: BaseInventoryTabProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [data, setData] = useState<BaseInventory | null>(null);
  // Containers first: opening the tab is usually "what is at this base", and
  // the cards answer that at a glance. The rollup is the follow-up question.
  const [view, setView] = useState<ViewMode>("containers");
  const [group, setGroup] = useState<GroupFilter>("all");
  // Two-state search, matching every other server-shaped search box in the
  // app: `q` is what is typed, `submittedQ` is what filters. The filtering
  // itself is client-side -- the whole base already arrived in one response --
  // but search-as-you-type is not the panel's vocabulary.
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [expandedItem, setExpandedItem] = useState("");
  // Placeable id whose contents overlay is open, "" for none.
  const [contentsFor, setContentsFor] = useState("");
  const [showAllItems, setShowAllItems] = useState(false);
  const closeContentsRef = useRef<HTMLButtonElement>(null);
  // Slots for the open container only, fetched on open.
  const [slots, setSlots] = useState<BaseContainerSlots | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState("");
  // Grid by default: the overlay's job is "what is actually in this box", and
  // the slot layout answers that at a glance. List is a click away, and is
  // still the automatic fallback for a container whose slots carry no usable
  // position_index or whose capacity is unusable.
  const [contentsView, setContentsView] = useState<ContentsView>("grid");
  const [deletingItemId, setDeletingItemId] = useState("");
  const [deleteNotice, setDeleteNotice] = useState("");
  // Separate from slotsError on purpose: that one means "the slots could not
  // be loaded" and hides the list behind a Retry. A delete that failed leaves
  // the list perfectly valid, so blanking it would lose the operator's place
  // over an error about one row.
  const [deleteError, setDeleteError] = useState("");
  // Selecting a slot moves its controls into one strip below the list/grid
  // rather than repeating a quantity input on every row -- a packed 100-slot
  // container would otherwise render a hundred of them.
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [amount, setAmount] = useState("");
  const slotsRequestIdRef = useRef(0);

  // Add-item panel. It replaces the slot region rather than stacking under it:
  // ItemCatalogSelector brings its own ~300px of category select, filter and
  // scrolling grid, and hanging that below an already-scrolling slot list is
  // what pushed the modal's own actions off screen once before.
  const [addOpen, setAddOpen] = useState(false);
  const [addItem, setAddItem] = useState<CatalogItem | null>(null);
  const [addQuantity, setAddQuantity] = useState("1");
  const [addGrade, setAddGrade] = useState("0");
  const [addAugments, setAddAugments] = useState<string[]>([]);
  const [addAugmentGrade, setAddAugmentGrade] = useState("1");
  const [augmentCatalog, setAugmentCatalog] = useState<{ id: string; name: string }[]>([]);
  // Its own triad, for the same reason the delete's is separate from
  // slotsError: a failed add leaves the slot list perfectly valid, and hiding
  // it behind a Retry would lose the operator's place over one form's error.
  const [adding, setAdding] = useState(false);
  const [addNotice, setAddNotice] = useState("");
  const [addError, setAddError] = useState("");

  // Only the newest request may write state. StrictMode double-invokes this
  // effect, so two requests really are open at once here, and whichever settles
  // last wins -- a first attempt that fails after a second one succeeded would
  // otherwise replace good data with an error banner. Same requestIdRef pattern
  // BasesPanel uses for its own overlapping loads.
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError("");
    try {
      const result = await basesApi.inventory(baseId);
      if (requestIdRef.current !== requestId) return;
      setData(result);
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setLoadError(errorText(error));
    } finally {
      // Left to the newest request too, so an early finisher cannot clear the
      // spinner while the request that will actually fill the tab is open.
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [baseId]);

  useEffect(() => { void load(); }, [load]);

  const term = submittedQ.trim().toLowerCase();

  const items = useMemo(() => {
    if (!data) return [] as BaseInventoryItem[];
    return data.items
      // Filtering by group re-derives the quantity from the surviving
      // containers -- showing the base-wide total under a group chip would
      // claim stock the group does not hold.
      .map((item) => {
        if (group === "all") return item;
        const containers = item.containers.filter((holder) => holder.group === group);
        return {
          ...item,
          containers,
          quantity: containers.reduce((total, holder) => total + holder.quantity, 0),
          containerCount: containers.length
        };
      })
      .filter((item) => item.containers.length > 0)
      .filter((item) => !term ||
        item.name.toLowerCase().includes(term) ||
        item.templateId.toLowerCase().includes(term));
  }, [data, group, term]);

  const containers = useMemo(() => {
    if (!data) return [] as BaseInventoryContainer[];
    return data.containers
      .filter((container) => group === "all" || container.group === group)
      .filter((container) => !term ||
        containerLabel(container).toLowerCase().includes(term) ||
        container.items.some((stack) => stack.name.toLowerCase().includes(term)))
      // Sorted on the rendered label, not on name/typeName separately, so a
      // renamed container files under the name on its card rather than
      // disappearing into a block of its own type. numeric keeps "#9" ahead
      // of "#10"; the cards are grouped into sections downstream, so this is
      // already per-group.
      .slice()
      .sort((left, right) => containerLabel(left).localeCompare(
        containerLabel(right), undefined, { numeric: true, sensitivity: "base" }));
  }, [data, group, term]);

  // Resolved from the unfiltered list: a group chip or search term applied
  // after the overlay opened must not blank out what is on screen.
  const openContainer = contentsFor
    ? data?.containers.find((container) => container.placeableId === contentsFor) || null
    : null;

  // Item icons live on the rollup, keyed by template, so the overlay reuses
  // them rather than the response carrying the same URL twice per container.
  const imagesByTemplate = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of data?.items || []) map.set(item.templateId, item.image);
    return map;
  }, [data]);
  const itemImage = (templateId: string) =>
    imagesByTemplate.get(templateId) || "/images/items/image-unavailable.png";

  // Re-resolved from the current slots rather than held as an object, so a
  // refetch after a partial delete updates the strip's quantity instead of
  // leaving it showing the pre-delete stack.
  const selectedSlot = useMemo(() => {
    if (!selectedSlotId || !slots?.inventories) return null;
    for (const inventory of slots.inventories) {
      const found = inventory.slots.find((slot) => slot.itemId === selectedSlotId);
      if (found) return found;
    }
    return null;
  }, [selectedSlotId, slots]);

  // The server rejects an over-count rather than clearing the slot, so this is
  // a courtesy check, not the guard.
  const amountNumber = Number(amount);
  const amountValid = Boolean(selectedSlot)
    && Number.isInteger(amountNumber)
    && amountNumber >= 1
    && amountNumber <= (selectedSlot?.quantity ?? 0);
  const deleteAllowed = slots?.group === "storage" && slots?.deleteSafety?.safe === true;
  const deleteUnavailableReason = slots?.found && !deleteAllowed
    ? slots.group !== "storage"
      ? "Item deletion is available only for Storage containers. Crafting and Refining contents are read-only to protect active jobs."
      : slots.deleteSafety?.reason || "Item deletion is unavailable for this container."
    : "";

  // Same shape and the same fail-closed default as the delete gate above. The
  // server re-checks this immediately before the write regardless.
  const addAllowed = slots?.group === "storage" && slots?.addSafety?.safe === true;
  const addUnavailableReason = slots?.found && !addAllowed
    ? slots.group !== "storage"
      ? "Adding items is available only for Storage containers. Crafting and Refining contents are read-only to protect active jobs."
      : slots.addSafety?.reason || "Adding items is unavailable for this container."
    : "";
  // Read off the open container rather than the safety object -- capacity is a
  // property of the box, not of whether its map is stopped.
  const containerFull = Boolean(openContainer) && openContainer!.maxSlots > 0
    && openContainer!.usedSlots >= openContainer!.maxSlots;
  const containerFullReason = containerFull && openContainer
    ? `This container is full (${openContainer.usedSlots.toLocaleString()} / ${openContainer.maxSlots.toLocaleString()} slots). Delete an item to make room.`
    : "";

  const addItemMeta = addItem
    ? { templateId: addItem.itemId || addItem.id, category: addItem.category || "", source: addItem.source || "" }
    : null;
  const addAugmentLimit = addItemMeta ? augmentLimitForItem(addItemMeta) : 0;
  const addAugmentOptions = addItemMeta && itemCanUseAugments(addItemMeta)
    ? formatAugmentOptions(filterAugmentsForItem(addItemMeta, augmentCatalog), addAugmentGrade)
    : [];
  const addQuantityNumber = Number(addQuantity);
  const addQuantityValid = Number.isInteger(addQuantityNumber)
    && addQuantityNumber >= 1
    && addQuantityNumber <= 1000000;

  // Only paid for by an operator who actually opens the add panel -- the
  // catalog fetch is the full 10k-row list.
  useEffect(() => {
    if (!addOpen || augmentCatalog.length > 0) return;
    let cancelled = false;
    adminApi.itemCatalog("", 10000).then((result) => {
      if (cancelled) return;
      setAugmentCatalog((result.rows || []).filter((item) =>
        (item.category || "").toLowerCase().includes("augment") ||
        (item.source || "").toLowerCase() === "augments"
      ).map((item) => ({ id: item.itemId || item.id, name: item.name })));
    }).catch(() => { if (!cancelled) setAugmentCatalog([]); });
    return () => { cancelled = true; };
  }, [addOpen, augmentCatalog.length]);

  function resetAddForm() {
    setAddItem(null);
    setAddQuantity("1");
    setAddGrade("0");
    setAddAugments([]);
    setAddAugmentGrade("1");
    setAddError("");
  }

  // The add panel and the slot-detail strip are two modes of one dialog, not
  // two panels: the strip is keyed to an existing occupied slot and cannot
  // represent an add, so opening either closes the other.
  function openAddPanel() {
    setSelectedSlotId("");
    setAmount("");
    setAddNotice("");
    setAddError("");
    setAddOpen(true);
  }

  function selectSlot(slot: BaseInventorySlot) {
    setAddOpen(false);
    setSelectedSlotId(slot.itemId);
    setAmount(String(slot.quantity));
  }

  // A slot that vanished (deleted, or moved by a player between refetches)
  // must not leave a stale strip pointing at an id the server no longer has.
  useEffect(() => {
    if (selectedSlotId && slots && !selectedSlot) {
      setSelectedSlotId("");
      setAmount("");
    }
  }, [selectedSlotId, slots, selectedSlot]);

  // Same newest-request-wins guard as load(): reopening a different container
  // before the first response lands must not paint the wrong container's slots.
  const loadSlots = useCallback(async (placeableId: string) => {
    const requestId = ++slotsRequestIdRef.current;
    setSlotsLoading(true);
    setSlotsError("");
    try {
      const result = await basesApi.containerSlots(baseId, placeableId);
      if (slotsRequestIdRef.current !== requestId) return;
      setSlots(result);
    } catch (error) {
      if (slotsRequestIdRef.current !== requestId) return;
      setSlotsError(errorText(error));
    } finally {
      if (slotsRequestIdRef.current === requestId) setSlotsLoading(false);
    }
  }, [baseId]);

  useEffect(() => {
    if (!contentsFor) {
      // Invalidates a request that was still in flight when the overlay
      // closed, the same way opening a different container does -- closing
      // is itself a reason the response no longer matters, even though
      // nothing currently renders slots while contentsFor is empty.
      slotsRequestIdRef.current += 1;
      setSlots(null);
      setSlotsError("");
      setDeleteNotice("");
      setDeleteError("");
      setSelectedSlotId("");
      setAmount("");
      setAddOpen(false);
      setAddNotice("");
      resetAddForm();
      return;
    }
    setSelectedSlotId("");
    setAmount("");
    setDeleteError("");
    // A half-filled form must not carry over to a different container: the
    // capacity, the gate and the confirm dialog's "Container" line all change.
    setAddOpen(false);
    setAddNotice("");
    resetAddForm();
    void loadSlots(contentsFor);
  }, [contentsFor, loadSlots]);

  // Matches ConfirmDialog: Escape closes, and focus moves to the close button
  // so the overlay is reachable without a mouse.
  useEffect(() => {
    if (!openContainer) return undefined;
    closeContentsRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // ConfirmDialog listens on window too, so a single Escape reached both
      // and cancelling a delete confirmation also tore down the overlay behind
      // it, losing the operator's place. When a second modal is stacked on
      // top, let it take the key and leave this one open.
      if (document.querySelectorAll(".confirm-modal").length > 1) return;
      setContentsFor("");
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [openContainer]);

  function applySearch(next: string) {
    setSubmittedQ(next);
    setExpandedItem("");
    setShowAllItems(false);
  }

  async function deleteSlot(slot: BaseInventorySlot, amount: number, containerName: string) {
    if (!deleteAllowed) {
      const text = deleteUnavailableReason || "Item deletion is unavailable for this container.";
      setDeleteError(text);
      onError(text);
      return;
    }
    const whole = amount >= slot.quantity;
    const confirmed = await confirmAction(
      whole ? "Delete this item from the container?" : "Remove part of this stack?",
      {
        title: whole ? "Delete Stored Item" : "Remove From Stack",
        confirmLabel: whole ? "Delete" : "Remove",
        danger: true,
        details: [
          { label: "Base", value: baseName },
          { label: "Container", value: containerName, tone: "accent" },
          { label: "Slot", value: slot.positionIndex === null ? "—" : `#${slot.positionIndex}` },
          {
            label: whole ? "Item" : "Removing",
            value: whole
              ? `${slot.name} ×${slot.quantity.toLocaleString()}`
              : `${amount.toLocaleString()} of ${slot.quantity.toLocaleString()} ${slot.name}`,
            tone: "danger"
          }
        ]
      }
    );
    if (!confirmed) return;
    setDeletingItemId(slot.itemId);
    setDeleteNotice("");
    setDeleteError("");
    try {
      const response = await basesApi.deleteContainerItem(
        baseId, contentsFor, slot.itemId, "DELETE ITEM", whole ? undefined : amount);
      const result = response.result;
      if (!response.supported || !result?.ok) {
        throw new Error(response.error || response.reason || "The item could not be deleted.");
      }
      setDeleteNotice(result.message);
      // A whole-slot delete removes the slot entirely, so the vanished-slot
      // effect below clears amount once the refetch lands. A partial delete
      // leaves the same slot selected with a smaller stack, and that effect
      // does not fire for it -- left alone, the stale (larger) amount would
      // exceed the new quantity on the very next render and immediately show
      // the "enter an amount" error on what was actually a successful delete.
      if (result.partial) setAmount(String(result.removed.remaining));
      // Refetch both: the slot list for this container, and the tab totals,
      // group counts and rollup, all of which the delete just invalidated.
      await Promise.all([loadSlots(contentsFor), load()]);
    } catch (error) {
      const text = errorText(error);
      setDeleteError(text);
      onError(text);
    } finally {
      setDeletingItemId("");
    }
  }

  async function addToContainer(containerName: string) {
    if (!addAllowed) {
      const text = addUnavailableReason || "Adding items is unavailable for this container.";
      setAddError(text);
      onError(text);
      return;
    }
    if (!addItem || !addQuantityValid) return;
    const augmentNames = addAugments
      .map((id) => augmentCatalog.find((entry) => entry.id === id)?.name || id);
    const confirmed = await confirmAction("Add this item to the container?", {
      title: "Add Item to Container",
      confirmLabel: "Add",
      details: [
        { label: "Base", value: baseName },
        { label: "Container", value: containerName, tone: "accent" },
        { label: "Item", value: `${addItem.name} ×${addQuantityNumber.toLocaleString()}`, tone: "success" },
        { label: "Grade", value: addGrade },
        ...(augmentNames.length > 0 ? [{ label: "Augments", value: augmentNames.join(", ") }] : []),
        // The last place the operator sees the placement rule, and it has to
        // stay honest: the server appends, and no slot was ever reserved.
        { label: "Slot", value: "Next free slot" }
      ]
    });
    if (!confirmed) return;
    setAdding(true);
    setAddNotice("");
    setAddError("");
    try {
      const response = await basesApi.addContainerItem(baseId, contentsFor, {
        itemId: addItem.itemId || addItem.id,
        quantity: addQuantityNumber,
        quality: Number(addGrade) || 0,
        augments: addAugments,
        augmentQuality: Number(addAugmentGrade) || 1
      }, "ADD ITEM TO CONTAINER");
      const result = response.result;
      if (!response.supported || !result?.ok) {
        throw new Error(response.error || response.reason || "The item could not be added.");
      }
      setAddNotice(result.message);
      setAddOpen(false);
      resetAddForm();
      // Same pair the delete refetches: this container's slots, and the tab's
      // totals, group counts and rollup, all of which the add invalidated.
      await Promise.all([loadSlots(contentsFor), load()]);
    } catch (error) {
      const text = errorText(error);
      setAddError(text);
      onError(text);
    } finally {
      setAdding(false);
    }
  }

  if (loading) {
    return <p className="muted" role="status">Loading base inventory…</p>;
  }
  if (loadError) {
    return <p className="bases-permissions-error" role="alert">
      {loadError} <button onClick={() => void load()}>Retry</button>
    </p>;
  }
  if (!data) return null;
  // A settled answer, not a failure: this database cannot back the tab, so it
  // gets a plain statement and no Retry -- the request would fail identically
  // every time. Genuine failures still land in the branch above, where Retry
  // means something.
  if (!data.supported) {
    return <p className="muted" role="status">
      {data.reason || "Base inventory is unsupported by the detected schema."}
    </p>;
  }

  const { totals } = data;
  const slotPercent = totals.maxSlots > 0 ? Math.round((totals.usedSlots / totals.maxSlots) * 100) : 0;
  const visibleItems = showAllItems ? items : items.slice(0, ITEM_PREVIEW_LIMIT);

  return (
    <div className="bases-inventory" onClick={(event) => event.stopPropagation()}>
      <div className="bases-tab-body">
        {/* Stated before the data rather than after it: it governs how to read
            everything below, and at the foot of a 27-card list it was never
            seen. */}
        {/* These are database rows and a running map keeps its own copy, so
            destructive controls remain disabled until the backend verifies a
            safe stopped-map window. */}
        <p className="bases-inventory-note muted">
          A database snapshot, not a live view. Stored items can be added or deleted only while their map is safely stopped.
        </p>

        {/* summary-stats/summary-stat are the app's stat tiles, shared with
            the player summary, so these read as boxes like everywhere else. */}
        <dl className="bases-inventory-totals summary-stats">
          <div className="summary-stat"><dt>Items</dt><dd>{totals.items.toLocaleString()}</dd></div>
          <div className="summary-stat"><dt>Distinct</dt><dd>{totals.distinct.toLocaleString()}</dd></div>
          <div className="summary-stat"><dt>Containers</dt><dd>{totals.containers.toLocaleString()}</dd></div>
          <div className="summary-stat"><dt>Slots used</dt><dd>{totals.maxSlots > 0 ? `${slotPercent}%` : "—"}</dd></div>
        </dl>

        <div className="bases-inventory-controls">
          <div className="bases-inventory-groups" role="group" aria-label="Filter by container group">
            <button
              className={`bases-inventory-chip${group === "all" ? " active" : ""}`}
              aria-pressed={group === "all"}
              onClick={() => { setGroup("all"); setShowAllItems(false); }}
            >All</button>
            {data.groups.filter((entry) => entry.containerCount > 0).map((entry) => (
              <button
                key={entry.key}
                className={`bases-inventory-chip${group === entry.key ? " active" : ""}`}
                aria-pressed={group === entry.key}
                onClick={() => { setGroup(entry.key); setShowAllItems(false); }}
              >{entry.name} <span className="bases-inventory-chip-count">{entry.containerCount}</span></button>
            ))}
          </div>
          <div className="bases-inventory-views" role="group" aria-label="Inventory view">
            <button
              className={`bases-inventory-view${view === "items" ? " active" : ""}`}
              aria-pressed={view === "items"}
              onClick={() => setView("items")}
            >Items</button>
            <button
              className={`bases-inventory-view${view === "containers" ? " active" : ""}`}
              aria-pressed={view === "containers"}
              onClick={() => setView("containers")}
            >Containers</button>
          </div>
        </div>

        <div className="bases-inventory-search">
          <input
            value={q}
            aria-label="Filter base inventory"
            placeholder={view === "items" ? "Filter items…" : "Filter containers…"}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") applySearch(q); }}
          />
          <button onClick={() => applySearch(q)}>Search</button>
          <button onClick={() => { setQ(""); applySearch(""); }}>Clear</button>
        </div>

        {view === "items"
          ? <div className="bases-inventory-items">
              {!items.length
                ? <p className="muted">{term || group !== "all" ? "No items match this filter." : "No stored items at this base."}</p>
                : <>
                    <div className="bases-inventory-item-head">
                      <span /><span>Item</span><span>Qty</span><span>Containers</span>
                    </div>
                    {visibleItems.map((item) => {
                      const open = expandedItem === item.templateId;
                      return (
                        <div key={item.templateId}>
                          <button
                            className="bases-inventory-item-row"
                            aria-expanded={open}
                            onClick={() => setExpandedItem(open ? "" : item.templateId)}
                          >
                            <span aria-hidden="true">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
                            <span className="bases-inventory-item-name">
                              <img src={item.image} alt="" aria-hidden="true" />
                              {item.name}
                            </span>
                            <span className="bases-inventory-qty">{item.quantity.toLocaleString()}</span>
                            <span className="bases-inventory-count">{item.containerCount}</span>
                          </button>
                          {open && <div className="bases-inventory-breakdown">
                            {item.containers.map((holder) => (
                              <div key={holder.placeableId}>
                                <span>{containerLabel(holder)}</span>
                                <span className="bases-inventory-breakdown-actions">
                                  {holder.quantity.toLocaleString()}
                                  {/* Same label and icon as the container
                                      cards': one action, one name for it,
                                      wherever a container is listed. */}
                                  <button
                                    className="bases-inventory-view-contents compact"
                                    onClick={() => setContentsFor(holder.placeableId)}
                                  >
                                    <Boxes size={13} aria-hidden="true" />
                                    View Contents
                                  </button>
                                </span>
                              </div>
                            ))}
                          </div>}
                        </div>
                      );
                    })}
                    {items.length > ITEM_PREVIEW_LIMIT && <button
                      className="bases-inventory-show-all"
                      onClick={() => setShowAllItems(!showAllItems)}
                    >{showAllItems ? "Show fewer items" : `Show all ${items.length.toLocaleString()} items`}</button>}
                  </>}
            </div>
          : <div className="bases-inventory-containers">
              {!containers.length
                ? <p className="muted">{term || group !== "all" ? "No containers match this filter." : "No storage at this base."}</p>
                : data.groups.filter((entry) =>
                    containers.some((container) => container.group === entry.key)).map((entry) => {
                  const owned = containers.filter((container) => container.group === entry.key);
                  // Distinct templates, not a total quantity: the summary tile
                  // above already gives the base-wide count, and a group's
                  // total is dominated by whichever stack happens to be
                  // largest (one Solari stack buries everything else).
                  const distinct = new Set(
                    owned.flatMap((container) => container.items.map((stack) => stack.templateId))).size;
                  return (
                    <section key={entry.key}>
                      <div className="bases-inventory-group-head">
                        <h4>{entry.name}</h4>
                        <span className="muted">
                          {owned.length.toLocaleString()} {owned.length === 1 ? "container" : "containers"}
                          {" · "}
                          {distinct.toLocaleString()} distinct
                        </span>
                      </div>
                      {/* Same card vocabulary as Power and Water -- the amber
                          bordered group and the rule-separated definition list
                          -- rather than a bespoke one, so the four tabs read
                          as one panel. */}
                      <div className="bases-card-grid bases-inventory-cards">
                        {owned.map((container) => {
                          const percent = container.maxSlots > 0
                            ? Math.round((container.usedSlots / container.maxSlots) * 100)
                            : 0;
                          return (
                            <div className="bases-card" key={container.placeableId}>
                              <div className="bases-card-title">
                                {container.name || container.typeName}
                              </div>
                              {/* The type sits under the name rather than in a
                                  labelled row. When a container has no custom
                                  name the title is already the type, so the
                                  subtitle carries only the id -- most
                                  containers on a real base are unnamed. */}
                              <p className="bases-inventory-card-subtitle">
                                {container.name
                                  ? `${container.typeName} · #${container.placeableId}`
                                  : `#${container.placeableId}`}
                              </p>
                              <dl className="bases-card-stats">
                                <dt>Slots Used</dt>
                                <dd>
                                  <div className="progress-row">
                                    <div className="progress-track">
                                      <div className="progress-fill" style={{ width: `${Math.min(100, percent)}%` }} />
                                    </div>
                                    <span>{container.usedSlots.toLocaleString()} / {container.maxSlots.toLocaleString()}</span>
                                  </div>
                                </dd>
                                <dt>Items</dt>
                                <dd>{container.itemCount.toLocaleString()}</dd>
                                {/* Label hidden but not removed: the row keeps
                                    the same height as every other stat, and
                                    the button below already says what it is. */}
                                <dt className="bases-inventory-spacer-label" aria-hidden="true">Contents</dt>
                                <dd>
                                  {!container.items.length
                                    ? <span className="muted">Empty</span>
                                    : <button
                                        className="bases-inventory-view-contents"
                                        onClick={() => setContentsFor(container.placeableId)}
                                      >
                                        <Boxes size={14} aria-hidden="true" />
                                        View Contents
                                        {/* "distinct", never "stacks": the backend merges rows
                                            of the same template, so this is below usedSlots
                                            whenever a template occupies more than one slot
                                            (8 slots collapsing to 3 templates is common). */}
                                        <span className="muted">
                                          {container.items.length.toLocaleString()} distinct
                                        </span>
                                      </button>}
                                </dd>
                              </dl>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
            </div>}
      </div>

      {openContainer && <div className="modal-overlay" role="presentation" onMouseDown={() => setContentsFor("")}>
        <section
          className="confirm-modal bases-inventory-contents-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bases-inventory-contents-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="confirm-modal-title">
            <div>
              <h3 id="bases-inventory-contents-title">{openContainer.name || openContainer.typeName}</h3>
              <p className="bases-inventory-card-subtitle">
                {openContainer.name
                  ? `${openContainer.typeName} · #${openContainer.placeableId}`
                  : `#${openContainer.placeableId}`}
              </p>
            </div>
            <div className="bases-inventory-contents-head-actions">
              <div className="bases-inventory-views" role="group" aria-label="Contents view">
                <button
                  className={`bases-inventory-view${contentsView === "list" ? " active" : ""}`}
                  aria-pressed={contentsView === "list"}
                  onClick={() => setContentsView("list")}
                ><List size={14} aria-hidden="true" /> List</button>
                <button
                  className={`bases-inventory-view${contentsView === "grid" ? " active" : ""}`}
                  aria-pressed={contentsView === "grid"}
                  onClick={() => setContentsView("grid")}
                ><LayoutGrid size={14} aria-hidden="true" /> Grid</button>
              </div>
              <button ref={closeContentsRef} className="icon-action" aria-label="Close contents" onClick={() => setContentsFor("")}>
                <X size={18} />
              </button>
            </div>
          </div>

          <dl className="bases-inventory-contents-summary">
            <div><dt>Slots Used</dt><dd>{openContainer.usedSlots.toLocaleString()} / {openContainer.maxSlots.toLocaleString()}</dd></div>
            <div><dt>Items</dt><dd>{openContainer.itemCount.toLocaleString()}</dd></div>
            {/* Distinct templates, not stacks -- the count below the list is
                the stack count, and the two differ whenever a template
                occupies more than one slot. */}
            <div><dt>Distinct</dt><dd>{openContainer.items.length.toLocaleString()}</dd></div>
          </dl>

          {slotsLoading && <p className="muted" role="status">Loading slots…</p>}
          {slotsError && <p className="bases-permissions-error" role="alert">
            {slotsError} <button onClick={() => void loadSlots(contentsFor)}>Retry</button>
          </p>}
          {deleteNotice && <p className="bases-inventory-delete-notice" role="status">{deleteNotice}</p>}
          {deleteError && <p className="bases-inventory-amount-error" role="alert">{deleteError}</p>}
          {deleteUnavailableReason && <p className="bases-inventory-amount-error" role="status">
            {deleteUnavailableReason}
          </p>}
          {addNotice && <p className="bases-inventory-delete-notice" role="status">{addNotice}</p>}
          {addError && <p className="bases-inventory-amount-error" role="alert">{addError}</p>}
          {/* Suppressed when the delete gate already said the same thing --
              both fire on a running map, and two near-identical sentences read
              as a stutter rather than as two independent gates. */}
          {addUnavailableReason && !deleteUnavailableReason && <p className="bases-inventory-amount-error" role="status">
            {addUnavailableReason}
          </p>}

          {!slotsLoading && !slotsError && slots && slots.found === false && <p className="muted" role="status">
            {slots.reason || "That container is no longer at this base."}
          </p>}

          {/* One scroll container around every inventory, and the only part of
              the modal that grows. The per-inventory wrapper below cannot own
              the scrolling: an intermediate block with no height of its own
              breaks the constraint chain, and the list inside then renders at
              its full natural height straight over the controls beneath it. */}
          {!addOpen && <div className="bases-inventory-contents-scroll">
          {!slotsLoading && !slotsError && slots?.found && slots.inventories.map((inventory) => {
            const { cells, overflow } = layoutSlots(inventory);
            // Grid needs real slot positions and a sane capacity; without
            // either it would be a wall of empty cells, so it is not offered.
            const gridUsable = inventory.maxSlots > 0
              && inventory.maxSlots <= GRID_CELL_CAP
              && inventory.slots.some((slot) => slot.positionIndex !== null);
            const showGrid = contentsView === "grid" && gridUsable;
            const rows = showGrid ? overflow : inventory.slots;
            return (
              <div className="bases-inventory-slots" key={inventory.inventoryId}>
                {slots.inventories.length > 1 && <p className="bases-inventory-card-subtitle">
                  Inventory #{inventory.inventoryId} · {inventory.usedSlots.toLocaleString()} / {inventory.maxSlots.toLocaleString()} slots
                </p>}

                {showGrid && <div
                  className="bases-inventory-slot-grid"
                  role="group"
                  aria-label={`${inventory.usedSlots} of ${inventory.maxSlots} slots used`}
                >
                  {cells.map((slot, index) => slot
                    ? <button
                        key={slot.itemId}
                        className={`bases-inventory-slot-cell${selectedSlotId === slot.itemId ? " selected" : ""}`}
                        aria-pressed={selectedSlotId === slot.itemId}
                        // Without the explicit label the quantity badge below
                        // becomes the accessible name, so a filled cell
                        // announced as a bare number and the title fallback
                        // never applied.
                        aria-label={`${slot.name} ×${slot.quantity.toLocaleString()}, slot ${index}`}
                        title={`${slot.name} ×${slot.quantity.toLocaleString()} (slot ${index})`}
                        onClick={() => selectSlot(slot)}
                      >
                        <CatalogItemThumb item={{ id: slot.templateId, itemId: slot.templateId, name: slot.name, image: itemImage(slot.templateId) }} small />
                        {slot.quantity > 1 && <span className="bases-inventory-slot-qty">{slot.quantity.toLocaleString()}</span>}
                      </button>
                    // Deliberately says nothing about which slot: the click is a
                    // shortcut to the add form, not a placement target, and the
                    // server always appends to the next free index. tabIndex=-1
                    // because a 45-slot container holding three items would
                    // otherwise wedge 42 tab stops between the grid and the
                    // controls below it -- the header button is the keyboard
                    // route to the identical action.
                    : <button
                        className="bases-inventory-slot-cell empty"
                        key={`empty-${index}`}
                        type="button"
                        tabIndex={-1}
                        disabled={!addAllowed || containerFull}
                        aria-label="Add an item to this container"
                        title={addAllowed
                          ? (containerFull ? containerFullReason : "Add an item to this container")
                          : (addUnavailableReason || "Adding items is unavailable for this container.")}
                        onClick={() => openAddPanel()}
                      />)}
                </div>}

                {showGrid && overflow.length > 0 && <p className="muted bases-inventory-slot-overflow-note">
                  {/* position_index has no unique constraint and is not bounded
                      by max_item_count, so a slot can duplicate another or sit
                      past the end of the grid. Listed rather than dropped. */}
                  {overflow.length.toLocaleString()} {overflow.length === 1 ? "item has" : "items have"} no place in the grid — a duplicate or out-of-range slot number.
                </p>}

                {rows.length > 0 && <div className="bases-inventory-contents-list">
                  {!showGrid && <div className="bases-inventory-contents-row head">
                    <span /><span>Item</span><span>Slot</span><span>Qty</span><span />
                  </div>}
                  {rows.map((slot) => (
                    <div
                      className={`bases-inventory-contents-row${selectedSlotId === slot.itemId ? " selected" : ""}`}
                      key={slot.itemId}
                    >
                      <CatalogItemThumb item={{ id: slot.templateId, itemId: slot.templateId, name: slot.name, image: itemImage(slot.templateId) }} small />
                      <button
                        className="bases-inventory-contents-name"
                        title={slot.templateId}
                        aria-pressed={selectedSlotId === slot.itemId}
                        onClick={() => selectSlot(slot)}
                      >{slot.name}</button>
                      <span className="bases-inventory-contents-slot muted">
                        {slot.positionIndex === null ? "—" : `#${slot.positionIndex}`}
                      </span>
                      <span className="bases-inventory-contents-qty">{slot.quantity.toLocaleString()}</span>
                      <button
                        className="icon-toggle-button danger"
                        title="Delete this stack"
                        aria-label={`Delete ${slot.name} from slot ${slot.positionIndex ?? "unknown"}`}
                        disabled={!deleteAllowed || deletingItemId === slot.itemId}
                        onClick={() => void deleteSlot(slot, slot.quantity, containerLabel(openContainer))}
                      ><Trash2 size={15} /></button>
                    </div>
                  ))}
                </div>}
              </div>
            );
          })}

          </div>}

          {addOpen && <div className="bases-inventory-add-panel">
            <div className="bases-inventory-add-head">
              <h4>Add Item</h4>
              <span className="muted">
                {openContainer.usedSlots.toLocaleString()} / {openContainer.maxSlots.toLocaleString()} slots used
              </span>
            </div>
            {/* The one sentence that states both contracts the backend
                enforces. It stays visible for the whole form, not just at
                submit time. */}
            <p className="muted bases-inventory-add-note">
              Appends to the next free slot. Existing stacks are never topped up — this always creates a new slot.
            </p>

            <ItemCatalogSelector label="Select item to add" selected={addItem} onSelect={setAddItem} />

            <div className="bases-inventory-add-controls">
              <label className="bases-inventory-add-field">
                <span>Quantity</span>
                <input
                  type="number"
                  min={1}
                  max={1000000}
                  value={addQuantity}
                  aria-label="Quantity to add"
                  onChange={(event) => setAddQuantity(event.target.value)}
                />
              </label>
              <label className="bases-inventory-add-field">
                <span>Grade</span>
                <ItemGradeSelect
                  value={addGrade}
                  minGrade={catalogItemMinimumGrade(addItem)}
                  onChange={setAddGrade}
                />
              </label>
              {addAugmentOptions.length > 0 && <>
                <div className="bases-inventory-add-field bases-inventory-add-augments">
                  <span>Augments</span>
                  <AugmentDropdown
                    options={addAugmentOptions}
                    value={addAugments}
                    maxSelected={addAugmentLimit}
                    onChange={(selected) => setAddAugments(selected.slice(0, addAugmentLimit))}
                  />
                </div>
                <label className="bases-inventory-add-field">
                  <span>Aug. Grade</span>
                  <ItemGradeSelect
                    value={addAugmentGrade}
                    minGrade={1}
                    disabled={addAugments.length === 0}
                    emptyWhenDisabled
                    onChange={setAddAugmentGrade}
                  />
                </label>
              </>}
            </div>

            {addItem && !addQuantityValid && <p className="bases-inventory-amount-error" role="alert">
              Enter a quantity between 1 and 1,000,000.
            </p>}
            {containerFull && <p className="bases-inventory-amount-error" role="status">{containerFullReason}</p>}

            <div className="bases-inventory-add-actions">
              <button
                className="primary"
                disabled={!addAllowed || containerFull || !addItem || !addQuantityValid || adding}
                onClick={() => void addToContainer(containerLabel(openContainer))}
              >{adding ? "Adding…" : "Add to container"}</button>
              <button onClick={() => { setAddOpen(false); resetAddForm(); }}>Cancel</button>
            </div>
          </div>}

          {selectedSlot && <div className="bases-inventory-slot-detail">
            <CatalogItemThumb item={{ id: selectedSlot.templateId, itemId: selectedSlot.templateId, name: selectedSlot.name, image: itemImage(selectedSlot.templateId) }} />
            <div className="bases-inventory-slot-detail-body">
              <strong>{selectedSlot.name}</strong>
              <span className="muted">
                {selectedSlot.positionIndex === null ? "Unplaced" : `Slot #${selectedSlot.positionIndex}`}
                {" · "}{selectedSlot.quantity.toLocaleString()} held
                {" · "}Grade {selectedSlot.qualityLevel}
                {selectedSlot.currentDurability !== null && selectedSlot.maxDurability
                  ? ` · ${Math.round((selectedSlot.currentDurability / selectedSlot.maxDurability) * 100)}% durability`
                  : ""}
              </span>
              {/* Its own line, and only when the item actually has any -- a
                  raw resource or an unaugmented item never carries this. */}
              {selectedSlot.augments.length > 0 && <span className="muted">
                Augments: {selectedSlot.augments.map((augment) => `${augment.name} (Grade ${augment.qualityLevel})`).join(", ")}
              </span>}
            </div>
            <label className="bases-inventory-slot-amount">
              <span>Remove</span>
              <input
                type="number"
                min={1}
                max={selectedSlot.quantity}
                value={amount}
                aria-label={`Amount of ${selectedSlot.name} to remove`}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <button
              className="danger"
              disabled={!deleteAllowed || !amountValid || deletingItemId === selectedSlot.itemId}
              onClick={() => void deleteSlot(selectedSlot, Number(amount), containerLabel(openContainer))}
            >{Number(amount) >= selectedSlot.quantity ? "Delete stack" : `Remove ${Number(amount).toLocaleString()}`}</button>
          </div>}
          {selectedSlot && !amountValid && <p className="bases-inventory-amount-error" role="alert">
            Enter an amount between 1 and {selectedSlot.quantity.toLocaleString()}.
          </p>}

          {/* Hidden entirely while the add panel is open, not just disabled:
              its own action row (Add to container / Cancel) is the footer in
              that state, and Cancel already returns here -- a second Close
              next to it would be a redundant way to leave. The X in the
              header and Escape both still close the whole overlay. */}
          {!addOpen && <div className="confirm-modal-actions confirm-modal-actions-grouped">
            {/* List-view only: grid's own empty cells already open this panel,
                so a second, redundant control there would just be noise. List
                enumerates occupied slots only and has no empty cell to click,
                which is why it needs an explicit affordance. */}
            {contentsView === "list"
              ? <button
                  className="bases-inventory-add-item"
                  aria-expanded={addOpen}
                  disabled={!addAllowed || containerFull}
                  title={addAllowed
                    ? (containerFull ? containerFullReason : "Add an item to this container")
                    : (addUnavailableReason || "Adding items is unavailable for this container.")}
                  onClick={() => openAddPanel()}
                ><Plus size={14} aria-hidden="true" /> Add Item</button>
              : <span />}
            <button onClick={() => setContentsFor("")}>Close</button>
          </div>}
        </section>
      </div>}
    </div>
  );
}
