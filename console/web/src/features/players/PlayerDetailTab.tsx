import { useEffect, useState } from "react";
import { Circle, X } from "lucide-react";
import { playersApi } from "../../api/players";
import { databaseApi } from "../../api/database";
import { DataTable, useSortableRows } from "../../components/common/DataTable";
import { TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { formatUiSentence } from "../../lib/display";
import { serializeEditableDbValue, parseEditableDbValue } from "../../lib/dbValues";

const EDITABLE_INVENTORY_COLUMNS = ["template_id", "stack_size", "quality_level", "position_index", "inventory_id", "stats"];

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
  data,
  rows,
  emptyMessage,
  onReload,
  onError,
  onActionLog,
  confirmAction,
  formatMutationResult
}: {
  playerId: string;
  data: Record<string, unknown> | null;
  rows: Record<string, unknown>[];
  emptyMessage: string;
  onReload: () => void;
  onError: (text: string) => void;
  onActionLog?: (actionType: string, target: string, amount: string, notes: string) => void;
  confirmAction: ConfirmAction;
  formatMutationResult: (result: unknown) => string;
}) {
  const [message, setMessage] = useState("");
  const [messageDetails, setMessageDetails] = useState("");
  const [editRow, setEditRow] = useState<Record<string, unknown> | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [editSaving, setEditSaving] = useState(false);

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
      onReload();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text);
      setMessageDetails("");
      onActionLog?.("Delete Inventory Item", templateId, "1", `Failed: ${text}`);
      onError(text);
    }
  }

  function startEditItem(row: Record<string, unknown>) {
    setEditRow(row);
    setEditValues(Object.fromEntries(EDITABLE_INVENTORY_COLUMNS.map((column) => [column, serializeEditableDbValue(row[column])])));
  }

  async function saveEditItem() {
    if (!editRow) return;
    const templateId = String(editRow.template_id || "Unknown item");
    setEditSaving(true);
    try {
      const values = Object.fromEntries(EDITABLE_INVENTORY_COLUMNS.map((column) => [column, parseEditableDbValue(editValues[column] ?? "", editRow[column])]));
      const rowId = JSON.stringify({ pk: { id: editRow.id } });
      const response = await databaseApi.updateRow("dune", "items", rowId, values);
      setMessage(formatMutationResult(response));
      setMessageDetails(JSON.stringify(response, null, 2));
      onActionLog?.("Edit Inventory Item", templateId, "1", response.updatedRows ? "Succeeded" : "No rows updated");
      setEditRow(null);
      onReload();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text);
      setMessageDetails("");
      onActionLog?.("Edit Inventory Item", templateId, "1", `Failed: ${text}`);
      onError(text);
    } finally {
      setEditSaving(false);
    }
  }

  function renderEditPanel(row: Record<string, unknown>) {
    return <div className="result-panel database-edit-panel">
      <div className="panel-title"><strong>Edit Inventory Item</strong></div>
      <p className="playerAdmin_note">Item ID: {String(row.id)} · {String(row.template_id)}</p>
      <div className="database-edit-grid">
        {EDITABLE_INVENTORY_COLUMNS.map((column) => <label key={column}>{column}<textarea rows={2} value={editValues[column] || ""} onChange={(event) => setEditValues({ ...editValues, [column]: event.target.value })} /></label>)}
      </div>
      <div className="action-line">
        <button disabled={editSaving} onClick={() => void saveEditItem()}>{editSaving ? "Saving..." : "Save Item"}</button>
        <button onClick={() => setEditRow(null)}>Cancel</button>
      </div>
    </div>;
  }

  const inventorySort = useSortableRows(rows);

  return <div>
    {data?.reason ? <p className="danger-note">{formatUiSentence(data.reason)}</p> : null}
    {message && <div className="result-panel transient-result"><strong>Mutation Result.</strong><p>{formatUiSentence(message)}</p>{messageDetails && <TechnicalDetails text={messageDetails} />}</div>}
    <DataTable
      rows={inventorySort.sortedRows}
      emptyMessage={emptyMessage}
      actionClassName="actions-column"
      action={(row) => <span className="icon-toggle-group">
        <button className="icon-toggle-button success" title="Edit item" aria-label="Edit item" onClick={(event) => { event.stopPropagation(); startEditItem(row); }}><Circle size={16} /></button>
        <button className="icon-toggle-button danger" title="Delete item" aria-label="Delete item" onClick={(event) => { event.stopPropagation(); void deleteItem(row); }}><X size={16} /></button>
      </span>}
      sortColumn={inventorySort.sortColumn}
      sortDirection={inventorySort.sortDirection}
      onSort={inventorySort.onSort}
      resizableColumns
      isRowExpanded={(row) => editRow !== null && String(row.id) === String(editRow.id)}
      renderExpandedRow={(row) => renderEditPanel(row)}
    />
  </div>;
}
