import { useEffect, useState } from "react";
import { serverApi } from "../../api/server";
import { type Task } from "../../api/setup";
import { worldDataApi } from "../../api/worldData";
import { DataTable } from "../../components/common/DataTable";
import { ItemCatalogCombobox, type CatalogItem } from "../../components/common/ItemCatalog";

type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; warning?: string }) => Promise<boolean>;

// The outcome of a give or fill, shown with the container it was done to.
type ActionResult = { storageId: string; text: string; tone: "done" | "partial" | "failed" };

function wasClamped(response: unknown) {
  const result = (response as { result?: { clamped?: boolean } } | null | undefined)?.result;
  return Boolean(result?.clamped);
}

type StoragePanelProps = {
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
  formatMutationResult: (result: unknown) => string;
  waitForTask: (task: Task) => Promise<Task>;
  // The session's storage:mutate and server:restart-service grants. Without them
  // the matching controls are left out; the API enforces access either way.
  canChangeItems: boolean;
  canRestartServer: boolean;
};

export function StoragePanel({ onError, confirmAction, formatMutationResult, waitForTask, canChangeItems, canRestartServer }: StoragePanelProps) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [itemQuery, setItemQuery] = useState("");
  // While the item list cannot be loaded, the item is typed instead and the route
  // resolves it as a name or an id.
  const [listUnavailable, setListUnavailable] = useState(false);
  const [typedItem, setTypedItem] = useState("");
  const [actionResult, setActionResult] = useState<ActionResult | null>(null);
  const [quantityText, setQuantityText] = useState("1");
  const [canGiveItem, setCanGiveItem] = useState(false);
  const [canFillItem, setCanFillItem] = useState(false);
  const [storageResult, setStorageResult] = useState("");
  const [storageResultIsError, setStorageResultIsError] = useState(false);
  const [restartStatus, setRestartStatus] = useState("");
  const [restartRunning, setRestartRunning] = useState(false);

  async function load() {
    onError("");
    setLoading(true);
    try {
      const result = await worldDataApi.storage();
      setRows(result.rows || []);
      setCanGiveItem(Boolean(result.capabilities?.storageGiveItem));
      setCanFillItem(Boolean(result.capabilities?.storageFillItem));
      setStorageResult("");
      setStorageResultIsError(false);
      setActionResult(null);
      if (!result.capabilities?.storageGiveItem && !result.capabilities?.storageFillItem) {
        setStorageResult("Storage operations require compatible dune.inventories and dune.items tables.");
      }
    } catch (error) {
      setStorageResult(error instanceof Error ? error.message : String(error));
      setStorageResultIsError(true);
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function open(row: Record<string, unknown>) {
    setSelected(row);
    setActionResult((current) => (current?.storageId === String(row.id) ? current : null));
    setItems((await worldDataApi.storageItems(String(row.id))).rows || []);
  }

  function quantity() {
    return Math.max(1, Math.min(1000000, Number(quantityText) || 1));
  }

  // What Give and Fill act on: the fields sent for it and how a confirmation names
  // it. The volume of a typed item is not known to the page, so nothing is said of it.
  const typedTarget = typedItem.trim() ? { label: typedItem, fields: { itemName: typedItem }, unknownVolume: false } : null;
  const chosenTarget = item ? { label: `${item.name} (${item.id})`, fields: { itemId: item.id }, unknownVolume: item.volume === undefined } : null;
  const target = listUnavailable ? typedTarget : chosenTarget;
  const needsChoice = !listUnavailable && !item;

  async function giveStorageItem() {
    if (!selected || !target) return;
    const storageId = String(selected.id);
    onError("");
    setActionResult(null);
    try {
      const question = `Give ${quantity()} x ${target.label} to storage ${storageId}?`;
      const confirmed = target.unknownVolume
        ? await confirmAction(question, { danger: true, warning: "The console does not know this item's volume. While it is in a container, the console cannot give or fill items with a known volume into that container, and the Storage tab cannot remove it." })
        : await confirmAction(question);
      if (!confirmed) return;
      const response = await worldDataApi.storageGiveItem(storageId, { ...target.fields, quantity: quantity(), confirmation: "GIVE ITEM TO STORAGE" });
      setActionResult({ storageId, text: formatMutationResult(response), tone: wasClamped(response) ? "partial" : "done" });
      setItems((await worldDataApi.storageItems(storageId)).rows || []);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setActionResult({ storageId, text, tone: "failed" });
      onError(text);
    }
  }

  async function fillStorageItem() {
    if (!selected || !target) return;
    const storageId = String(selected.id);
    onError("");
    setActionResult(null);
    try {
      if (!(await confirmAction(`Fill container ${storageId} with ${quantity()} x ${target.label}? Only refined resources and components are allowed.`))) return;
      const response = await worldDataApi.storageFillItem(storageId, { ...target.fields, quantity: quantity(), confirmation: "FILL ITEM TO STORAGE" });
      setActionResult({ storageId, text: formatMutationResult(response), tone: wasClamped(response) ? "partial" : "done" });
      setItems((await worldDataApi.storageItems(storageId)).rows || []);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setActionResult({ storageId, text, tone: "failed" });
      onError(text);
    }
  }

  async function applyRestart() {
    onError("");
    try {
      if (!(await confirmAction("Restart the Survival server to apply pending fills? All connected players will be disconnected for a few minutes.", { title: "Restart Survival Server", confirmLabel: "Restart Survival", danger: true }))) return;
      setRestartRunning(true);
      setRestartStatus("Restarting the Survival server...");
      const dispatched = await serverApi.restartService("survival");
      // restartService() may queue the restart instead of dispatching it
      // immediately (the restart-queue/gating feature merged from upstream
      // during #279's reconciliation) -- .task is only present for an
      // immediate dispatch. This button does not yet use restartGate/
      // runGatedRestart the way Server Control's/Services'/Bases' restart
      // actions do (see restartQueueGuard.ts), so a queued response is
      // surfaced as a status message rather than the full gating dialog
      // those panels show. Tracked as a follow-up to give this button the
      // same restartGate treatment.
      if (!dispatched.task) {
        setRestartRunning(false);
        setRestartStatus(dispatched.queued
          ? "Restart was queued instead of applied immediately (players are currently online). Check the Server Control tab to manage the queued restart."
          : "Restart could not be dispatched. Check the Server Control tab for details.");
        return;
      }
      const final = await waitForTask(dispatched.task);
      setRestartRunning(false);
      if (final.status === "succeeded") {
        setRestartStatus("Restart completed. Container fills are now visible in-game.");
      } else if (final.status === "failed") {
        setRestartStatus(`Restart failed: ${final.errorMessage || final.progressMessage || "check the task log for details."}`);
      } else {
        setRestartStatus("Restart is still running. Check the Server Control tab for the latest status.");
      }
    } catch (error) {
      setRestartRunning(false);
      const text = error instanceof Error ? error.message : String(error);
      setRestartStatus(text);
      onError(text);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return <section className="panel"><div className="panel-title"><h2>Storage</h2><button onClick={() => void load()}>Refresh Storage</button>{canRestartServer && <button disabled={restartRunning} onClick={() => void applyRestart()}>Apply Fills (Restart Survival)</button>}</div>{storageResultIsError && <p className="danger-note">{storageResult}</p>}{!storageResultIsError && storageResult && <p className="info-note">{storageResult}</p>}{restartStatus && <p className="info-note">{restartStatus}</p>}{canChangeItems && <p className="info-note">Fills become visible in-game after the Survival server restarts; the restart disconnects players for a few minutes.</p>}{loading ? <p className="info-note"><span className="spinner" aria-hidden="true" /> Loading storage containers...</p> : <DataTable rows={rows} onRowClick={open} />}{selected && <section className="drawer storage-drawer"><h3>Storage {String(selected.id)}</h3><div className="action-row storage-give-row"><a className="button-link" href={worldDataApi.storageExportUrl(String(selected.id))}>Export JSON</a>{canChangeItems && <>{listUnavailable && <input value={typedItem} onChange={(event) => setTypedItem(event.target.value)} placeholder="Item name or ID" aria-label="Item name or ID" />}<ItemCatalogCombobox value={item} onChange={setItem} onQueryChange={setItemQuery} onListUnavailableChange={setListUnavailable} ariaLabel="Item to give or fill" /><input value={quantityText} onChange={(event) => setQuantityText(event.target.value)} className="small-input" type="number" min={1} max={1000000} placeholder="Qty" aria-label="Quantity" /><button disabled={!target || !canGiveItem || restartRunning} onClick={() => void giveStorageItem()} title={!canGiveItem ? "Storage give-item schema not detected" : needsChoice ? "Choose an item from the list first." : ""} aria-describedby={needsChoice && itemQuery.trim() ? "storage-choose-item" : undefined}>Give Item</button><button disabled={!target || !canFillItem || restartRunning} onClick={() => void fillStorageItem()} title={!canFillItem ? "Storage fill-item schema not detected" : needsChoice ? "Choose an item from the list first." : ""} aria-describedby={needsChoice && itemQuery.trim() ? "storage-choose-item" : undefined}>Fill Container</button></>}</div>{canChangeItems && <>{needsChoice && itemQuery.trim() && <p className="info-note" id="storage-choose-item">Choose an item from the list first.</p>}{actionResult && actionResult.storageId === String(selected.id) && <p className={actionResult.tone === "failed" ? "danger-note" : actionResult.tone === "partial" ? "confirm-modal-warning" : "info-note"} role={actionResult.tone === "failed" ? "alert" : "status"}>{actionResult.text}</p>}{item && item.volume === undefined && <p className="info-note">The console does not know this item's volume. While it is in a container, items with a known volume cannot be given into that container.</p>}<p className="info-note">Fill Container accepts refined resources and components only, respecting slot and volume limits.</p></>}<DataTable rows={items} /></section>}</section>;
}
