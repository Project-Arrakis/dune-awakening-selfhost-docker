import { useEffect, useState, useMemo } from "react";
import { api, post } from "../../api/client";

interface PolicyStatement {
  Effect: "Allow" | "Deny";
  Action: string[];
}

interface PolicyCatalog {
  policies: Record<string, { version: number; tier: string; statements: PolicyStatement[] }>;
  actions: string[];
  namespaces: Record<string, string>;
}

const TIERS = ["owner", "admin", "moderator", "player"] as const;

function parseStatements(text: string): PolicyStatement[] | null {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    for (const stmt of parsed) {
      if (!stmt.Effect || !["Allow", "Deny"].includes(stmt.Effect)) return null;
      if (!stmt.Action || (!Array.isArray(stmt.Action) && typeof stmt.Action !== "string")) return null;
    }
    return parsed;
  } catch { return null; }
}

function allowedActions(statements: PolicyStatement[]): Set<string> {
  const allowed = new Set<string>();
  for (const stmt of statements) {
    if (stmt.Effect !== "Allow") continue;
    for (const a of stmt.Action) allowed.add(a);
  }
  return allowed;
}

function nsFromAction(action: string): string {
  const afterApi = action.split("/api/")[1];
  if (!afterApi) return "other";
  return afterApi.split("/")[0].toLowerCase();
}

