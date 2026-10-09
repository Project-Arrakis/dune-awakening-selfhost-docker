import { useEffect, useState, useMemo, useRef } from "react";
import { resolvedAllowedActions, nsFromAction } from "./iamPolicy";
import { api, post } from "../../api/client";

interface PolicyStatement {
  Effect: "Allow" | "Deny";
  Action: string[];
}

interface PolicyCatalog {
  policies: Record<string, { version: number; tier: string; statements: PolicyStatement[] }>;
  actions: string[];
  actionMap: Record<string, string>;
  namespaces: Record<string, string>;
  /** Why a tier's effective policy differs from the saved file (issue #1160). */
  notices?: {
    addedDefaultDenies: { tier: string; action: string }[];
    keptExactAllows: { tier: string; action: string }[];
  };
  /** Identifies the store as last read; sent back as If-Match so a concurrent change is refused (#1193). */
  revision?: string;
}

const TIERS = ["owner", "admin", "moderator", "player"] as const;

interface SavePolicyResult {
  revision?: string;
  policies?: PolicyCatalog["policies"];
  notices?: PolicyCatalog["notices"];
  addedDefaultDenies?: { tier: string; action: string }[];
}

const listNotice = (items: { tier: string; action: string }[]) =>
  items.map((item) => `${item.tier.charAt(0).toUpperCase()}${item.tier.slice(1)}: ${item.action}`).join(", ");

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

