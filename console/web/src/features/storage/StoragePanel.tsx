import { useEffect, useState } from "react";
import { serverApi } from "../../api/server";
import { type Task } from "../../api/setup";
import { worldDataApi } from "../../api/worldData";
import { DataTable } from "../../components/common/DataTable";

type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>;

type StoragePanelProps = {
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
  formatMutationResult: (result: unknown) => string;
  waitForTask: (task: Task) => Promise<Task>;
};

export function StoragePanel({ onError, confirmAction, formatMutationResult, waitForTask }: StoragePanelProps) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [itemName, setItemName] = useState("");
  const [quantityText, setQuantityText] = useState("100");
  const [canGiveItem, setCanGiveItem] = useState(false);
  const [canFillItem, setCanFillItem] = useState(false);
  const [storageResult, setStorageResult] = useState("Give Item to Storage runs only when the backend verifies the storage schema.");
  const [restartStatus, setRestartStatus] = useState("");
  const [restartRunning, setRestartRunning] = useState(false);

  async function load() {
    onError("");
    try {
      const result = await worldDataApi.storage();
      setRows(result.rows || []);
      setCanGiveItem(Boolean(result.capabilities?.storageGiveItem));
      setCanFillItem(Boolean(result.capabilities?.storageFillItem));
      if (!result.capabilities?.storageGiveItem) setStorageResult("Storage give-item is unsupported until this database exposes compatible dune.inventories and dune.items insert columns.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function open(row: Record<string, unknown>) {
    setSelected(row);
    setItems((await worldDataApi.storageItems(String(row.id))).rows || []);
  }

  function quantity() {
    return Math.max(1, Math.min(1000000, Number(quantityText) || 1));
  }

  async function giveStorageItem() {
    if (!selected) return;
    onError("");
    try {
      if (!(await confirmAction(`Give ${quantity()} x ${itemName} to storage ${String(selected.id)}?`))) return;
      const response = await worldDataApi.storageGiveItem(String(selected.id), { itemName, quantity: quantity(), confirmation: "GIVE ITEM TO STORAGE" });
      setStorageResult(formatMutationResult(response));
      setItems((await worldDataApi.storageItems(String(selected.id))).rows || []);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setStorageResult(text);
      onError(text);
    }
  }

  async function fillStorageItem() {
    if (!selected) return;
    onError("");
    try {
      if (!(await confirmAction(`Fill container ${String(selected.id)} with ${quantity()} x ${itemName}? Only refined resources and components are allowed.`))) return;
      const response = await worldDataApi.storageFillItem(String(selected.id), { itemName, quantity: quantity(), confirmation: "FILL ITEM TO STORAGE" });
      setStorageResult(formatMutationResult(response));
      setItems((await worldDataApi.storageItems(String(selected.id))).rows || []);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setStorageResult(text);
      onError(text);
    }
  }

  async function applyRestart() {
    onError("");
    try {
      if (!(await confirmAction("Restart the Survival server to apply pending fills? All connected players will be disconnected for a few minutes.", { title: "Restart Survival Server", confirmLabel: "Restart Survival", danger: true }))) return;
      setRestartRunning(true);
      setRestartStatus("Restarting the Survival server...");
      const final = await waitForTask((await serverApi.restartService("survival")).task);
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

  return <section className="panel"><div className="panel-title"><h2>Storage</h2><button onClick={() => void load()}>Refresh Storage</button><button disabled={restartRunning} onClick={() => void applyRestart()}>Apply Fills (Restart Survival)</button></div><p className="danger-note">{storageResult}</p>{restartStatus && <p className="info-note">{restartStatus}</p>}<p className="info-note">Fills become visible in-game after the Survival server restarts; the restart disconnects players for a few minutes.</p><DataTable rows={rows} onRowClick={open} />{selected && <section className="drawer"><h3>Storage {String(selected.id)}</h3><div className="action-row"><a className="button-link" href={worldDataApi.storageExportUrl(String(selected.id))}>Export JSON</a><input value={itemName} onChange={(event) => setItemName(event.target.value)} placeholder="Item name or ID" /><input value={quantityText} onChange={(event) => setQuantityText(event.target.value)} className="small-input" type="number" min={1} max={1000000} placeholder="Qty" /><button disabled={!canGiveItem || restartRunning} onClick={() => void giveStorageItem()}>Give Item</button><button disabled={!canFillItem || restartRunning} onClick={() => void fillStorageItem()}>Fill Container</button></div><p className="info-note">Fill Container accepts refined resources and components only, respecting slot and volume limits.</p><DataTable rows={items} /></section>}</section>;
}
