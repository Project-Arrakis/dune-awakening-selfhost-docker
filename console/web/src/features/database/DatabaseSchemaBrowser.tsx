import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Search, SquareTerminal, X } from "lucide-react";
import { databaseApi, type DatabaseRoutine, type DatabaseRoutineDefinition } from "../../api/database";

type DatabaseTable = Record<string, unknown>;
type DatabaseColumn = Record<string, unknown>;

type DatabaseSchemaBrowserProps = {
  schema: string;
  tables: DatabaseTable[];
  onCreateQuery: (query: string) => void;
};

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedIdentifier(schema: string, table: string) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function DatabaseSchemaBrowser({ schema, tables, onCreateQuery }: DatabaseSchemaBrowserProps) {
  const [browserMode, setBrowserMode] = useState<"tables" | "routines">("tables");
  const [filter, setFilter] = useState("");
  const [expandedTable, setExpandedTable] = useState("");
  const [columnsByTable, setColumnsByTable] = useState<Record<string, DatabaseColumn[]>>({});
  const [loadingTable, setLoadingTable] = useState("");
  const [errorsByTable, setErrorsByTable] = useState<Record<string, string>>({});
  const [routines, setRoutines] = useState<DatabaseRoutine[]>([]);
  const [routinesLoading, setRoutinesLoading] = useState(false);
  const [routinesError, setRoutinesError] = useState("");
  const [routineKind, setRoutineKind] = useState<"all" | "function" | "procedure">("all");
  const [expandedRoutine, setExpandedRoutine] = useState("");
  const [routineDefinitions, setRoutineDefinitions] = useState<Record<string, DatabaseRoutineDefinition>>({});
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredTables = useMemo(() => {
    if (!normalizedFilter) return tables;
    return tables.filter((table) => {
      const tableName = String(table.name || "");
      const columns = columnsByTable[tableName] || [];
      return `${String(table.schema || schema)}.${tableName}`.toLowerCase().includes(normalizedFilter)
        || columns.some((column) => String(column.name || "").toLowerCase().includes(normalizedFilter));
    });
  }, [columnsByTable, normalizedFilter, schema, tables]);
  const filteredRoutines = useMemo(() => routines.filter((routine) => {
    if (routineKind !== "all" && routine.kind !== routineKind) return false;
    if (!normalizedFilter) return true;
    return `${routine.schema}.${routine.name} ${routine.arguments} ${routine.result_type || ""} ${routine.language}`
      .toLowerCase()
      .includes(normalizedFilter);
  }), [normalizedFilter, routineKind, routines]);

  async function loadRoutines() {
    setRoutinesLoading(true);
    setRoutinesError("");
    try {
      setRoutines(await databaseApi.routines(schema));
    } catch (error) {
      setRoutinesError(error instanceof Error ? error.message : String(error));
    } finally {
      setRoutinesLoading(false);
    }
  }

  useEffect(() => {
    if (browserMode === "routines" && routines.length === 0 && !routinesLoading) void loadRoutines();
  }, [browserMode, schema]);

  async function toggleTable(tableName: string) {
    if (expandedTable === tableName) {
      setExpandedTable("");
      return;
    }
    setExpandedTable(tableName);
    if (columnsByTable[tableName]) return;
    setLoadingTable(tableName);
    setErrorsByTable((current) => ({ ...current, [tableName]: "" }));
    try {
      const nextColumns = await databaseApi.columns(schema, tableName);
      setColumnsByTable((current) => ({ ...current, [tableName]: nextColumns }));
    } catch (error) {
      setErrorsByTable((current) => ({
        ...current,
        [tableName]: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setLoadingTable((current) => current === tableName ? "" : current);
    }
  }

  async function toggleRoutine(routine: DatabaseRoutine) {
    if (expandedRoutine === routine.oid) {
      setExpandedRoutine("");
      return;
    }
    setExpandedRoutine(routine.oid);
    if (routineDefinitions[routine.oid]) return;
    try {
      const definition = await databaseApi.routineDefinition(routine.oid);
      setRoutineDefinitions((current) => ({ ...current, [routine.oid]: definition }));
    } catch (error) {
      setRoutinesError(error instanceof Error ? error.message : String(error));
    }
  }

  function routineQuery(routine: DatabaseRoutine) {
    const target = `${quoteIdentifier(routine.schema)}.${quoteIdentifier(routine.name)}`;
    const argumentHint = routine.arguments ? `/* ${routine.arguments} */` : "";
    return routine.kind === "procedure"
      ? `CALL ${target}(${argumentHint});`
      : `SELECT ${target}(${argumentHint});`;
  }

  return <section className="database-schema-browser" aria-label="Database objects">
    <div className="database-browser-tabs" role="tablist" aria-label="Database object type">
      <button className={browserMode === "tables" ? "active" : ""} role="tab" aria-selected={browserMode === "tables"} onClick={() => setBrowserMode("tables")}>Tables</button>
      <button className={browserMode === "routines" ? "active" : ""} role="tab" aria-selected={browserMode === "routines"} onClick={() => setBrowserMode("routines")}>Functions &amp; Procedures</button>
    </div>
    <div className="database-schema-filter">
      <Search size={17} aria-hidden="true" />
      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={browserMode === "tables" ? "Filter table or loaded column names" : "Filter names, arguments, return types, or languages"}
        aria-label={`Filter database ${browserMode}`}
      />
      {filter && <button className="icon-button" onClick={() => setFilter("")} title="Clear schema filter" aria-label="Clear schema filter"><X size={17} /></button>}
    </div>
    {browserMode === "tables" && <div className="database-schema-list" role="tabpanel">
      <div className="database-schema-table-header" aria-hidden="true">
        <span />
        <span>Table</span>
        <span>Rows</span>
        <span />
      </div>
      {filteredTables.map((table) => {
        const tableSchema = String(table.schema || schema);
        const tableName = String(table.name || "");
        const isExpanded = expandedTable === tableName;
        const columns = columnsByTable[tableName] || [];
        const error = errorsByTable[tableName];
        return <div className="database-schema-table" key={`${tableSchema}.${tableName}`}>
          <div className="database-schema-table-row">
            <button
              className="icon-button"
              onClick={() => void toggleTable(tableName)}
              title={isExpanded ? `Collapse ${tableName}` : `Show columns for ${tableName}`}
              aria-label={isExpanded ? `Collapse ${tableName}` : `Show columns for ${tableName}`}
              aria-expanded={isExpanded}
            >
              {isExpanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
            </button>
            <code>{tableSchema}.{tableName}</code>
            <span>{String(table.row_count ?? "")}</span>
            <button
              className="icon-button"
              onClick={() => onCreateQuery(`SELECT *\nFROM ${qualifiedIdentifier(tableSchema, tableName)}\nLIMIT 25;`)}
              title={`Create query for ${tableSchema}.${tableName}`}
              aria-label={`Create query for ${tableSchema}.${tableName}`}
            ><SquareTerminal size={17} /></button>
          </div>
          {isExpanded && <div className="database-schema-columns">
            <div className="database-schema-column-header" aria-hidden="true">
              <span>Column</span>
              <span>Type</span>
              <span>Null</span>
              <span>Default</span>
              <span />
            </div>
            {loadingTable === tableName && <div className="database-schema-message">Loading columns...</div>}
            {error && <div className="database-schema-message danger-note">{error}</div>}
            {!error && loadingTable !== tableName && columns.length === 0 && <div className="database-schema-message">No columns found.</div>}
            {columns.map((column) => {
              const columnName = String(column.name || "");
              const nullable = String(column.is_nullable || "").toUpperCase() === "YES";
              const defaultValue = column.column_default === null || column.column_default === undefined
                ? ""
                : String(column.column_default);
              return <div className="database-schema-column-row" key={columnName}>
                <code>{columnName}</code>
                <span>{String(column.data_type || "")}</span>
                <span>{nullable ? "Nullable" : "Required"}</span>
                <code title={defaultValue}>{defaultValue || "-"}</code>
                <button
                  className="icon-button"
                  onClick={() => onCreateQuery(`SELECT ${quoteIdentifier(columnName)}\nFROM ${qualifiedIdentifier(tableSchema, tableName)}\nLIMIT 25;`)}
                  title={`Create query for ${columnName}`}
                  aria-label={`Create query for ${columnName}`}
                ><SquareTerminal size={16} /></button>
              </div>;
            })}
          </div>}
        </div>;
      })}
      {filteredTables.length === 0 && <div className="database-schema-message">No matching tables found.</div>}
    </div>}
    {browserMode === "routines" && <div className="database-routines-panel" role="tabpanel">
      <div className="database-routine-toolbar">
        <label>Type<select value={routineKind} onChange={(event) => setRoutineKind(event.target.value as typeof routineKind)}>
          <option value="all">All routines</option>
          <option value="function">Functions</option>
          <option value="procedure">Procedures</option>
        </select></label>
        <button disabled={routinesLoading} onClick={() => void loadRoutines()}><RefreshCw size={16} />{routinesLoading ? "Loading..." : "Refresh"}</button>
        <span className="muted">{filteredRoutines.length} shown</span>
      </div>
      {routinesError && <div className="database-schema-message danger-note">{routinesError}</div>}
      <div className="database-routine-list">
        <div className="database-routine-header" aria-hidden="true"><span /><span>Routine</span><span>Type</span><span>Returns</span><span /></div>
        {routinesLoading && routines.length === 0 && <div className="database-schema-message">Loading functions and procedures...</div>}
        {!routinesLoading && filteredRoutines.length === 0 && <div className="database-schema-message">No matching functions or procedures found.</div>}
        {filteredRoutines.map((routine) => {
          const expanded = expandedRoutine === routine.oid;
          const definition = routineDefinitions[routine.oid];
          return <div className="database-routine" key={routine.oid}>
            <div className="database-routine-row">
              <button className="icon-button" onClick={() => void toggleRoutine(routine)} aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} definition for ${routine.name}`}>{expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button>
              <div><code>{routine.schema}.{routine.name}</code><small>{routine.arguments || "No arguments"}</small></div>
              <span>{routine.kind}</span>
              <code title={routine.result_type || "No return value"}>{routine.result_type || "-"}</code>
              <button className="icon-button" onClick={() => onCreateQuery(routineQuery(routine))} title={`Create query for ${routine.name}`} aria-label={`Create query for ${routine.name}`}><SquareTerminal size={17} /></button>
            </div>
            {expanded && <div className="database-routine-definition">
              <div className="database-routine-meta"><span>Language: <strong>{routine.language}</strong></span><span>Owner: <strong>{routine.owner}</strong></span>{routine.description && <span>{routine.description}</span>}</div>
              {definition ? <pre><code>{definition.definition}</code></pre> : <div className="database-schema-message">Loading definition...</div>}
            </div>}
          </div>;
        })}
      </div>
    </div>}
  </section>;
}
