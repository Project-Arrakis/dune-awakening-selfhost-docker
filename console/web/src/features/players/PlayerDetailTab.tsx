import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { playersApi } from "../../api/players";
import { DataTable, useSortableRows } from "../../components/common/DataTable";
import { TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { formatUiSentence } from "../../lib/display";

type ConfirmAction = (
  message: string,
  options?: {
    title?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[];
  }
) => Promise<boolean>;

export function PlayerDetailTab({
  playerId,
  tab,
  onError,
  onActionLog,
  confirmAction,
  formatMutationResult
}: {
  playerId: string;
  tab: string;
  onError: (text: string) => void;
  onActionLog?: (actionType: string, target: string, amount: string, notes: string) => void;
  confirmAction: ConfirmAction;
  formatMutationResult: (result: unknown) => string;
}) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("");
  const [messageDetails, setMessageDetails] = useState("");

  async function loadTab() {
    const loaders: Record<string, () => Promise<Record<string, unknown>>> = {
      inventory: () => playersApi.inventory(playerId),
      currency: () => playersApi.currency(playerId),
      factions: () => playersApi.factions(playerId),
      specs: () => playersApi.specs(playerId),
      position: () => playersApi.position(playerId),
      progression: () => playersApi.progression(playerId),
      events: () => playersApi.events(playerId),
      stats: () => playersApi.stats(playerId),
      history: () => playersApi.history(playerId)
    };
    setData(null);
    setMessage("");
    await loaders[tab]?.().then(setData).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }

  useEffect(() => {
    void loadTab();
  }, [playerId, tab]);

  useEffect(() => {
    if (!message) return undefined;
    const timer = window.setTimeout(() => {
      setMessage("");
      setMessageDetails("");
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [message]);

  async function deleteItem(row: Record<string, unknown>) {
    const itemId = String(row.id || "");
    const templateId = String(row.template_id || "Unknown item");
    if (!(await confirmAction("Delete this inventory item?", {
      title: "Delete Inventory Item",
      confirmLabel: "Delete",
      danger: true,
      details: [
        { label: "Item ID", value: itemId, tone: "danger" },
        { label: "Template", value: templateId, tone: "accent" }
      ]
    }))) return;

    try {
      const response = await playersApi.deleteInventoryItem(playerId, itemId, "DELETE ITEM");
      setMessage(formatMutationResult(response));
      setMessageDetails(JSON.stringify(response, null, 2));
      onActionLog?.("Delete Inventory Item", templateId, "1", "Succeeded");
      await loadTab();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text);
      setMessageDetails("");
      onActionLog?.("Delete Inventory Item", templateId, "1", `Failed: ${text}`);
      onError(text);
    }
  }

  const rows = Array.isArray(data?.rows) ? data.rows as Record<string, unknown>[] : data?.position ? [data.position as Record<string, unknown>] : [];
  const inventorySort = useSortableRows(rows);
  const isInventory = tab === "inventory";

  return <div>
    {data?.reason ? <p className="danger-note">{formatUiSentence(data.reason)}</p> : null}
    {isInventory && <p className="action-help-note">A relog is required to see the change.</p>}
    {message && <div className="result-panel transient-result"><strong>Mutation Result.</strong><p>{formatUiSentence(message)}</p>{messageDetails && <TechnicalDetails text={messageDetails} />}</div>}
    <DataTable
      rows={isInventory ? inventorySort.sortedRows : rows}
      emptyMessage={isInventory ? "No inventory items were found." : "No rows."}
      actionClassName={isInventory ? "actions-column" : ""}
      action={isInventory ? (row) => <button className="icon-toggle-button danger" title="Delete item" aria-label="Delete item" onClick={(event) => { event.stopPropagation(); void deleteItem(row); }}><X size={16} /></button> : undefined}
      sortColumn={isInventory ? inventorySort.sortColumn : undefined}
      sortDirection={isInventory ? inventorySort.sortDirection : undefined}
      onSort={isInventory ? inventorySort.onSort : undefined}
      resizableColumns={isInventory}
    />
  </div>;
}
