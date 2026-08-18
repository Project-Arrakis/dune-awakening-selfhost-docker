import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { IamCatalog } from "./iamTypes";
import { capitalize, errorText, validateStatementsJson } from "./iamTypes";
import { IamPermissionGrid } from "./IamPermissionGrid";
import { IamPolicySimulator } from "./IamPolicySimulator";

// AWS-mirrored "Roles" view (design §4.7): per-tier picker showing the
// tier's own inline policy plus its attached named policies. Replaces
// the original single editor's static, hardcoded `const TIERS = [...]`
// array (which was missing "observer" -- a real, pre-existing drift bug
// found during this design's own research) with a dynamic list derived
// from the live catalog, so it can never drift from the backend again
// and so a brand-new custom tier appears here automatically once
// created.

type Props = {
  catalog: IamCatalog;
  onCatalogChange: () => Promise<void>;
  canMutate: boolean;
};

type EditorTab = "builder" | "json" | "attached" | "test";

export function IamRolesView({ catalog, onCatalogChange, canMutate }: Props) {
  const tierNames = useMemo(() => Object.keys(catalog.tiers).sort(), [catalog.tiers]);
  const [selectedTier, setSelectedTier] = useState<string>(tierNames.includes("admin") ? "admin" : tierNames[0] || "");
  const [editorTab, setEditorTab] = useState<EditorTab>("builder");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [actionError, setActionError] = useState("");
  const [newTierName, setNewTierName] = useState("");
  const [creatingTier, setCreatingTier] = useState(false);
  const [attachPickerQuery, setAttachPickerQuery] = useState("");
  // Local-only: an owner clicked "Add an inline policy" for a tier whose
  // `inline` is currently null in the catalog. The grid should appear
  // immediately (editing an empty statement list), not only after the
  // first Save round-trip re-fetches the catalog with a non-null inline
  // value -- reset whenever the selected tier changes so this doesn't
  // leak across tiers.
  const [inlineDraftStarted, setInlineDraftStarted] = useState(false);

  useEffect(() => {
    if (!tierNames.includes(selectedTier) && tierNames.length) setSelectedTier(tierNames[0]);
  }, [tierNames, selectedTier]);

  useEffect(() => {
    const tierRecord = catalog.tiers[selectedTier];
    setJsonText(JSON.stringify(tierRecord?.inline?.statements || [], null, 2));
    setJsonError("");
    setSaved(false);
    setActionError("");
    setInlineDraftStarted(false);
  }, [selectedTier, catalog.tiers]);

  const tierRecord = catalog.tiers[selectedTier];
  const attachedPolicies = tierRecord?.attached || [];
  const availableToAttach = Object.keys(catalog.policies)
    .filter((id) => !attachedPolicies.includes(id))
    .filter((id) => catalog.policies[id].name.toLowerCase().includes(attachPickerQuery.toLowerCase()))
    .sort((a, b) => catalog.policies[a].name.localeCompare(catalog.policies[b].name));

  async function handleCreateTier() {
    const name = newTierName.trim();
    if (!name) return;
    setCreatingTier(true);
    setActionError("");
    try {
      const result = await api<{ ok: boolean; error?: string }>("/api/settings/iam/tiers", {
        method: "POST",
        body: JSON.stringify({ tier: name })
      });
      if (!result.ok) throw new Error(result.error);
      setNewTierName("");
      await onCatalogChange();
      setSelectedTier(name);
    } catch (error) {
      setActionError(errorText(error, "Failed to create role."));
    } finally {
      setCreatingTier(false);
    }
  }

  async function handleSaveInline() {
    const { statements, error } = validateStatementsJson(jsonText);
    if (!statements) { setJsonError(error); return; }
    if (selectedTier === "owner" && statements.length === 0) {
      setJsonError("Cannot save an empty inline policy for the owner tier if no attached policy grants settings:write -- this would lock the owner out.");
      return;
    }
    setSaving(true);
    setActionError("");
    try {
      const result = await api<{ ok: boolean; error?: string }>(`/api/settings/iam/tiers/${encodeURIComponent(selectedTier)}/inline`, {
        method: "PUT",
        body: JSON.stringify({ statements })
      });
      if (!result.ok) throw new Error(result.error);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      await onCatalogChange();
    } catch (error) {
      // Surfaces the real owner-lockout rejection message verbatim (e.g.
      // "This change would remove the owner tier's settings:write
      // access, including through its attached policies. Rejected to
      // prevent lockout.") rather than a generic failure string.
      setActionError(errorText(error, "Failed to save this role's inline policy."));
    } finally {
      setSaving(false);
    }
  }

  async function handleAttach(policyId: string) {
    setActionError("");
    try {
      const result = await api<{ ok: boolean; error?: string }>(`/api/settings/iam/tiers/${encodeURIComponent(selectedTier)}/attach`, {
        method: "PUT",
        body: JSON.stringify({ policyId })
      });
      if (!result.ok) throw new Error(result.error);
      await onCatalogChange();
    } catch (error) {
      setActionError(errorText(error, "Failed to attach that policy."));
    }
  }

  async function handleDetach(policyId: string) {
    setActionError("");
    try {
      const result = await api<{ ok: boolean; error?: string }>(`/api/settings/iam/tiers/${encodeURIComponent(selectedTier)}/detach`, {
        method: "PUT",
        body: JSON.stringify({ policyId })
      });
      if (!result.ok) throw new Error(result.error);
      await onCatalogChange();
    } catch (error) {
      // Surfaces the real owner-lockout rejection verbatim if detaching
      // this policy would strip owner's settings:write.
      setActionError(errorText(error, "Failed to detach that policy."));
    }
  }

  return (
    <div className="iam-roles-view">
      <div className="iam-tier-selector">
        {tierNames.map((tier) => (
          <button key={tier} className={`iam-tier-btn ${selectedTier === tier ? "active" : ""}`} onClick={() => setSelectedTier(tier)}>
            {capitalize(tier)}
          </button>
        ))}
      </div>

      {canMutate && (
        <div className="iam-new-role-row">
          <input
            type="text"
            placeholder="new-role-name"
            value={newTierName}
            onChange={(e) => setNewTierName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreateTier(); }}
          />
          <button className="stable-action-button" disabled={creatingTier || !newTierName.trim()} onClick={handleCreateTier}>
            {creatingTier ? "Creating..." : "New Role"}
          </button>
        </div>
      )}

      {!selectedTier && <p className="iam-empty-hint">No roles exist yet.</p>}

      {selectedTier && (
        <>
          <div className="iam-editor-tabs">
            <button className={editorTab === "builder" ? "active" : ""} onClick={() => setEditorTab("builder")}>Inline Permissions</button>
            <button className={editorTab === "json" ? "active" : ""} onClick={() => setEditorTab("json")}>JSON</button>
            <button className={editorTab === "attached" ? "active" : ""} onClick={() => setEditorTab("attached")}>
              Attached Policies ({attachedPolicies.length})
            </button>
            <button className={editorTab === "test" ? "active" : ""} onClick={() => setEditorTab("test")}>Test</button>
          </div>

          {editorTab === "builder" && (
            tierRecord?.inline === null && !inlineDraftStarted ? (
              <div className="iam-empty-hint">
                <p>This role has no inline policy of its own -- its permissions come entirely from attached policies (see the "Attached Policies" tab).</p>
                <button onClick={() => { setJsonText("[]"); setInlineDraftStarted(true); }}>Add an inline policy</button>
              </div>
            ) : (
              <IamPermissionGrid
                actionMap={catalog.actionMap}
                statements={validateStatementsJson(jsonText).statements || []}
                onChange={(next) => { setJsonText(JSON.stringify(next, null, 2)); setSaved(false); }}
              />
            )
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

          {editorTab === "attached" && (
            <div className="iam-attached-policies">
              <div className="iam-attached-list">
                {attachedPolicies.length === 0 && <p className="iam-empty-hint">No policies attached to this role.</p>}
                {attachedPolicies.map((policyId) => {
                  const summary = catalog.policies[policyId];
                  return (
                    <div key={policyId} className="iam-attached-row">
                      <span>{summary?.name || policyId}</span>
                      <button className="danger" onClick={() => handleDetach(policyId)}>Detach</button>
                    </div>
                  );
                })}
              </div>
              <div className="iam-attach-picker">
                <input
                  type="text"
                  placeholder="Search policies to attach..."
                  value={attachPickerQuery}
                  onChange={(e) => setAttachPickerQuery(e.target.value)}
                />
                <ul>
                  {availableToAttach.map((policyId) => (
                    <li key={policyId}>
                      <span>{catalog.policies[policyId].name}</span>
                      <button onClick={() => handleAttach(policyId)}>Attach</button>
                    </li>
                  ))}
                  {availableToAttach.length === 0 && <li className="iam-empty-hint">No matching unattached policies. Create one in the Policies tab.</li>}
                </ul>
              </div>
            </div>
          )}

          {/* key={selectedTier} forces a fresh component instance (and
              fresh results/error state) on every tier switch -- fixes a
              real Layer 3 audit finding (L3-H6, UI hat): without a key,
              switching tiers while remaining on the Test tab left the
              PREVIOUS tier's stale simulator results on screen, since
              React reuses the same component instance across prop
              changes at a stable tree position by default. */}
          {editorTab === "test" && <IamPolicySimulator key={selectedTier} mode="tier" tier={selectedTier} />}

          {actionError && <p className="iam-json-error" style={{ marginTop: "0.75rem" }}>{actionError}</p>}

          {(editorTab === "builder" || editorTab === "json") && (
            <div className="iam-editor-footer">
              <button className="stable-action-button" onClick={handleSaveInline} disabled={saving || !!jsonError}>
                {saving ? "Saving..." : saved ? "Saved" : `Save ${selectedTier} inline policy`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