function humanLabel(action: string): string {
  const afterApi = action.split("/api/")[1];
  if (!afterApi) return action;
  const method = action.split(" ")[0];
  const segments = afterApi.split("/");
  const tail = segments[segments.length - 1].replace(/-/g, " ");

  if (method === "GET") {
    if (segments.length === 1) return `View ${segments[0]}`;
    if (tail === segments[0]) return `View ${tail}`;
    return `${capitalize(tail)}`;
  }
  if (method === "DELETE") return `Delete ${tail}`;
  if (method === "PUT") return `Update ${tail}`;
  // POST
  if (segments.length === 1) return `Manage ${segments[0]}`;
  const meaningful = segments.slice(1).map(s => s.replace(/-/g, " "));
  return capitalize(meaningful.join(" "));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function namespaceLabel(action: string): string {
  const ns = nsFromAction(action);
  const readable: Record<string, string> = {
    server: "Server", players: "Players", guilds: "Guilds", bases: "Bases",
    storage: "Storage", maps: "Maps", sietches: "Sietches", deepdesert: "Deep Desert",
    admin: "Admin Tools", landsraad: "Landsraad", addons: "Addons",
    carepackage: "Care Package", blueprints: "Blueprints", database: "Database",
    backups: "Backups", logs: "Logs", settings: "Settings", updates: "Updates",
    setup: "Setup", "public-directory": "Public Directory",
  };
  return readable[ns] || capitalize(ns);
}

export function IamPolicyEditor() {
  const [catalog, setCatalog] = useState<PolicyCatalog | null>(null);
  const [selectedTier, setSelectedTier] = useState<string>("admin");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editorTab, setEditorTab] = useState<"builder" | "json" | "test">("builder");
  const [testResults, setTestResults] = useState<Record<string, boolean> | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<PolicyCatalog>("/api/settings/iam/policies").then((data) => {
      setCatalog(data);
      const doc = data.policies[selectedTier];
      if (doc) setJsonText(JSON.stringify(doc.statements, null, 2));
    }).catch(() => {});
  }, []);

  const selectTier = (tier: string) => {
    setSelectedTier(tier);
    setSaved(false);
    setTestResults(null);
    setSearch("");
    if (catalog) {
      const doc = catalog.policies[tier];
      setJsonText(doc ? JSON.stringify(doc.statements, null, 2) : "[]");
    }
  };

  const statements = useMemo(() => parseStatements(jsonText) || [], [jsonText]);
  const allowed = useMemo(() => allowedActions(statements), [statements]);

  const namespaceOrder = [
    "server", "players", "guilds", "bases", "storage", "maps",
    "sietches", "deepdesert", "admin", "landsraad", "addons",
    "carepackage", "blueprints", "database", "backups", "logs",
    "settings", "updates", "setup", "public-directory",
  ];

  const groupedActions = useMemo(() => {
    if (!catalog) return {};
    const groups: Record<string, string[]> = {};
    for (const ns of namespaceOrder) groups[ns] = [];
    const other: string[] = [];
    for (const action of new Set(Object.values(catalog.actions))) {
      if (typeof action !== "string") continue;
      const ns = nsFromAction(action);
      if (groups[ns]) {
        groups[ns].push(action as string);
      } else {
        other.push(action as string);
      }
    }
    for (const ns of Object.keys(groups)) groups[ns].sort();
    if (other.length) groups["other"] = other.sort();
    return groups;
  }, [catalog]);

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return groupedActions;
    const q = search.toLowerCase();
    const result: Record<string, string[]> = {};
    for (const [ns, actions] of Object.entries(groupedActions)) {
      const matching = actions.filter(a =>
        a.toLowerCase().includes(q) || humanLabel(a).toLowerCase().includes(q)
      );
      if (matching.length) result[ns] = matching;
    }
    return result;
  }, [groupedActions, search]);

  const toggleAction = (action: string) => {
    const stmts = parseStatements(jsonText) || [];
    let updated: PolicyStatement[];

    if (allowed.has(action)) {
      updated = stmts.map(s => {
        if (s.Effect !== "Allow") return s;
        const filtered = s.Action.filter(a => a !== action);
        return { ...s, Action: filtered };
      }).filter(s => s.Action.length > 0);
    } else {
      updated = [...stmts];
      let allowStmt = updated.filter(s => s.Effect === "Allow").pop();
      if (!allowStmt) {
        allowStmt = { Effect: "Allow" as const, Action: [] };
        updated.push(allowStmt);
      }
      allowStmt.Action = [...allowStmt.Action, action];
    }
    setJsonText(JSON.stringify(updated, null, 2));
    setSaved(false);
  };

  const validateJson = (text: string): PolicyStatement[] | null => {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("Must be an array of statements");
      for (const stmt of parsed) {
        if (!stmt.Effect || !["Allow", "Deny"].includes(stmt.Effect)) throw new Error(`Invalid Effect: ${stmt.Effect}`);
        if (!stmt.Action || (!Array.isArray(stmt.Action) && typeof stmt.Action !== "string")) throw new Error("Action must be a string or array");
      }
      setJsonError("");
      return parsed;
    } catch (e: any) {
      setJsonError(e.message);
      return null;
    }
  };

  const savePolicy = async () => {
    const valid = validateJson(jsonText);
    if (!valid || !catalog) return;
    setSaving(true);
    try {
      await post("/api/settings/iam/policy", { tier: selectedTier, statements: valid });
      const policies = { ...catalog.policies, [selectedTier]: { version: 1, tier: selectedTier, statements: valid } };
      setCatalog({ ...catalog, policies });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setJsonError("Failed to save policy");
    }
    setSaving(false);
  };

  const runTest = async () => {
    const valid = validateJson(jsonText);
    if (!valid) return;
    try {
      const res = await post<{ results: Record<string, boolean> }>("/api/settings/iam/policy/test", { statements: valid });
      setTestResults(res.results);
    } catch {}
  };

  if (!catalog) return <section className="iam-editor-loading"><p className="loading-dots">Loading policies</p></section>;

  return (
    <section className="iam-policy-editor">
      <div className="iam-tier-selector">
        {TIERS.map((tier) => (
          <button key={tier} className={`iam-tier-btn ${selectedTier === tier ? "active" : ""}`} onClick={() => selectTier(tier)}>
            {capitalize(tier)}
          </button>
        ))}
      </div>

      <div className="iam-editor-tabs">
        <button className={editorTab === "builder" ? "active" : ""} onClick={() => setEditorTab("builder")}>Permissions</button>
        <button className={editorTab === "json" ? "active" : ""} onClick={() => setEditorTab("json")}>JSON</button>
        <button className={editorTab === "test" ? "active" : ""} onClick={() => { runTest(); setEditorTab("test"); }}>Test</button>
      </div>

      <div className="iam-editor-body">
        {editorTab === "builder" && (
          <>
            <div className="iam-search-bar">
              <input
                type="text"
                placeholder="Search permissions..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button className="iam-search-clear" onClick={() => setSearch("")}>×</button>
              )}
            </div>
            <div className="iam-permission-grid">
              {Object.keys(filteredGroups).length === 0 && (
                <p className="iam-empty-hint">No permissions match your search.</p>
              )}
              {Object.entries(filteredGroups).map(([ns, actions]) => (
                <div key={ns} className="iam-ns-card">
                  <div className="iam-ns-header">
                    <span className="iam-ns-name">{namespaceLabel(actions[0])}</span>
                    <span className="iam-ns-count">
                      {actions.filter(a => allowed.has(a)).length}/{actions.length} allowed
                    </span>
                  </div>
                  <div className="iam-ns-actions">
                    {actions.map((action) => (
                      <label key={action} className={`iam-perm-row ${allowed.has(action) ? "perm-on" : "perm-off"}`}>
                        <input
                          type="checkbox"
                          checked={allowed.has(action)}
                          onChange={() => toggleAction(action)}
                        />
                        <span className="iam-perm-label">{humanLabel(action)}</span>
                        <span className="iam-perm-action" title={action}>{action.split("/api/")[1] || action}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {editorTab === "json" && (
          <div className="iam-json-editor">
            <textarea
              className={`iam-json-textarea ${jsonError ? "has-error" : ""}`}
              value={jsonText}
              onChange={(e) => { setJsonText(e.target.value); setSaved(false); setJsonError(""); }}
              rows={16}
              spellCheck={false}
            />
            {jsonError && <p className="iam-json-error">{jsonError}</p>}
          </div>
        )}

        {editorTab === "test" && (
          <div className="iam-test-panel">
            {!testResults && (
              <button className="stable-action-button" onClick={runTest}>Run test</button>
            )}
            {testResults && (
              <>
                <div className="iam-test-summary">
                  <span className="test-count-allowed">{Object.values(testResults).filter(Boolean).length} allowed</span>
                  <span className="test-count-denied">{Object.values(testResults).filter(v => !v).length} denied</span>
                </div>
                <div className="iam-test-table">
                  {Object.entries(testResults).sort(([, a], [, b]) => (a === b ? 0 : a ? -1 : 1)).map(([action, allowed]) => (
                    <div key={action} className={`iam-test-row ${allowed ? "test-allowed" : "test-denied"}`}>
                      <span className={`test-indicator ${allowed ? "" : "test-blocked"}`}>{allowed ? "✓" : "✗"}</span>
                      <span className="test-action-name">{action}</span>
                    </div>
                  ))}
                </div>
                <button className="stable-action-button" onClick={runTest} style={{marginTop: "0.75rem"}}>Re-run test</button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="iam-editor-footer">
        <button className="stable-action-button" onClick={savePolicy} disabled={saving || (editorTab === "json" && !!jsonError)}>
          {saving ? "Saving..." : saved ? "Saved" : `Save ${selectedTier} policy`}
        </button>
      </div>
    </section>
  );
}
