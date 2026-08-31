// Pure policy-resolution helpers shared by the IAM editor and its tests.
//
// Extracted from IamPolicyEditor.tsx so the tests exercise the REAL functions.
// The first version of those tests re-implemented these two by hand, which
// would have passed happily while the component drifted -- the same
// tests-a-copy-not-the-code failure this file's own history is full of.
//
// These must mirror console/api/src/policy.js: explicit Deny beats Allow,
// default deny, with `*` and `namespace:*` wildcards.

export type PolicyStatement = { Effect: "Allow" | "Deny"; Action: string[] };

// Mirror of console/api/src/policy.js matchAction, character-for-character, so
// the builder/Test grid never shows a checkbox state the server would refuse.
// The earlier version handled only `*`, exact, and a partial `:*`, so a
// hand-authored Deny using the `-*` prefix form (e.g. `players:reset-*`, which
// actions.js documents as supported) or an embedded `*` rendered as GRANTED
// while the server denied it -- inviting an operator to delete the Deny "to fix
// the checkbox" and complete an escalation the UI invented.
function matchPattern(pattern: string, action: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(":*")) {
    const ns = pattern.slice(0, -2);
    return action === ns || action.startsWith(ns + ":");
  }
  if (pattern.endsWith("-*")) {
    return action.startsWith(pattern.slice(0, -1));
  }
  if (pattern === action) return true;
  if (pattern.includes("*")) {
    // Same transform as the server's matchAction(): only `*` is special, every
    // other character is escaped so a stray metacharacter can never throw.
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$").test(action);
  }
  return false;
}

export function iamActionAllowed(iamAction: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchPattern(pattern, iamAction)) return true;
  }
  return false;
}

// Whether a single IAM action is granted (Allow minus Deny) under a given
// statement list. Shared by the grid's `allowedActions` memo and
// toggleAction's branch decision (review finding) -- toggleAction used to
// branch on the memo's value even when computing over a JUST-mutated,
// freshly-parsed statement list (e.g. two toggles of the same action fired
// before React re-renders between them), reading stale grant/deny state and
// taking the wrong branch.
export function actionGrantedByStatements(statements: PolicyStatement[], action: string): boolean {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const st of statements) for (const a of st.Action) (st.Effect === "Deny" ? deny : allow).push(a);
  if (iamActionAllowed(action, deny)) return false;
  return iamActionAllowed(action, allow);
}

// Which catalog routes a tier may actually reach under `statements`.
//
// This used to read Allow only, so a tier carrying `Deny settings:*` --
// exactly how the default admin policy keeps the credential actions owner-only
// -- rendered its checkboxes as GRANTED while the server denied every call.
// That is the state that leads an operator to remove the Deny "to make the
// checkbox work", completing a privilege escalation the UI invented.
export function resolvedAllowedActions(
  statements: PolicyStatement[],
  actionMap: Record<string, string>
): Set<string> {
  const allowPatterns: string[] = [];
  const denyPatterns: string[] = [];
  for (const stmt of statements) {
    for (const a of stmt.Action) (stmt.Effect === "Deny" ? denyPatterns : allowPatterns).push(a);
  }
  const allowed = new Set<string>();
  for (const route of Object.keys(actionMap)) {
    const iamAction = actionMap[route];
    if (iamActionAllowed(iamAction, denyPatterns)) continue; // explicit Deny wins
    if (iamActionAllowed(iamAction, allowPatterns)) allowed.add(route);
  }
  return allowed;
}

// Group by the IAM ACTION's namespace -- what policy.js evaluates -- not by the
// URL's first path segment. The two diverge deliberately for several
// routes: `settings:regenerate-recovery-codes` lives at /api/auth/2fa/..., and
// Landsraad, Care Package and Map entries diverge too. Deriving it from the
// path put an owner-only credential permission in the catch-all bucket, under a
// card header reading "Care-package".
// #634 (AWS-IAM-Visual-Editor-style Access Control UI). Pure functions behind
// the namespace/access-level accordion's group-header tri-state checkbox and
// its "select all"/"unselect all" behavior. `crownJewelActions` is the
// concrete, already-expanded action list the catalog endpoint sends (never a
// pattern the client would need to match itself -- see console/api/src/
// policy.js's crownJewelActions(), which mirrors the setPolicies() fix for
// the same CRITICAL bug this design's own logic would otherwise repeat).

