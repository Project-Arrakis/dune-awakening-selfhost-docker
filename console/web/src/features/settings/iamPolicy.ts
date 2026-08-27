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

export function iamActionAllowed(iamAction: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === "*") return true;
    if (pattern === iamAction) return true;
    if (pattern.endsWith(":*") && iamAction.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

// Which catalog routes a tier may actually reach under `statements`.
//
// This used to read Allow only (#529), so a tier carrying `Deny settings:*` --
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
// URL's first path segment (#529). The two diverge deliberately for several
// routes: `settings:regenerate-recovery-codes` lives at /api/auth/2fa/..., and
// Landsraad, Care Package and Map entries diverge too. Deriving it from the
// path put an owner-only credential permission in the catch-all bucket, under a
// card header reading "Care-package".
export function nsFromAction(routeKey: string, actionMap: Record<string, string> = {}): string {
  const iamAction = actionMap[routeKey];
  if (iamAction && iamAction.includes(":")) return iamAction.split(":")[0].toLowerCase();
  const afterApi = routeKey.split("/api/")[1];
  if (!afterApi) return "other";
  return afterApi.split("/")[0].toLowerCase();
}
