import { useEffect, useState, useMemo, useRef } from "react";
import {
  actionGrantedByStatements, iamActionAllowed,
  groupTriState, excludedCrownJewelActions, selectAllGrantTargets, selectAllRevokeTargets,
  type TriState,
} from "./iamPolicy";
import { api } from "../../api/client";

interface PolicyStatement {
  Effect: "Allow" | "Deny";
  Action: string[];
}

interface PolicyCatalog {
  policies: Record<string, { version: number; tier: string; statements: PolicyStatement[] }>;
  actions: string[];
  actionMap: Record<string, string>;
  allActions?: string[];
  // #634: pre-computed server-side (never re-derived client-side -- see
  // console/api/src/policy.js's accessLevelForAction/crownJewelActions).
  // Both optional for backward compatibility with an older backend/fixture:
  // an action with no entry falls back to "read" (levelForAction below), and
  // a missing crownJewelActions list falls back to excluding nothing.
  accessLevels?: Record<string, string>;
  crownJewelActions?: string[];
  namespaces: Record<string, string>;
}

const ACCESS_LEVEL_ORDER = ["read", "write", "permissions"] as const;
type AccessLevel = (typeof ACCESS_LEVEL_ORDER)[number];
const ACCESS_LEVEL_LABEL: Record<AccessLevel, string> = { read: "Read", write: "Write", permissions: "Permissions Management" };

function levelForAction(catalog: PolicyCatalog | null | undefined, action: string): AccessLevel {
  const level = catalog?.accessLevels?.[action];
  return level === "write" || level === "permissions" ? level : "read";
}

// The complete distinct IAM-action list the grid renders. Prefer the catalog's
// allActions (which includes parameterized-route actions that have no literal
// actionMap key); fall back to actionMap values for an older backend.
function distinctActions(catalog?: PolicyCatalog | null): string[] {
  if (catalog?.allActions?.length) return catalog.allActions;
  return [...new Set(Object.values(catalog?.actionMap || {}))].filter((a): a is string => typeof a === "string");
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
    // Normalize Action to an array so downstream code (toggle/save/eval) never
    // has to special-case the string form the owner tier uses ("*").
    return parsed.map((stmt: any) => ({ ...stmt, Action: Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action] }));
  } catch { return null; }
}