export type TriState = "checked" | "indeterminate" | "unchecked";

// The crown-jewel actions a non-owner tier can never be granted -- excluded
// from the "grantable" set a group's tri-state and select-all are computed
// over, so a group can reach "checked"/fully-select without them (Eight Hats
// UI/UX finding: the denominator must exclude these, or a group containing
// one can never show "checked" no matter how completely it's granted).
function grantableActions(groupActions: string[], crownJewelActions: string[], isOwnerTier: boolean): string[] {
  if (isOwnerTier) return groupActions;
  return groupActions.filter((a) => !crownJewelActions.includes(a));
}

export function groupTriState(
  groupActions: string[],
  allowedActions: Set<string>,
  crownJewelActions: string[],
  isOwnerTier: boolean
): TriState {
  const grantable = grantableActions(groupActions, crownJewelActions, isOwnerTier);
  if (grantable.length === 0) return "unchecked";
  const grantedCount = grantable.filter((a) => allowedActions.has(a)).length;
  if (grantedCount === 0) return "unchecked";
  if (grantedCount === grantable.length) return "checked";
  return "indeterminate";
}

// The crown-jewel actions present in a group that select-all will silently
// exclude for a non-owner tier -- drives the collapsed-header note (Eight
// Hats UI/UX finding: this must render in the collapsed header itself, not
// only after expanding, or an operator who selects-all from a collapsed
// header and moves on would never see it).
export function excludedCrownJewelActions(groupActions: string[], crownJewelActions: string[], isOwnerTier: boolean): string[] {
  if (isOwnerTier) return [];
  return groupActions.filter((a) => crownJewelActions.includes(a));
}

// "Select all": every ungranted, grantable action in the group, to be added
// as individual literal Allow entries (not a wildcard -- keeps every row
// individually toggleable afterward, per the design's §4.1 decision).
export function selectAllGrantTargets(
  groupActions: string[],
  allowedActions: Set<string>,
  crownJewelActions: string[],
  isOwnerTier: boolean
): string[] {
  const grantable = grantableActions(groupActions, crownJewelActions, isOwnerTier);
  return grantable.filter((a) => !allowedActions.has(a));
}

// "Unselect all": only actions that are an exact-literal Allow grant today
// (`allowLiterals`) are revoked -- a wildcard-granted or Deny-locked action is
// left untouched, exactly matching what a single checkbox can already do.
//
// Takes the same crownJewelActions/isOwnerTier parameters selectAllGrantTargets
// does, for structural symmetry (code-review finding) -- currently a no-op in
// practice, not a behavior change: a non-owner tier can never have an exact
// crown-jewel literal to begin with (setPolicies()'s save-time guard refuses
// it), and owner already bypasses the exclusion exactly as the grant side
// does. The point is defense-in-depth: without this parameter, nothing in
// either function's signature signals that crown-jewel status was ever
// supposed to matter to a revoke, so a future change to the draft-mutation
// flow (e.g. a revoke-time side effect) would have no structural cue to
// preserve the owner-only invariant the grant side already encodes.
export function selectAllRevokeTargets(
  groupActions: string[],
  allowedActions: Set<string>,
  allowLiterals: Set<string>,
  crownJewelActions: string[] = [],
  isOwnerTier = true
): string[] {
  const revokable = isOwnerTier ? groupActions : groupActions.filter((a) => !crownJewelActions.includes(a));
  return revokable.filter((a) => allowedActions.has(a) && allowLiterals.has(a));
}

export function nsFromAction(routeKey: string, actionMap: Record<string, string> = {}): string {
  const iamAction = actionMap[routeKey];
  if (iamAction && iamAction.includes(":")) return iamAction.split(":")[0].toLowerCase();
  const afterApi = routeKey.split("/api/")[1];
  if (!afterApi) return "other";
  return afterApi.split("/")[0].toLowerCase();
}
