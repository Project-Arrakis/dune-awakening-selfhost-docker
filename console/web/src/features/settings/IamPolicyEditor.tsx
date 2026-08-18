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
  const [actorTierIsOwner, setActorTierIsOwner] = useState(true);

  const loadCatalog = useCallback(async () => {
    const [catalogData, meData] = await Promise.all([
      api<IamCatalog>("/api/settings/iam/policies"),
      api<{ user: { tier: string } }>("/api/auth/me").catch(() => ({ user: { tier: "owner" } }))
    ]);
    setCatalog(catalogData);
    // Every mutating IAM route is gated on the settings:write action, not
    // a hardcoded "owner" identity check (see policy.js's own
    // documentation of this) -- but the default policy grants
    // settings:write only to "owner", so this is a reasonable UI-only
    // affordance hint, not a security boundary the frontend enforces
    // (the backend re-checks on every write regardless of what this
    // renders).
    setActorTierIsOwner(meData.user.tier === "owner");
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
        <IamRolesView catalog={catalog} onCatalogChange={handleCatalogChange} actorTierIsOwner={actorTierIsOwner} />
      )}
      {view === "policies" && (
        <IamPoliciesView catalog={catalog} onCatalogChange={handleCatalogChange} actorTierIsOwner={actorTierIsOwner} />
      )}
    </section>
  );
}