// Human label for an IAM ACTION (e.g. "bases:read" -> "Read",
// "server:restart-service" -> "Restart Service", "admin:motd:write" ->
// "Motd Write"). The grid is action-centric: one row per grantable action,
// not per HTTP route (many routes share one action).
function actionLabel(action: string): string {
  const rest = action.includes(":") ? action.slice(action.indexOf(":") + 1) : action;
  return rest.split(/[:-]/).map(w => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

// Plain-language explanation for actions whose label alone ("Mutate",
// "Write Config") doesn't say what the action actually does. Kept in sync
// with the inline comments in policy.js's admin Deny block -- these are the
// same "crown jewel" actions an operator is most likely to click and wonder
// why they can't grant. Not exhaustive: only actions where the bare label is
// genuinely ambiguous get an entry.
const ACTION_DESCRIPTIONS: Record<string, string> = {
  "players:mutate": "Give items, add currency, or reset a player's progression (economy).",
  "settings:*": "IAM policies, the admin password, the console port, and 2FA recovery codes.",
  "server:write-credentials": "The Funcom game-server token and the server's public IP.",
  "database:write-config": "The database password.",
  "database:mutate": "Direct edits to database tables.",
  "database:export": "A full database dump (whole-database exfiltration risk).",
  "admin:transfer-settings:write": "Character/server-transfer policy (identity + economy impact).",
  "updates:apply": "Deploys new code to the running server.",
  "updates:fix": "Alters the running code to repair a failed update.",
  "updates:repair": "Alters the running code to repair a failed update.",
  "backups:restore": "Overwrites the live database from a backup (irreversible).",
  "backups:import": "Loads an untrusted backup file into the live database.",
  "addons:install": "Installs third-party code into the console process.",
  "addons:update": "Updates third-party code running in the console process.",
  "setup:write": "First-run provisioning of the console itself.",
  "carepackage:grant": "Mints an in-game care package (creates value from nothing).",
  "carepackage:write-config": "Changes care package economy configuration.",
  "exchange:market": "Seeds or alters the player-market economy.",
  "exchange:market-write": "Seeds or alters the player-market economy.",
  "admin:items:read": "Reference item-type catalog used by Character Admin's give-item tool -- not a live inventory.",
  "admin:vehicles:read": "Reference vehicle-type catalog used by Character Admin -- not the same as the separate \"Vehicles: Read\" permission, which covers the live in-game Vehicles panel.",
  "admin:skills:read": "Reference skill-module catalog used by Character Admin's skill editor.",
};

// A few actions' mechanical label (the bare last path segment, title-cased --
// "Mutate", "Items Read", "Vehicles Read") is meaningless or misleading on
// its own, and a hover tooltip alone doesn't fix that: an operator scanning
// the grid shouldn't have to hover every row to find the ones that matter.
// Override the VISIBLE label for exactly these -- the admin:*:read catalog
// lookups (which also collide in name with unrelated live-data namespaces,
// vehicles especially) and players:mutate (the economy-mutation bucket,
// which "Mutate" alone gives no hint of).
const ACTION_LABEL_OVERRIDES: Record<string, string> = {
  "admin:items:read": "Item Catalog",
  "admin:vehicles:read": "Vehicle Catalog",
  "admin:skills:read": "Skill Catalog",
  "players:mutate": "Give Items / Currency",
};

function actionDescription(action: string): string {
  return ACTION_DESCRIPTIONS[action] || "";
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

// Native <input type="checkbox"> has no "indeterminate" HTML attribute -- it
// must be set as a DOM property. Wrapping this in one place instead of a
// useEffect at every call site.
function TriStateCheckbox({ state, onChange, ariaLabel, disabled }: { state: TriState; onChange: () => void; ariaLabel: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "indeterminate";
  }, [state]);
  return <input ref={ref} type="checkbox" aria-label={ariaLabel} checked={state === "checked"} disabled={disabled} onChange={onChange} />;
}

export function IamPolicyEditor() {
  const [catalog, setCatalog] = useState<PolicyCatalog | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selectedTier, setSelectedTier] = useState<string>("admin");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editorTab, setEditorTab] = useState<"builder" | "json" | "test">("builder");
  const [testResults, setTestResults] = useState<Record<string, boolean> | null>(null);
  const [testError, setTestError] = useState("");
  const [toggleHint, setToggleHint] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<PolicyCatalog>("/api/settings/iam/policies").then((data) => {
      setCatalog(data);
      const doc = data.policies[selectedTier];
      if (doc) setJsonText(JSON.stringify(doc.statements, null, 2));
    }).catch(() => { setLoadError(true); });
  }, []);

  if (!catalog && loadError) return <section className="iam-editor-error"><h3>Failed to load IAM policies</h3><button onClick={() => { setLoadError(false); window.location.reload(); }}>Retry</button></section>;

  const selectTier = (tier: string) => {
    setSelectedTier(tier);
    setSaved(false);
    setTestResults(null);
    setSearch("");
    setToggleHint("");
    if (catalog) {
      const doc = catalog.policies[tier];
      setJsonText(doc ? JSON.stringify(doc.statements, null, 2) : "[]");
    }
  };

  // null while the JSON tab holds unparseable text. The grid must then be
  // read-only: treating an unparseable draft as "no statements" made every box
  // show unchecked, and one click replaced the operator's whole draft with a
  // single Allow -- which Save would then persist.
  const parsedDraft = useMemo(() => parseStatements(jsonText), [jsonText]);
  const draftInvalid = parsedDraft === null;
  const statements = useMemo(() => parsedDraft || [], [parsedDraft]);
  // Which IAM ACTIONS the draft grants (Allow minus Deny), computed over the
  // distinct actions in the catalog -- not routes, so one action = one checkbox.
  const allowedActions = useMemo(() => {
    const granted = new Set<string>();
    for (const action of distinctActions(catalog)) {
      if (typeof action !== "string") continue;
      if (actionGrantedByStatements(statements, action)) granted.add(action);
    }
    return granted;
  }, [statements, catalog]);

  // A checkbox can only cleanly toggle an EXACT Allow literal. When a permission
  // is granted by a wildcard (e.g. "server:*") or blocked by a Deny, the grid
  // can't express the change -- mark it locked (still clickable, so the hint
  // fires) and point the operator at the JSON tab.
  const { allowLiterals, denyPatterns } = useMemo(() => {
    const al = new Set<string>();
    const dp: string[] = [];
    for (const st of statements) {
      if (st.Effect === "Allow") for (const a of st.Action) al.add(a);
      else for (const a of st.Action) dp.push(a);
    }
    return { allowLiterals: al, denyPatterns: dp };
  }, [statements]);

  const lockReason = (iamAction: string): string => {
    const desc = actionDescription(iamAction);
    const prefix = desc ? `${desc} ` : "";
    if (iamActionAllowed(iamAction, denyPatterns)) return `${prefix}Blocked by a Deny rule — edit in the JSON tab.`;
    if (allowedActions.has(iamAction) && !allowLiterals.has(iamAction)) return `${prefix}Granted by a wildcard rule — edit in the JSON tab.`;
    return "";
  };

  const namespaceOrder = [
    "server", "players", "guilds", "bases", "storage", "maps",
    "sietches", "deepdesert", "admin", "landsraad", "addons",
    "carepackage", "blueprints", "vehicles", "exchange", "database",
    "backups", "logs", "settings", "updates", "setup", "public-directory",
  ];

  // Namespace -> access level -> actions. A namespace card only renders the
  // access-level sub-sections it actually has actions for (up to 3).
  const groupedActions = useMemo(() => {
    if (!catalog) return {} as Record<string, Record<AccessLevel, string[]>>;
    const groups: Record<string, Record<AccessLevel, string[]>> = {};
    const nsForAction = (action: string) => (action.includes(":") ? action.split(":")[0].toLowerCase() : "other");
    const allNamespaces = [...namespaceOrder];
    for (const action of distinctActions(catalog)) {
      if (typeof action !== "string") continue;
      const ns = nsForAction(action);
      if (!allNamespaces.includes(ns)) allNamespaces.push(ns);
    }
    for (const ns of allNamespaces) groups[ns] = { read: [], write: [], permissions: [] };
    for (const action of distinctActions(catalog)) {
      if (typeof action !== "string") continue;
      const ns = nsForAction(action);
      groups[ns][levelForAction(catalog, action)].push(action);
    }
    for (const ns of Object.keys(groups)) {
      for (const level of ACCESS_LEVEL_ORDER) groups[ns][level].sort();
      const isEmpty = ACCESS_LEVEL_ORDER.every((level) => groups[ns][level].length === 0);
      if (isEmpty) delete groups[ns];
    }
    return groups;
  }, [catalog]);

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return groupedActions;
    const q = search.toLowerCase();
    const result: Record<string, Record<AccessLevel, string[]>> = {};
    for (const [ns, levels] of Object.entries(groupedActions)) {
      const filteredLevels = {} as Record<AccessLevel, string[]>;
      let any = false;
      for (const level of ACCESS_LEVEL_ORDER) {
        const matching = (levels[level] || []).filter((a) => a.toLowerCase().includes(q) || actionLabel(a).toLowerCase().includes(q));
        filteredLevels[level] = matching;
        if (matching.length) any = true;
      }
      if (any) result[ns] = filteredLevels;
    }
    return result;
  }, [groupedActions, search]);

  // Every action in a namespace, across all three access levels -- what the
  // namespace-level header checkbox, count, tri-state, and select-all operate
  // over. Reads `filteredGroups`, not the unfiltered `groupedActions` --
  // code-review finding: select-all previously acted on the FULL namespace
  // even while a search narrowed what was actually visible, silently
  // granting/revoking actions the operator never saw or reviewed.
  // `filteredGroups` already equals `groupedActions` when no search is
  // active, so this is a no-op change for that case.
  const allActionsInNamespace = (ns: string): string[] =>
    ACCESS_LEVEL_ORDER.flatMap((level) => filteredGroups[ns]?.[level] || []);

  // Which namespace/access-level groups are expanded, keyed by "ns" for a
  // namespace header and "ns::level" for an access-level sub-header. Default
  // collapsed (empty set) -- an operator drills in only where needed, per
  // #634. A search match auto-expands its group WITHOUT writing into this
  // set (isExpanded below simply ORs in a search match at render time), so
  // clearing the search reverts exactly to whatever was manually toggled --
  // including a manual toggle made while a search was active, which a
  // snapshot-and-restore approach would have discarded.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  // `currentlyExpanded` is the caller's already-computed isExpanded() value
  // (which ORs in a search match), not re-derived from expandedKeys.has(key)
  // -- code-review finding: a group expanded ONLY via a search match is not
  // IN expandedKeys at all, so the old has(key)-based toggle always took the
  // "add" branch for it. That add was invisible immediately (isExpanded was
  // already true via the search match), but persisted after the search was
  // cleared, leaving the group expanded -- the opposite of what the click
  // intended. Deciding the direction from the real current state makes a
  // collapse-click on a search-matched group a no-op on expandedKeys instead
  // (it stays visible for as long as the search match holds, same as any
  // other search-matched group, and reverts correctly once the search clears).
  const toggleExpanded = (key: string, currentlyExpanded: boolean) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (currentlyExpanded) next.delete(key); else next.add(key);
      return next;
    });
  };
  const matchesSearch = (actions: string[]): boolean => {
    if (!search.trim()) return false;
    const q = search.toLowerCase();
    return actions.some((a) => a.toLowerCase().includes(q) || actionLabel(a).toLowerCase().includes(q));
  };
  const isExpanded = (key: string, groupActionsForSearch: string[]): boolean =>
    expandedKeys.has(key) || matchesSearch(groupActionsForSearch);

  const isOwnerTier = selectedTier === "owner";
  const crownJewels = catalog?.crownJewelActions || [];

  // Apply a group-level select-all/unselect-all to the draft, via the same
  // functional setJsonText update toggleAction uses (so a select-all and a
  // subsequent single-checkbox click in the same tick never race each
  // other over stale text). `select` is deliberately NOT a parameter --
  // code-review finding: it used to be computed by the caller from the
  // outer `allowedActions` memo/render-time tri-state (nsState/levelState),
  // which is only current as of the last completed render. Two clicks on
  // the same header landing before a re-render both captured the SAME
  // stale direction, so a grant-then-revoke pair silently became
  // grant-then-grant (the second call's freshly-recomputed currentAllowed
  // already showed everything granted, so its own no-op guard below fired
  // and the checkbox looked permanently stuck checked). Re-deriving the
  // tri-state fresh from `stmts` inside this same functional update -- the
  // exact fix toggleAction's own comment above already documents for the
  // single-checkbox case -- makes each call see the CURRENT state, not the
  // state at the moment the click fired.
  const applyGroupSelection = (groupActions: string[]) => {
    setJsonText((currentJsonText) => {
      const stmts = parseStatements(currentJsonText);
      if (!stmts) {
        setToggleHint("The JSON tab contains invalid JSON, so permissions cannot be changed here until it is fixed.");
        return currentJsonText;
      }
      setToggleHint("");
      const currentAllowed = new Set(groupActions.filter((a) => actionGrantedByStatements(stmts, a)));
      const select = groupTriState(groupActions, currentAllowed, crownJewels, isOwnerTier) !== "checked";
      const literals = new Set<string>();
      for (const st of stmts) if (st.Effect === "Allow") for (const a of st.Action) literals.add(a);

      const targets = select
        ? selectAllGrantTargets(groupActions, currentAllowed, crownJewels, isOwnerTier)
        : selectAllRevokeTargets(groupActions, currentAllowed, literals, crownJewels, isOwnerTier);
      if (targets.length === 0) {
        // code-review finding: this used to no-op with zero explanation --
        // toggleAction's single-checkbox equivalent already explains a
        // blocked state (a wildcard grant that can't be narrowed here) via
        // setToggleHint; select-all silently doing nothing left an operator
        // unsure why a click had no effect (e.g. unselecting a namespace
        // granted only via "players:*", with no exact literal to remove).
        setToggleHint(select
          ? "Nothing to grant here -- everything in this group is already allowed, or reserved for owner."
          : "Nothing to revoke here as exact permissions -- this group is granted by a wildcard rule, not individual literals. Edit the JSON tab to change wildcard grants.");
        return currentJsonText;
      }

      let updated: PolicyStatement[];
      if (select) {
        updated = [...stmts];
        let allowStmt = updated.filter((st) => st.Effect === "Allow").pop();
        if (!allowStmt) {
          allowStmt = { Effect: "Allow" as const, Action: [] };
          updated.push(allowStmt);
        }
        const toAdd = targets.filter((a) => !allowStmt!.Action.includes(a));
        if (toAdd.length) allowStmt.Action = [...allowStmt.Action, ...toAdd];
      } else {
        const toRemove = new Set(targets);
        updated = stmts.map((st) => (st.Effect === "Allow" ? { ...st, Action: st.Action.filter((a) => !toRemove.has(a)) } : st))
          .filter((st) => st.Action.length > 0);
      }
      setSaved(false);
      return JSON.stringify(updated, null, 2);
    });
  };

  // Reads the live jsonText via a functional setJsonText update rather than
  // the value captured in this closure (review finding): two toggles fired
  // before React re-renders between them (e.g. a future bulk/"select all"
  // action calling this in a loop) would otherwise both compute `updated`
  // from the same stale text, and the second setJsonText call would silently
  // overwrite the first toggle's change. The branch decision below must read
  // the same freshly-parsed `stmts`, not the outer `allowedActions` memo
  // (second review finding, still live after the first fix): that memo is
  // only current for the last completed render, so a second toggle in the
  // same tick would branch on stale state and could re-grant an action it
  // just revoked (or vice versa) instead of no-op'ing or reverting.
  const toggleAction = (iamAction: string) => {
    setJsonText((currentJsonText) => {
      const stmts = parseStatements(currentJsonText);
      if (!stmts) {
        setToggleHint("The JSON tab contains invalid JSON, so permissions cannot be changed here until it is fixed.");
        return currentJsonText;
      }
      setToggleHint("");
      let updated: PolicyStatement[];

      if (actionGrantedByStatements(stmts, iamAction)) {
        // Revoke. A checkbox can only remove an exact Allow literal; a grant that
        // comes from a wildcard ("server:*" or "*") cannot be narrowed here
        // without rewriting the wildcard. Filtering by !== would leave the
        // wildcard in place and the box would snap back -- tell the operator to
        // use the JSON tab instead of silently doing nothing.
        const hasExactLiteral = stmts.some(st => st.Effect === "Allow" && st.Action.includes(iamAction));
        if (!hasExactLiteral) {
          setToggleHint(`${iamAction} is granted by a wildcard rule, not a single permission. Edit the JSON tab to change wildcard grants.`);
          return currentJsonText;
        }
        updated = stmts.map(st => {
          if (st.Effect !== "Allow") return st;
          return { ...st, Action: st.Action.filter(a => a !== iamAction) };
        }).filter(st => st.Action.length > 0);
      } else {
        // Grant. A standing Deny (e.g. admin's "Deny settings:*") overrides any
        // Allow, so adding the literal would change nothing -- say so rather than
        // let the box appear to do nothing.
        const denyBlocked = stmts.some(st => st.Effect === "Deny" && iamActionAllowed(iamAction, st.Action));
        if (denyBlocked) {
          setToggleHint(`${iamAction} is blocked by a Deny rule. Remove that Deny in the JSON tab first.`);
          return currentJsonText;
        }
        updated = [...stmts];
        let allowStmt = updated.filter(st => st.Effect === "Allow").pop();
        if (!allowStmt) {
          allowStmt = { Effect: "Allow" as const, Action: [] };
          updated.push(allowStmt);
        }
        if (!allowStmt.Action.includes(iamAction)) {
          allowStmt.Action = [...allowStmt.Action, iamAction];
        }
      }
      setSaved(false);
      return JSON.stringify(updated, null, 2);
    });
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
      return parsed.map((stmt: any) => ({ ...stmt, Action: Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action] }));
    } catch (e: any) {
      setJsonError(e.message);
      return null;
    }
  };

  const savePolicy = async () => {
    const valid = validateJson(jsonText);
    if (!valid || !catalog) return;
    if (selectedTier === "owner" && Array.isArray(valid) && valid.length === 0) {
      setJsonError("Cannot save an empty policy for the owner tier. At least one owner-level permission is required to prevent permanent lock-out.");
      return;
    }
    setSaving(true);
    try {
      // The route is PUT and replaces the WHOLE tier-keyed store, not a single
      // {tier, statements} document -- send every tier with this one swapped in.
      const nextPolicies = { ...catalog.policies, [selectedTier]: { version: 1, tier: selectedTier, statements: valid } };
      const result = await api<{ ok: boolean; policies: PolicyCatalog["policies"] }>(
        "/api/settings/iam/policy",
        { method: "PUT", body: JSON.stringify(nextPolicies) }
      );
      setCatalog({ ...catalog, policies: result.policies || nextPolicies });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : "Failed to save policy");
    }
    setSaving(false);
  };

  const runTest = () => {
    const valid = validateJson(jsonText);
    if (!valid || !catalog) return;
    setTestError("");
    // Evaluate the DRAFT statements locally -- resolvedAllowedActions mirrors
    // console/api/src/policy.js. The server's /policy/test route evaluates the
    // SAVED, live policy, not this unsaved edit, so a local pass is what a
    // pre-save "what would this allow" preview actually needs (and avoids a
    // round-trip). One row per IAM action, deduped by the actionMap.
    const allow: string[] = [];
    const deny: string[] = [];
    for (const st of valid) for (const a of st.Action) (st.Effect === "Deny" ? deny : allow).push(a);
    const results: Record<string, boolean> = {};
    for (const action of distinctActions(catalog)) {
      if (typeof action !== "string") continue;
      results[action] = !iamActionAllowed(action, deny) && iamActionAllowed(action, allow);
    }
    setTestResults(results);
  };

  if (!catalog) return <section className="iam-editor-loading"><p className="loading-dots">Loading policies</p></section>;

  return (
    <section className="iam-policy-editor">
      <div className="iam-tier-selector" role="group" aria-label="Policy tier">
        {TIERS.map((tier) => (
          <button key={tier} className={`iam-tier-btn ${selectedTier === tier ? "active" : ""}`} aria-pressed={selectedTier === tier} onClick={() => selectTier(tier)}>
            {capitalize(tier)}
          </button>
        ))}
      </div>

      <div className="iam-editor-tabs" role="tablist" aria-label="Policy editor view">
        <button role="tab" id="iam-tab-builder" aria-selected={editorTab === "builder"} aria-controls="iam-panel-builder" className={editorTab === "builder" ? "active" : ""} onClick={() => setEditorTab("builder")}>Permissions</button>
        <button role="tab" id="iam-tab-json" aria-selected={editorTab === "json"} aria-controls="iam-panel-json" className={editorTab === "json" ? "active" : ""} onClick={() => setEditorTab("json")}>JSON</button>
        <button role="tab" id="iam-tab-test" aria-selected={editorTab === "test"} aria-controls="iam-panel-test" className={editorTab === "test" ? "active" : ""} onClick={() => { runTest(); setEditorTab("test"); }}>Test</button>
      </div>

      <div className="iam-editor-body">
        {editorTab === "builder" && (
          <div id="iam-panel-builder" role="tabpanel" aria-labelledby="iam-tab-builder">
            <div className="iam-search-bar">
              <input
                type="text"
                aria-label="Search permissions"
                placeholder="Search permissions..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button className="iam-search-clear" aria-label="Clear search" onClick={() => setSearch("")}>×</button>
              )}
            </div>
            {draftInvalid && <p className="iam-toggle-hint iam-draft-invalid" role="alert">The JSON tab contains invalid JSON. Fix it there before changing permissions here -- the grid is read-only until it parses.</p>}
            {toggleHint && <p className="iam-toggle-hint" role="status">{toggleHint}</p>}
            <div className="iam-permission-grid">
              {Object.keys(filteredGroups).length === 0 && (
                <p className="iam-empty-hint">No permissions match your search.</p>
              )}
              {Object.entries(filteredGroups).map(([ns, levels]) => {
                const nsActions = allActionsInNamespace(ns);
                const nsExpanded = isExpanded(ns, nsActions);
                const nsExcluded = excludedCrownJewelActions(nsActions, crownJewels, isOwnerTier);
                const nsState = groupTriState(nsActions, allowedActions, crownJewels, isOwnerTier);
                const nsAllowedCount = nsActions.filter((a) => allowedActions.has(a)).length;
                return (
                  <div key={ns} className="iam-ns-card">
                    <div className="iam-ns-header">
                      <button type="button" className="iam-ns-chevron" aria-label={nsExpanded ? `Collapse ${namespaceLabel(ns)}` : `Expand ${namespaceLabel(ns)}`} aria-expanded={nsExpanded} onClick={() => toggleExpanded(ns, nsExpanded)}>
                        {nsExpanded ? "▾" : "▸"}
                      </button>
                      <TriStateCheckbox
                        state={nsState}
                        ariaLabel={`Select all ${namespaceLabel(ns)} permissions`}
                        disabled={draftInvalid}
                        onChange={() => applyGroupSelection(nsActions)}
                      />
                      <span className="iam-ns-name">{namespaceLabel(ns)}</span>
                      <span className="iam-ns-count">
                        {nsAllowedCount}/{nsActions.length} allowed
                        {nsExcluded.length > 0 && ` — ${nsExcluded.length} owner-only`}
                      </span>
                    </div>
                    {nsExpanded && ACCESS_LEVEL_ORDER.filter((level) => (levels[level] || []).length > 0).map((level) => {
                      const levelActions = levels[level];
                      const levelKey = `${ns}::${level}`;
                      const levelExpanded = isExpanded(levelKey, levelActions);
                      const levelState = groupTriState(levelActions, allowedActions, crownJewels, isOwnerTier);
                      const levelAllowedCount = levelActions.filter((a) => allowedActions.has(a)).length;
                      const levelExcluded = excludedCrownJewelActions(levelActions, crownJewels, isOwnerTier);
                      return (
                        <div key={level} className="iam-level-group">
                          <div className="iam-level-header">
                            {/* code-review finding: was not scoped by namespace, unlike the
                                checkbox two lines below -- two expanded namespaces that both
                                have a "Read" bucket (the common case) rendered two chevrons
                                with the identical aria-label "Expand Read"/"Collapse Read",
                                indistinguishable to a screen reader and ambiguous to
                                getByLabelText("Expand Read") the moment more than one is open. */}
                            <button type="button" className="iam-ns-chevron" aria-label={levelExpanded ? `Collapse ${ACCESS_LEVEL_LABEL[level]} in ${namespaceLabel(ns)}` : `Expand ${ACCESS_LEVEL_LABEL[level]} in ${namespaceLabel(ns)}`} aria-expanded={levelExpanded} onClick={() => toggleExpanded(levelKey, levelExpanded)}>
                              {levelExpanded ? "▾" : "▸"}
                            </button>
                            <TriStateCheckbox
                              state={levelState}
                              ariaLabel={`Select all ${ACCESS_LEVEL_LABEL[level]} permissions in ${namespaceLabel(ns)}`}
                              disabled={draftInvalid}
                              onChange={() => applyGroupSelection(levelActions)}
                            />
                            <span className="iam-level-name">{ACCESS_LEVEL_LABEL[level]}</span>
                            <span className="iam-ns-count">
                              {levelAllowedCount}/{levelActions.length} allowed
                              {/* code-review finding: the namespace header shows this same
                                  note (line ~547) but the level sub-header didn't, even
                                  though crown-jewel actions live specifically inside the
                                  "Permissions Management" level -- an operator clicking
                                  select-all directly at this sub-header for a non-owner
                                  tier saw actions silently excluded with zero indication. */}
                              {levelExcluded.length > 0 && ` — ${levelExcluded.length} owner-only`}
                            </span>
                          </div>
                          {levelExpanded && (
                            <div className="iam-ns-actions">
                              {levelActions.map((action) => {
                                const lock = lockReason(action);
                                return (
                                  <label key={action} className={`iam-perm-row ${allowedActions.has(action) ? "perm-on" : "perm-off"}${lock ? " perm-locked" : ""}`} title={lock || undefined}>
                                    <input
                                      type="checkbox"
                                      checked={allowedActions.has(action)}
                                      disabled={draftInvalid}
                                      onChange={() => toggleAction(action)}
                                    />
                                    <span className="iam-perm-label" title={actionDescription(action) || undefined}>
                                      {ACTION_LABEL_OVERRIDES[action] || actionLabel(action)}
                                    </span>
                                    {lock && <span className="iam-perm-lock" aria-hidden="true">🔒</span>}
                                    <span className="iam-perm-action" title={action}>{action}</span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {editorTab === "json" && (
          <div className="iam-json-editor" id="iam-panel-json" role="tabpanel" aria-labelledby="iam-tab-json">
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
          <div className="iam-test-panel" id="iam-panel-test" role="tabpanel" aria-labelledby="iam-tab-test">
            {testError && <p className="error">{testError}</p>}
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
        <button className="stable-action-button" onClick={savePolicy} disabled={saving || (editorTab === "json" && !!jsonError)}>
          {saving ? "Saving..." : saved ? "Saved" : `Save ${selectedTier} policy`}
        </button>
      </div>
    </section>
  );
}
