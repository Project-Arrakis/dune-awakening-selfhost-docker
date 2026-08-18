import { useMemo, useState } from "react";
import type { PolicyStatement } from "./iamTypes";
import { groupActionsByNamespace, humanLabel, namespaceLabel, resolvedAllowedActions } from "./iamTypes";

// The checkbox-per-permission grid, extracted from the original single-
// editor IamPolicyEditor.tsx so it can be shared by both the Roles view
// (a tier's own inline policy) and the Policies view (a named policy's
// current version) -- confirmed by the Layer 1 audit's design doc (§4.7)
// to be tier-name/policy-identity agnostic already: it only ever
// operates on a plain statement array, never on which tier or policy
// that array belongs to.

type Props = {
  actionMap: Record<string, string>;
  statements: PolicyStatement[];
  onChange: (next: PolicyStatement[]) => void;
};

export function IamPermissionGrid({ actionMap, statements, onChange }: Props) {
  const [search, setSearch] = useState("");
  const allowed = useMemo(() => resolvedAllowedActions(statements, actionMap), [statements, actionMap]);
  const groupedActions = useMemo(() => groupActionsByNamespace(actionMap), [actionMap]);

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

  function toggleAction(action: string) {
    const iamAction = actionMap[action] || action;
    let updated: PolicyStatement[];

    if (allowed.has(action)) {
      updated = statements.map(s => {
        if (s.Effect !== "Allow") return s;
        const filtered = s.Action.filter(a => a !== iamAction);
        return { ...s, Action: filtered };
      }).filter(s => s.Action.length > 0);
    } else {
      updated = [...statements];
      let allowStmt = updated.filter(s => s.Effect === "Allow").pop();
      if (!allowStmt) {
        allowStmt = { Effect: "Allow" as const, Action: [] };
        updated.push(allowStmt);
      }
      if (!allowStmt.Action.includes(iamAction)) {
        allowStmt.Action = [...allowStmt.Action, iamAction];
      }
    }
    onChange(updated);
  }

  return (
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
  );
}