function namespaceLabel(ns: string): string {
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
  const [loadError, setLoadError] = useState(false);
  const [selectedTier, setSelectedTier] = useState<string>("admin");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  // A refused save because another admin saved first. Not a validation error: it must not block the next Save.
  const [conflictNote, setConflictNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedNote, setSavedNote] = useState("");
  // The tier on screen right now, readable from an async handler that started earlier (#1190).
  const selectedTierRef = useRef<string>("admin");
  const [editorTab, setEditorTab] = useState<"builder" | "json" | "test">("builder");
  const [testResults, setTestResults] = useState<Record<string, boolean> | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<PolicyCatalog>("/api/settings/iam/policies").then((data) => {
      setCatalog(data);
      const doc = data.policies[selectedTier];
      if (doc) setJsonText(JSON.stringify(doc.statements, null, 2));
    }).catch(() => { setLoadError(true); });
  }, []);

  if (!catalog && loadError) return <section className="iam-editor-error"><h3>Failed to load IAM policies</h3><button onClick={() => { setLoadError(false); window.location.reload(); }}>Retry</button></section>;

  // Anything that changes the policy on screen also retires the note about the last save
  // (#1185): "Saved. The shipped Deny was also added for ..." described a different policy.
  const markEdited = () => { setSaved(false); setSavedNote(""); };

  const selectTier = (tier: string) => {
    selectedTierRef.current = tier;
    setSelectedTier(tier);
    markEdited();
    setConflictNote("");
    setTestResults(null);
    setSearch("");
    if (catalog) {
      const doc = catalog.policies[tier];
      setJsonText(doc ? JSON.stringify(doc.statements, null, 2) : "[]");
    }
  };

  const statements = useMemo(() => parseStatements(jsonText) || [], [jsonText]);
  const allowed = useMemo(() => resolvedAllowedActions(statements, catalog?.actionMap || {}), [statements, catalog?.actionMap]);

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
      const ns = nsFromAction(action, catalog.actionMap || {});
      if (groups[ns]) {
        groups[ns].push(action as string);
      } else {
        other.push(action as string);
      }
    }
    for (const ns of Object.keys(groups)) groups[ns].sort();
    if (other.length) groups["other"] = other.sort();
    for (const ns of Object.keys(groups)) {
      if (groups[ns].length === 0) delete groups[ns];
    }
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
    const map = catalog?.actionMap || {};
    const iamAction = map[action] || action;
    let updated: PolicyStatement[];

    if (allowed.has(action)) {
      updated = stmts.map(s => {
        if (s.Effect !== "Allow") return s;
        const filtered = s.Action.filter(a => a !== iamAction);
        return { ...s, Action: filtered };
      }).filter(s => s.Action.length > 0);
    } else {
      updated = [...stmts];
      let allowStmt = updated.filter(s => s.Effect === "Allow").pop();
      if (!allowStmt) {
        allowStmt = { Effect: "Allow" as const, Action: [] };
        updated.push(allowStmt);
      }
      if (!allowStmt.Action.includes(iamAction)) {
        allowStmt.Action = [...allowStmt.Action, iamAction];
      }
    }
    setJsonText(JSON.stringify(updated, null, 2));
    markEdited();
  };

  // After a conflict the text area still holds this admin's edit; this swaps in what the server enforces now.
  const showCurrentPolicy = () => {
    const current = catalog?.policies[selectedTier];
    if (current) setJsonText(JSON.stringify(current.statements, null, 2));
    setJsonError("");
    setConflictNote("");
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
    if (selectedTier === "owner" && Array.isArray(valid) && valid.length === 0) {
      setJsonError("Cannot save an empty policy for the owner tier. At least one own er-level permission is required to prevent permanent lock-out.");
      return;
    }
    setSaving(true);
    setSavedNote("");
    setConflictNote("");
    try {
      // The server takes the COMPLETE policy store (PUT /api/settings/iam/policy), not one tier.
      // (This used to POST { tier, statements } to a route that does not exist, so nothing
      // was ever saved: issue #1179.)
      // The server replaces the whole store, so it refuses a save (409) if the store changed after the
      // revision sent as If-Match (#1193). Re-read first so a change to ANOTHER tier does not stop this save:
      // take the latest store and its revision, but only if THIS tier is still what the page last showed.
      // If someone changed this tier, do not send a save at all: the fresh revision would make the server
      // accept it and overwrite their change.
      let base = catalog.policies;
      let revision = catalog.revision;
      try {
        const latest = await api<PolicyCatalog>("/api/settings/iam/policies");
        if (latest?.policies) {
          if (JSON.stringify(latest.policies[selectedTier]) !== JSON.stringify(catalog.policies[selectedTier])) {
            setCatalog({ ...catalog, policies: latest.policies, notices: latest.notices ?? catalog.notices, revision: latest.revision });
            setConflictNote(`Another admin changed the ${selectedTier} policy since this page showed it.`);
            setSaving(false);
            return;
          }
          base = latest.policies;
          revision = latest.revision;
        }
      } catch {
        // Fall back to what is on screen; the PUT below still reports its own failure.
      }
      const next = { ...base, [selectedTier]: { version: 1, tier: selectedTier, statements: valid } };
      const result = await api<SavePolicyResult>("/api/settings/iam/policy", {
        method: "PUT",
        headers: revision ? { "If-Match": revision } : undefined,
        body: JSON.stringify(next)
      });
      // Adopt what the server now enforces: it may have added a shipped Deny to what was sent.
      const policies = result?.policies ?? next;
      setCatalog({ ...catalog, policies, notices: result?.notices ?? catalog.notices, revision: result?.revision });
      // The admin may have switched tier while this save was in flight. The catalog is updated either
      // way, but the text area, the note and the Saved state belong to the tier that was saved: writing
      // them under another tier would show its statements there, and a second Save would then write them
      // to that other tier (review of PR #1189).
      if (selectedTierRef.current === selectedTier) {
        const enforced = policies[selectedTier];
        if (enforced) setJsonText(JSON.stringify(enforced.statements, null, 2));
        const added = result?.addedDefaultDenies ?? [];
        if (added.length > 0) setSavedNote(`Saved. The shipped Deny was also added for ${listNotice(added)}.`);
        setJsonError("");
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch (error) {
      // Another admin saved first. Adopt what is enforced now so the next Save is based on it, but keep
      // the text this admin typed: it is their unsaved work, and the message tells them to review it.
      const conflict = (error as { status?: number; body?: Partial<PolicyCatalog> })?.status === 409
        ? (error as { body?: Partial<PolicyCatalog> }).body
        : undefined;
      if (conflict?.policies) {
        if (selectedTierRef.current === selectedTier) {
          setConflictNote(error instanceof Error && error.message ? error.message : "The policies changed since you loaded them.");
        }
        setCatalog((current) => current && {
          ...current,
          policies: conflict.policies!,
          notices: conflict.notices ?? current.notices,
          revision: conflict.revision ?? current.revision
        });
      }
      if (!conflict?.policies && selectedTierRef.current === selectedTier) {
        setJsonError(error instanceof Error && error.message ? error.message : "Failed to save policy");
      }
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

  const addedDenies = catalog?.notices?.addedDefaultDenies ?? [];
  const keptAllows = catalog?.notices?.keptExactAllows ?? [];
  const listActions = listNotice;

  return (
    <section className="iam-policy-editor">
      {addedDenies.length > 0 && (
        <p className="iam-notice" role="status">
          This policy was saved before newer security defaults existed, so Deny rules were added when the Console started:{" "}
          <strong>{listActions(addedDenies)}</strong>. The tier now gets a 403 for these actions. Save the policy to keep the
          change, or name an action in an Allow to keep it granted.
        </p>
      )}
      {keptAllows.length > 0 && (
        <p className="iam-notice iam-notice-warning" role="status">
          Allowed by name, so the shipped Deny was not applied: <strong>{listActions(keptAllows)}</strong>. These actions let that
          tier read every credential on this host through a system backup. Remove the Allow to restore the Deny.
        </p>
      )}
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
                    <span className="iam-ns-name">{namespaceLabel(ns)}</span>
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
              onChange={(e) => { setJsonText(e.target.value); markEdited(); setJsonError(""); }}
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
        {jsonError && <p className="iam-json-error" style={{ marginBottom: "8px" }}>{jsonError}</p>}
        {conflictNote && (
          <p className="iam-notice iam-notice-warning" role="alert">
            {conflictNote} Your edits are kept. Show the current {selectedTier} policy to review it, or save again to replace it with your edits.{" "}
            <button type="button" className="stable-action-button" onClick={showCurrentPolicy}>Show current policy</button>
          </p>
        )}
        <button className="stable-action-button" onClick={savePolicy} disabled={saving || (editorTab === "json" && !!jsonError)}>
          {saving ? "Saving..." : saved ? "Saved" : `Save ${selectedTier} policy`}
        </button>
        {savedNote && <p className="iam-notice" role="status">{savedNote}</p>}
      </div>
    </section>
  );
}
