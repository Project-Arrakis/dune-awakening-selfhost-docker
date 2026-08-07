import { useEffect, useState, useCallback } from "react";
import { api, post } from "../../api/client";

interface PolicyStatement {
  Effect: "Allow" | "Deny";
  Action: string[];
}

interface PolicyDocument {
  version: number;
  tier: string;
  statements: PolicyStatement[];
}

interface PolicyCatalog {
  policies: Record<string, { version: number; tier: string; statements: PolicyStatement[] }>;
  actions: string[];
  namespaces: Record<string, string>;
}

const TIERS = ["owner", "admin", "moderator", "player"] as const;

export function IamPolicyEditor() {
  const [catalog, setCatalog] = useState<PolicyCatalog | null>(null);
  const [selectedTier, setSelectedTier] = useState<string>("admin");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editorTab, setEditorTab] = useState<"json" | "visual" | "test">("visual");
  const [testResults, setTestResults] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    api<PolicyCatalog>("/api/settings/iam/policies").then((data) => {
      setCatalog(data);
      loadTier(data, selectedTier);
    }).catch(() => {});
  }, []);

  const loadTier = useCallback((cat: PolicyCatalog, tier: string) => {
    const doc = cat.policies[tier];
    if (doc) {
      setJsonText(JSON.stringify(doc.statements, null, 2));
    }
  }, []);

  const selectTier = (tier: string) => {
    setSelectedTier(tier);
    setSaved(false);
    setTestResults(null);
    if (catalog) loadTier(catalog, tier);
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
    const statements = validateJson(jsonText);
    if (!statements || !catalog) return;
    setSaving(true);
    try {
      await post("/api/settings/iam/policy", { tier: selectedTier, statements });
      // Refresh catalog
      const policies = { ...catalog.policies, [selectedTier]: { version: 1, tier: selectedTier, statements } };
      setCatalog({ ...catalog, policies });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setJsonError("Failed to save policy");
    }
    setSaving(false);
  };

  const runTest = async () => {
    const statements = validateJson(jsonText);
    if (!statements) return;
    try {
      const res = await post<{ results: Record<string, boolean> }>("/api/settings/iam/policy/test", { statements });
      setTestResults(res.results);
    } catch {}
  };

  const groupedActions = () => {
    if (!catalog) return {};
    const groups: Record<string, string[]> = {};
    for (const action of new Set(Object.values(catalog.actions))) {
      if (typeof action !== "string") continue;
      const ns = action.includes(":") ? action.split(":")[0] : "other";
      if (!groups[ns]) groups[ns] = [];
      groups[ns].push(action as string);
    }
    // Sort namespaces and actions within
    const sorted: Record<string, string[]> = {};
    for (const ns of Object.keys(groups).sort()) {
      sorted[ns] = groups[ns].sort();
    }
    return sorted;
  };

  const toggleVisualAction = (action: string) => {
    let statements = validateJson(jsonText);
    if (!statements) statements = [];
    // Find if this action is currently explicitly mentioned in any statement
    const updated = [...statements];
    let found = false;
    for (const stmt of updated) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      const idx = actions.indexOf(action);
      if (idx >= 0) {
        actions.splice(idx, 1);
        found = true;
        if (actions.length === 0) {
          // Remove empty statement
          const stmtIdx = updated.indexOf(stmt);
          updated.splice(stmtIdx, 1);
        }
        break;
      }
    }
    if (!found) {
      // Add to the last Allow statement, or create one
      let allowStmt = updated.filter(s => s.Effect === "Allow").pop();
      if (!allowStmt) {
        allowStmt = { Effect: "Allow", Action: [] };
        updated.push(allowStmt);
      }
      (allowStmt.Action as string[]).push(action);
    }
    setJsonText(JSON.stringify(updated, null, 2));
  };

  const isActionChecked = (action: string): boolean => {
    const statements = validateJson(jsonText);
    if (!statements) return false;
    for (const stmt of statements) {
      if (stmt.Effect !== "Allow") continue;
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      if (actions.includes(action)) return true;
    }
    return false;
  };

  if (!catalog) return <section className="iam-editor-loading"><p className="loading-dots">Loading IAM policies</p></section>;

  const groups = groupedActions();

  return (
    <section className="iam-policy-editor">
      <div className="iam-editor-header">
        <h3>Access Control Policies</h3>
        <div className="iam-tier-selector">
          {TIERS.map((tier) => (
            <button key={tier} className={selectedTier === tier ? "active" : ""} onClick={() => selectTier(tier)}>
              {tier.charAt(0).toUpperCase() + tier.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="iam-editor-tabs">
        <button className={editorTab === "visual" ? "active" : ""} onClick={() => setEditorTab("visual")}>Visual Builder</button>
        <button className={editorTab === "json" ? "active" : ""} onClick={() => setEditorTab("json")}>JSON Editor</button>
        <button className={editorTab === "test" ? "active" : ""} onClick={() => { runTest(); setEditorTab("test"); }}>Test Policy</button>
      </div>

      <div className="iam-editor-body">
        {editorTab === "json" && (
          <div className="iam-json-editor">
            <textarea
              className={`iam-json-textarea ${jsonError ? "has-error" : ""}`}
              value={jsonText}
              onChange={(e) => { setJsonText(e.target.value); setSaved(false); setJsonError(""); }}
              rows={20}
              spellCheck={false}
            />
            {jsonError && <p className="iam-json-error">{jsonError}</p>}
          </div>
        )}

        {editorTab === "visual" && (
          <div className="iam-visual-builder">
            {Object.entries(groups).map(([ns, actions]) => (
              <details key={ns} className="iam-namespace-group" open>
                <summary className="iam-namespace-header">
                  <strong>{ns}</strong>
                  <span className="iam-namespace-count">{actions.length} actions</span>
                </summary>
                <div className="iam-action-list">
                  {actions.map((action) => {
                    const shortName = action.includes(":") ? action.split(":").slice(1).join(":") : action;
                    const checked = isActionChecked(action);
                    return (
                      <label key={action} className={`iam-action-item ${checked ? "allowed" : "denied"}`}>
                        <input type="checkbox" checked={checked} onChange={() => toggleVisualAction(action)} />
                        <span className="iam-action-name" title={action}>{shortName}</span>
                        <span className={`iam-action-state ${checked ? "state-allowed" : "state-denied"}`}>
                          {checked ? "Allow" : "Deny"}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </details>
            ))}
          </div>
        )}

        {editorTab === "test" && testResults && (
          <div className="iam-test-results">
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
          </div>
        )}
      </div>

      <div className="iam-editor-footer">
        <button className="stable-action-button" onClick={savePolicy} disabled={saving || !!jsonError}>
          {saving ? "Saving..." : saved ? "Saved ✓" : `Save ${selectedTier} Policy`}
        </button>
      </div>
    </section>
  );
}
