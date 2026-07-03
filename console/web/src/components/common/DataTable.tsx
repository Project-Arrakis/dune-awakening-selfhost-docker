import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { formatCell, friendlyColumnName } from "../../lib/display";

export type SortDirection = "asc" | "desc";
type SortState = { column: string; direction: SortDirection };

export function compareTableValues(a: unknown, b: unknown, direction: SortDirection) {
  const aNum = Number(a);
  const bNum = Number(b);
  const bothNumeric = a !== null && a !== undefined && a !== "" && b !== null && b !== undefined && b !== "" && !Number.isNaN(aNum) && !Number.isNaN(bNum);
  const result = bothNumeric ? aNum - bNum : String(a ?? "").localeCompare(String(b ?? ""), undefined, { sensitivity: "base" });
  return direction === "asc" ? result : -result;
}

export function useSortState() {
  const [sort, setSort] = useState<SortState | null>(null);
  function onSort(column: string) {
    setSort((current) => (current?.column === column ? { column, direction: current.direction === "asc" ? "desc" : "asc" } : { column, direction: "asc" }));
  }
  return { sortColumn: sort?.column, sortDirection: sort?.direction, onSort, reset: () => setSort(null) };
}

export function useSortableRows<T extends Record<string, unknown>>(rows: T[]) {
  const sortState = useSortState();
  const sortedRows = sortState.sortColumn ? [...rows].sort((a, b) => compareTableValues(a[sortState.sortColumn!], b[sortState.sortColumn!], sortState.sortDirection!)) : rows;
  return { ...sortState, sortedRows };
}

const MIN_COLUMN_WIDTH = 60;

export function useResizableColumns() {
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const resizeState = useRef<{ column: string; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    function onMouseMove(event: MouseEvent) {
      const state = resizeState.current;
      if (!state) return;
      const width = Math.max(MIN_COLUMN_WIDTH, state.startWidth + (event.clientX - state.startX));
      setColWidths((current) => ({ ...current, [state.column]: width }));
    }
    function onMouseUp() {
      if (!resizeState.current) return;
      resizeState.current = null;
      document.body.classList.remove("col-resizing");
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  function startResize(event: ReactMouseEvent<HTMLSpanElement>, column: string) {
    event.preventDefault();
    event.stopPropagation();
    const th = event.currentTarget.parentElement as HTMLTableCellElement;
    resizeState.current = { column, startX: event.clientX, startWidth: th.offsetWidth };
    document.body.classList.add("col-resizing");
  }

  function columnStyle(column: string) {
    return colWidths[column] ? { width: colWidths[column], minWidth: colWidths[column], maxWidth: colWidths[column] } : undefined;
  }

  function resizeHandle(column: string) {
    return <span className="col-resize-handle" onMouseDown={(event) => startResize(event, column)} onClick={(event) => event.stopPropagation()} />;
  }

  return { columnStyle, resizeHandle };
}

type DataTableProps = {
  rows: Record<string, unknown>[];
  columns?: string[];
  onRowClick?: (row: Record<string, unknown>) => void;
  action?: (row: Record<string, unknown>) => ReactNode;
  actionClassName?: string;
  secondaryAction?: (row: Record<string, unknown>) => ReactNode;
  secondaryActionLabel?: string;
  secondaryActionClassName?: string;
  tableClassName?: string;
  renderCell?: (row: Record<string, unknown>, column: string) => ReactNode;
  emptyMessage?: string;
  sortColumn?: string;
  sortDirection?: SortDirection;
  onSort?: (column: string) => void;
  resizableColumns?: boolean;
};

export function DataTable({
  rows,
  columns,
  onRowClick,
  action,
  actionClassName = "",
  secondaryAction,
  secondaryActionLabel = "Action",
  secondaryActionClassName = "",
  tableClassName = "",
  renderCell,
  emptyMessage = "No rows.",
  sortColumn,
  sortDirection,
  onSort,
  resizableColumns = false
}: DataTableProps) {
  const resize = useResizableColumns();

  const cols = columns?.length ? columns : Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8);
  if (!rows.length) return <div className="empty">{emptyMessage}</div>;
  const colStyle = (col: string) => resizableColumns ? resize.columnStyle(col) : undefined;
  return <div className="table-wrap"><table className={tableClassName}><thead><tr>{cols.map((col) => <th key={col} className={onSort ? "sortable" : ""} style={colStyle(col)} onClick={onSort ? () => onSort(col) : undefined}>{friendlyColumnName(col)}{onSort && sortColumn === col && <span className="sort-indicator">{sortDirection === "desc" ? " ↓" : " ↑"}</span>}{resizableColumns && resize.resizeHandle(col)}</th>)}{action && <th className={actionClassName}>Actions</th>}{secondaryAction && <th className={secondaryActionClassName}>{secondaryActionLabel}</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} onClick={() => onRowClick?.(row)} className={onRowClick ? "clickable" : ""}>{cols.map((col) => <td key={col} style={colStyle(col)}>{renderCell ? renderCell(row, col) : formatCell(row[col])}</td>)}{action && <td className={actionClassName}>{action(row)}</td>}{secondaryAction && <td className={secondaryActionClassName}>{secondaryAction(row)}</td>}</tr>)}</tbody></table></div>;
}
