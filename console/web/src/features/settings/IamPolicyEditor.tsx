import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import type { IamCatalog } from "./iamTypes";
import { IamRolesView } from "./IamRolesView";
import { IamPoliciesView } from "./IamPoliciesView";

// AWS-mirrored console IAM editor (design:
// docs/design/console-custom-iam-roles-l1-design-2026-08-17.md).
//
// Replaces the original single-tier-selector-plus-tabs editor with two
// linked views, matching real AWS IAM's own console structure -- a
// "Roles" view (per-tier inline policy + attached named policies) and a
// standalone "Policies" view (named, reusable, versioned policy
// documents, independent of any one tier). The Layer 1 audit's UI and
// Architect hats both independently recommended keeping this split
// rather than folding policy management entirely into the Roles view
// (design §8 item 7, resolved) -- a policy already has its own identity/
// version-history lifecycle once cross-tier reuse exists, and building
// that lifecycle UI is unavoidable regardless of entry point.
//
// The original component's tier list (`const TIERS = [...]`, missing
// "observer" -- a real, pre-existing drift bug found during this
// design's own research) is gone entirely: both views now derive their
// tier/policy lists from the live catalog, so neither can drift from
// the backend again.

type TopView = "roles" | "policies";

export function IamPolicyEditor() {
  const [catalog, setCatalog] = useState<IamCatalog | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<TopView>("roles");
  // SECURITY/UI fix (Layer 3 re-audit, L3-H1b): previously hardcoded to
  // `tier === "owner"`, which did not match the backend's actual
  // capability model -- every mutating IAM route is gated on
  // settings:write (see console/api/src/actions.js's
  // ROUTE_CAPABILITIES/EXTRA_ROUTE_CAPABILITIES), not a specific tier
  // name. An operator who deliberately grants settings:write to a custom
  // tier (this design's own documented intended use case) got a session
  // the backend would accept every mutating call from, but the UI hid
  // every mutating control anyway, with no explanation. Fixed to derive
  // this from the same `allowedActions` array `/api/auth/me` already
  // returns (already used for nav-gating in App.tsx), rather than a
  // hardcoded identity check -- this remains a UI-only affordance hint,
  // not a security boundary the frontend enforces; the backend
  // re-checks settings:write (and the privilege-ceiling invariant) on
  // every write regardless of what this renders.
  const [canMutate, setCanMutate] = useState(true);

  const loadCatalog = useCallback(async () => {
    const [catalogData, meData] = await Promise.all([
      api<IamCatalog>("/api/settings/iam/policies"),
      api<{ allowedActions?: string[] }>("/api/auth/me").catch(() => ({ allowedActions: ["settings:write"] }))
    ]);
    setCatalog(catalogData);
    // resolveAllowedActions() (server-side) only ever emits concrete,
    // real action strings (it enumerates allKnownActions() and calls
    // evaluate() against each -- evaluate() itself expands settings:*/*
    // wildcards internally), never a bare "*" -- so a literal
    // "settings:write" membership check is sufficient and correct.
    const allowedActions = meData.allowedActions || [];
    setCanMutate(allowedActions.includes("settings:write"));
  }, []);

  useEffect(() => {
    loadCatalog().catch(() => setLoadError(true));
  }, [loadCatalog]);

  async function handleCatalogChange() {
    try {
      await loadCatalog();
    } catch {
      setLoadError(true);
    }
  }

  if (!catalog && loadError) {
    return (
      <section className="iam-editor-error">
        <h3>Failed to load IAM policies</h3>
        <button onClick={() => { setLoadError(false); window.location.reload(); }}>Retry</button>
      </section>
    );
  }

  if (!catalog) return <section className="iam-editor-loading"><p className="loading-dots">Loading policies</p></section>;

  return (
    <section className="iam-policy-editor">
      <div className="iam-top-view-tabs">
        <button className={view === "roles" ? "active" : ""} onClick={() => setView("roles")}>Roles</button>
        <button className={view === "policies" ? "active" : ""} onClick={() => setView("policies")}>
          Policies ({Object.keys(catalog.policies).length})
        </button>
      </div>

      {view === "roles" && (
        <IamRolesView catalog={catalog} onCatalogChange={handleCatalogChange} canMutate={canMutate} />
      )}
      {view === "policies" && (
        <IamPoliciesView catalog={catalog} onCatalogChange={handleCatalogChange} canMutate={canMutate} />
      )}
    </section>
  );
}
