import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { IamCatalog, PolicyDetail, PolicyStatement } from "./iamTypes";
import { errorText, validateStatementsJson } from "./iamTypes";
import { IamPermissionGrid } from "./IamPermissionGrid";
import { IamPolicySimulator } from "./IamPolicySimulator";

// AWS-mirrored "Policies" view (design §4.7): a standalone list of
// named, reusable, versioned policy documents, independent of any one
// tier -- the direct structural counterpart to real AWS IAM's own
// Policies list. Kept as its own view rather than folded into the Roles
// view, per the Layer 1 audit's UI and Architect hats both independently
// recommending the split (design §8 item 7, resolved): a policy already
// has its own identity/version-history lifecycle once attached
// reusability exists, and building that lifecycle UI is unavoidable
// regardless of entry point, so a standalone list is the more honest
// structure, not a heavier one.
//
// Confirm this rewrite before shipping: MAX_NAMED_POLICIES/versions caps
// are enforced server-side (policy.js) -- this view surfaces the
// server's rejection detail rather than re-implementing the limits.

type Props = {
  catalog: IamCatalog;
  onCatalogChange: () => Promise<void>;
  actorTierIsOwner: boolean;
};

type EditorTab = "builder" | "json" | "versions" | "test";

export function IamPoliciesView({ catalog, onCatalogChange, actorTierIsOwner }: Props) {
  const policyIds = Object.keys(catalog.policies).sort((a, b) => catalog.policies[a].name.localeCompare(catalog.policies[b].name));
  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(policyIds[0] || null);
  const [detail, setDetail] = useState<PolicyDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editorTab, setEditorTab] = useState<EditorTab>("builder");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [actionError, setActionError] = useState("");
  const [creatingName, setCreatingName] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmingDeletePolicy, setConfirmingDeletePolicy] = useState(false);
  const [confirmingDeleteVersion, setConfirmingDeleteVersion] = useState<string | null>(null);

  // Fetch counter, not just a boolean `cancelled` flag, so a manual Retry
  // click (which re-runs this same fetch logic outside the effect) can't
  // race with an in-flight effect-triggered fetch from a since-abandoned
  // selection and win by arriving later -- see loadDetail() below.
  const [fetchToken, setFetchToken] = useState(0);

  useEffect(() => {
    // CRITICAL fix (Layer 2 audit finding C1, UI hat): every piece of
    // per-policy UI state -- not just `detail` -- MUST reset synchronously
    // the moment `selectedPolicyId` changes, before the new fetch even
    // starts. The previous version left `detail` (stale content) and both
    // delete-confirmation flags untouched across a selection change,
    // which the audit proved lets an armed "Confirm Delete" for policy A
    // silently end up deleting policy B if the owner switches selection
    // without explicitly clicking Cancel first. Clearing `detail`
    // immediately also fixes a separate finding (H2): the detail pane no
    // longer renders the PREVIOUS policy's name/versions while the new
    // one is still loading.
    setDetail(null);
    setConfirmingDeletePolicy(false);
    setConfirmingDeleteVersion(null);
    setJsonError("");
    setActionError("");
    setSaved(false);
    if (!selectedPolicyId) return;
    let cancelled = false;
    setLoadError("");
    api<PolicyDetail>(`/api/settings/iam/policies/${encodeURIComponent(selectedPolicyId)}`).then((data) => {
      if (cancelled) return;
      setDetail(data);
      const defaultVersion = data.versions[data.defaultVersionId];
      setJsonText(JSON.stringify(defaultVersion?.statements || [], null, 2));
    }).catch((error) => { if (!cancelled) setLoadError(errorText(error, "Failed to load this policy.")); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPolicyId, fetchToken]);

  async function refreshDetail() {
    if (!selectedPolicyId) return;
    try {
      const data = await api<PolicyDetail>(`/api/settings/iam/policies/${encodeURIComponent(selectedPolicyId)}`);
      setDetail(data);
      const defaultVersion = data.versions[data.defaultVersionId];
      setJsonText(JSON.stringify(defaultVersion?.statements || [], null, 2));
    } catch (error) {
      setActionError(errorText(error, "Failed to refresh this policy."));
    }
  }

  async function handleCreate() {
    const name = creatingName.trim();
    if (!name) return;
    setCreating(true);
    setActionError("");
    try {
      const result = await api<{ ok: boolean; policyId?: string; error?: string }>("/api/settings/iam/policies", {
        method: "POST",
        body: JSON.stringify({ name, statements: [] as PolicyStatement[] })
      });
      if (!result.ok || !result.policyId) throw new Error(result.error || "Failed to create policy.");
      setCreatingName("");
      await onCatalogChange();
      setSelectedPolicyId(result.policyId);
    } catch (error) {
      setActionError(errorText(error, "Failed to create policy."));
    } finally {
      setCreating(false);
    }
  }

  async function handleSave() {
    if (!selectedPolicyId) return;
    const { statements, error } = validateStatementsJson(jsonText);
    if (!statements) { setJsonError(error); return; }
    setSaving(true);
    setActionError("");
    try {
      const result = await api<{ ok: boolean; error?: string }>(`/api/settings/iam/policies/${encodeURIComponent(selectedPolicyId)}`, {
        method: "PUT",
        body: JSON.stringify({ statements })
      });
      if (!result.ok) throw new Error(result.error);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      await Promise.all([refreshDetail(), onCatalogChange()]);
    } catch (error) {
      setActionError(errorText(error, "Failed to save this policy version."));
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault(versionId: string) {
    if (!selectedPolicyId) return;
    setActionError("");
    try {
      const result = await api<{ ok: boolean; error?: string }>(`/api/settings/iam/policies/${encodeURIComponent(selectedPolicyId)}/rollback`, {
        method: "POST",
        body: JSON.stringify({ versionId })
      });
      if (!result.ok) throw new Error(result.error);
      await Promise.all([refreshDetail(), onCatalogChange()]);
    } catch (error) {
      setActionError(errorText(error, "Failed to set that version as default."));
    }
  }

  async function handleDeleteVersion(versionId: string) {
    if (!selectedPolicyId) return;
    setActionError("");
    try {
      const result = await api<{ ok: boolean; error?: string }>(`/api/settings/iam/policies/${encodeURIComponent(selectedPolicyId)}/versions/${encodeURIComponent(versionId)}`, { method: "DELETE" });
      if (!result.ok) throw new Error(result.error);
      setConfirmingDeleteVersion(null);
      await Promise.all([refreshDetail(), onCatalogChange()]);
    } catch (error) {
      // Surfaces the server's real detail verbatim -- e.g. "Cannot delete
      // the default version. Roll back to a different version first,
      // then delete this one." -- per the L1 audit's UI hat finding that
      // this class of specific, actionable rejection detail must reach
      // the owner, not be replaced with a generic failure string.
      setActionError(errorText(error, "Failed to delete that version."));
      setConfirmingDeleteVersion(null);
    }
  }

  async function handleDeletePolicy() {
    if (!selectedPolicyId) return;
    setActionError("");
    try {
      const result = await api<{ ok: boolean; error?: string }>(`/api/settings/iam/policies/${encodeURIComponent(selectedPolicyId)}`, { method: "DELETE" });
      if (!result.ok) throw new Error(result.error);
      setConfirmingDeletePolicy(false);
      setSelectedPolicyId(null);
      setDetail(null);
      await onCatalogChange();
    } catch (error) {
      // e.g. "Cannot delete this policy -- it is attached to: tier-a,
      // tier-b. Detach it from every tier first." -- the exact attaching-
      // tier list the backend deliberately computes, not a generic
      // "delete failed."
      setActionError(errorText(error, "Failed to delete this policy."));
      setConfirmingDeletePolicy(false);
    }
  }

  const isAttached = (detail?.attachedTo.length ?? 0) > 0;

  return (
    <div className="iam-policies-view">
      <div className="iam-policies-list-pane">
        <div className="iam-policies-list-header">
          <span>Named Policies</span>
          <span className="iam-ns-count">{policyIds.length}/50</span>
        </div>
        {actorTierIsOwner && (
          <div className="iam-policy-create-row">
            <input
              type="text"
              placeholder="New policy name..."
              value={creatingName}
              onChange={(e) => setCreatingName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
            />
            <button className="stable-action-button" disabled={creating || !creatingName.trim()} onClick={handleCreate}>
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        )}
        {policyIds.length === 0 && (
          <p className="iam-empty-hint">No named policies yet. Create one above, or attach one from the Roles view once it exists.</p>
        )}
        <ul className="iam-policies-list">
          {policyIds.map((id) => {
            const summary = catalog.policies[id];
            return (
              <li key={id} className={selectedPolicyId === id ? "active" : ""}>
                <button onClick={() => setSelectedPolicyId(id)}>
                  <span className="iam-policy-list-name">{summary.name}</span>
                  {summary.managed && <span className="iam-managed-badge">managed</span>}
                  <span className="iam-policy-list-meta">
                    {summary.attachedTo.length ? `attached to: ${summary.attachedTo.join(", ")}` : "not attached"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="iam-policy-detail-pane">
        {!selectedPolicyId && <p className="iam-empty-hint">Select a policy on the left, or create one, to view and edit its statements and version history.</p>}
        {selectedPolicyId && loadError && (
          <div className="iam-editor-error">
            <p className="iam-json-error">{loadError}</p>
            <button onClick={() => setFetchToken((t) => t + 1)}>Retry</button>
          </div>
        )}
        {selectedPolicyId && !loadError && !detail && <p className="iam-editor-loading">Loading policy...</p>}
        {selectedPolicyId && detail && (
          <>
            <div className="iam-policy-detail-header">
              <h4>{detail.name}</h4>
              {actorTierIsOwner && (
                confirmingDeletePolicy ? (
                  <span className="iam-confirm-inline">
                    {isAttached
                      ? <span className="iam-json-error">Attached to: {detail.attachedTo.join(", ")} -- detach first.</span>
                      : <span>Delete this policy? This cannot be undone.</span>}
                    <button className="danger" disabled={isAttached} onClick={handleDeletePolicy}>Confirm Delete</button>
                    <button onClick={() => setConfirmingDeletePolicy(false)}>Cancel</button>
                  </span>
                ) : (
                  <button className="danger" onClick={() => setConfirmingDeletePolicy(true)}>Delete Policy</button>
                )
              )}
            </div>

            <div className="iam-editor-tabs">
              <button className={editorTab === "builder" ? "active" : ""} onClick={() => setEditorTab("builder")}>Permissions</button>
              <button className={editorTab === "json" ? "active" : ""} onClick={() => setEditorTab("json")}>JSON</button>
              <button className={editorTab === "versions" ? "active" : ""} onClick={() => setEditorTab("versions")}>
                Versions ({Object.keys(detail.versions).length}/5)
              </button>
              <button className={editorTab === "test" ? "active" : ""} onClick={() => setEditorTab("test")}>Test</button>
            </div>

            {editorTab === "builder" && (
              <IamPermissionGrid
                actionMap={catalog.actionMap}
                statements={validateStatementsJson(jsonText).statements || []}
                onChange={(next) => { setJsonText(JSON.stringify(next, null, 2)); setSaved(false); }}
              />
            )}

            {editorTab === "json" && (
              <div className="iam-json-editor">
                <textarea
                  className={`iam-json-textarea ${jsonError ? "has-error" : ""}`}
                  value={jsonText}
                  onChange={(e) => { setJsonText(e.target.value); setSaved(false); setJsonError(""); }}
                  rows={14}
                  spellCheck={false}
                />
                {jsonError && <p className="iam-json-error">{jsonError}</p>}
              </div>
            )}

            {editorTab === "versions" && (
              <div className="iam-version-list">
                {Object.entries(detail.versions)
                  .sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt))
                  .map(([versionId, version]) => {
                    const isDefault = versionId === detail.defaultVersionId;
                    return (
                      <div key={versionId} className={`iam-version-row ${isDefault ? "is-default" : ""}`}>
                        <div className="iam-version-info">
                          <span className="iam-version-id">{versionId}</span>
                          {isDefault && <span className="iam-default-badge">default</span>}
                          <span className="iam-version-meta">{new Date(version.createdAt).toLocaleString()} by {version.createdBy}</span>
                        </div>
                        <div className="iam-version-actions">
                          {!isDefault && <button onClick={() => handleSetDefault(versionId)}>Set as default</button>}
                          {!isDefault && actorTierIsOwner && (
                            confirmingDeleteVersion === versionId ? (
                              <span className="iam-confirm-inline">
                                <button className="danger" onClick={() => handleDeleteVersion(versionId)}>Confirm</button>
                                <button onClick={() => setConfirmingDeleteVersion(null)}>Cancel</button>
                              </span>
                            ) : (
                              <button className="danger" onClick={() => setConfirmingDeleteVersion(versionId)}>Delete</button>
                            )
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}

            {/* key={selectedPolicyId}: same fix as IamRolesView.tsx, same
                finding (L3-H6) -- switching policies while on the Test
                tab must not show the previous policy's stale results. */}
            {editorTab === "test" && <IamPolicySimulator key={selectedPolicyId} mode="draft" draftStatements={validateStatementsJson(jsonText).statements || []} />}

            {actionError && <p className="iam-json-error" style={{ marginTop: "0.75rem" }}>{actionError}</p>}
            {(editorTab === "builder" || editorTab === "json") && (
              <div className="iam-editor-footer">
                <button className="stable-action-button" onClick={handleSave} disabled={saving || !!jsonError}>
                  {saving ? "Saving..." : saved ? "Saved" : "Save New Version"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
