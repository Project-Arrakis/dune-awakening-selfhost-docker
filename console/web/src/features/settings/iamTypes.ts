// Shared types/helpers for the AWS-mirrored console IAM editor
// (IamPolicyEditor.tsx + IamRolesView.tsx + IamPoliciesView.tsx).
// See docs/design/console-custom-iam-roles-l1-design-2026-08-17.md for
// the full design and its Layer 1 eight-hats audit trail.

export interface PolicyStatement {
  Effect: "Allow" | "Deny";
  Action: string[];
}

export interface TierRecord {
  inline: { statements: PolicyStatement[] } | null;
  attached: string[];
}

// Shape returned by GET /api/settings/iam/policies (the catalog/list
// route) -- per the design's §8 item 2 resolution, `statements` here is
// the policy's DEFAULT VERSION ONLY, not full history. Full history is
// fetched lazily via GET /api/settings/iam/policies/{policyId}
// (PolicyDetail below), only when a specific policy is actually opened.
export interface PolicySummary {
  name: string;
  managed: boolean;
  defaultVersionId: string;
  statements: PolicyStatement[];
  versionCount: number;
  attachedTo: string[];
}

export interface PolicyVersion {
  statements: PolicyStatement[];
  createdAt: string;
  createdBy: string;
}

export interface PolicyDetail {
  policyId: string;
  name: string;
  managed: boolean;
  defaultVersionId: string;
  versions: Record<string, PolicyVersion>;
  attachedTo: string[];
}

export interface IamCatalog {
  tiers: Record<string, TierRecord>;
  policies: Record<string, PolicySummary>;
  actions: string[];
  actionMap: Record<string, string>;
  namespaces: Record<string, string>;
}

export interface MutationResult {
  ok: boolean;
  error?: string;
  policyId?: string;
  defaultVersionId?: string;
}

export function parseStatements(text: string): PolicyStatement[] | null {
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

export function validateStatementsJson(text: string): { statements: PolicyStatement[] | null; error: string } {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("Must be an array of statements");
    for (const stmt of parsed) {
      if (!stmt.Effect || !["Allow", "Deny"].includes(stmt.Effect)) throw new Error(`Invalid Effect: ${stmt.Effect}`);
      if (!stmt.Action || (!Array.isArray(stmt.Action) && typeof stmt.Action !== "string")) throw new Error("Action must be a string or array");
    }
    return { statements: parsed, error: "" };
  } catch (e: unknown) {
    return { statements: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function iamActionAllowed(iamAction: string, allowPatterns: string[]): boolean {
  for (const pattern of allowPatterns) {
    if (pattern === "*") return true;
    if (pattern === iamAction) return true;
    if (pattern.endsWith(":*") && iamAction.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

export function resolvedAllowedActions(statements: PolicyStatement[], actionMap: Record<string, string>): Set<string> {
  const allowPatterns: string[] = [];
  for (const stmt of statements) {
    if (stmt.Effect !== "Allow") continue;
    for (const a of stmt.Action) allowPatterns.push(a);
  }
  const allowed = new Set<string>();
  for (const catalogAction of Object.keys(actionMap)) {
    const iamAction = actionMap[catalogAction];
    if (iamActionAllowed(iamAction, allowPatterns)) {
      allowed.add(catalogAction);
    }
  }
  return allowed;
}

export function nsFromAction(action: string): string {
  const afterApi = action.split("/api/")[1];
  if (!afterApi) return "other";
  return afterApi.split("/")[0].toLowerCase();
}

export function humanLabel(action: string): string {
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

export function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function namespaceLabel(action: string): string {
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

export const NAMESPACE_ORDER = [
  "server", "players", "guilds", "bases", "storage", "maps",
  "sietches", "deepdesert", "admin", "landsraad", "addons",
  "carepackage", "blueprints", "database", "backups", "logs",
  "settings", "updates", "setup", "public-directory",
];

// CRITICAL fix (Layer 2 audit finding C1, Architect hat): `actionMap` is
// `{ "GET /api/server/status": "server:read", ... }` -- HTTP-route keys
// mapped to IAM-action-string values. `nsFromAction()`/`humanLabel()`
// both expect an HTTP-route-shaped string (they split on "/api/"). This
// function MUST group over `Object.keys(actionMap)` (the HTTP routes),
// never `Object.values(actionMap)` (the IAM action strings) -- an
// earlier version of this function iterated the values instead, which
// silently broke both namespace grouping (everything fell into "other",
// since `"server:read".split("/api/")[1]` is `undefined`) and the
// checkbox grid's `allowed.has(action)` lookup (which is keyed by the
// same HTTP-route strings `resolvedAllowedActions()` above already
// correctly uses via `Object.keys(actionMap)`). Verified with a real
// component-render regression test in IamPermissionGrid.test.tsx.
export function groupActionsByNamespace(actionMap: Record<string, string>): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const ns of NAMESPACE_ORDER) groups[ns] = [];
  const other: string[] = [];
  for (const catalogAction of new Set(Object.keys(actionMap))) {
    if (typeof catalogAction !== "string") continue;
    const ns = nsFromAction(catalogAction);
    if (groups[ns]) {
      groups[ns].push(catalogAction);
    } else {
      other.push(catalogAction);
    }
  }
  for (const ns of Object.keys(groups)) groups[ns].sort();
  if (other.length) groups.other = other.sort();
  for (const ns of Object.keys(groups)) {
    if (groups[ns].length === 0) delete groups[ns];
  }
  return groups;
}

// Extracts the real, server-provided error message from a caught
// exception, rather than discarding it behind a generic string. The
// api()/post() client (see ../../api/client.ts) already throws
// `new Error(friendlyApiError(record.error || ...))`, so `error.message`
// IS the real, specific detail the backend sent (e.g. "Cannot delete
// this policy -- it is attached to: tier-a, tier-b. Detach it from every
// tier first.") -- added per the L1 audit's UI hat finding (L1-H7) that
// the pre-existing pattern of catching an error and showing a hardcoded
// generic message discards exactly this kind of deliberately-designed,
// actionable backend detail.
export function errorText(error: unknown, fallback = "Request failed."): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
