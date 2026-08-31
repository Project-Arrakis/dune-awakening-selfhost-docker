import { describe, it, expect } from "vitest";
import { groupTriState, excludedCrownJewelActions, selectAllGrantTargets, selectAllRevokeTargets } from "./iamPolicy";

// #634 (AWS-IAM-Visual-Editor-style Access Control UI). These are the pure
// functions behind the namespace/access-level accordion's group-header
// tri-state checkbox and its "select all" behavior -- pinned by the Eight
// Hats Layer 1 design audit's two UI/UX HIGH findings:
//   (1) the denominator for "checked" must exclude crown-jewel actions for a
//       non-owner tier, or a group containing one can never show "checked"
//       no matter how completely the operator grants everything grantable.
//   (2) "select all" must exclude crown-jewel actions for a non-owner tier
//       using the concrete, already-expanded crownJewelActions list (never a
//       pattern-membership check) -- the exact bug shape the Security hat
//       found and fixed in setPolicies() (see #575).

describe("groupTriState", () => {
  it("is 'unchecked' when none of the group's grantable actions are allowed", () => {
    expect(groupTriState(["players:read", "players:kick"], new Set(), [], false)).toBe("unchecked");
  });

  it("is 'checked' when every grantable action is allowed", () => {
    expect(groupTriState(["players:read", "players:kick"], new Set(["players:read", "players:kick"]), [], false)).toBe("checked");
  });

  it("is 'indeterminate' when some but not all grantable actions are allowed", () => {
    expect(groupTriState(["players:read", "players:kick"], new Set(["players:read"]), [], false)).toBe("indeterminate");
  });

  it("excludes crown-jewel actions from the denominator for a non-owner tier -- a group can reach 'checked' without them", () => {
    // Fixes UI/UX finding H1: revision 1 computed the denominator over EVERY
    // action, so a group with a crown-jewel action could never show
    // "checked" for a non-owner tier no matter how completely it was granted.
    const group = ["players:read", "players:kick", "players:mutate"]; // players:mutate is crown-jewel
    const granted = new Set(["players:read", "players:kick"]); // everything grantable IS granted
    expect(groupTriState(group, granted, ["players:mutate"], false)).toBe("checked");
  });

  it("does NOT exclude crown-jewel actions from the denominator for the owner tier", () => {
    const group = ["players:read", "players:mutate"];
    const granted = new Set(["players:read"]); // players:mutate not yet granted, but owner CAN grant it
    expect(groupTriState(group, granted, ["players:mutate"], true)).toBe("indeterminate");
  });

  it("is 'unchecked', not a crash, when a group's every action is crown-jewel-excluded for a non-owner tier", () => {
    expect(groupTriState(["players:mutate"], new Set(), ["players:mutate"], false)).toBe("unchecked");
  });
});

describe("excludedCrownJewelActions", () => {
  it("returns the crown-jewel actions present in the group, for a non-owner tier", () => {
    const group = ["players:read", "players:mutate", "players:kick"];
    expect(excludedCrownJewelActions(group, ["players:mutate"], false)).toEqual(["players:mutate"]);
  });

  it("returns an empty list for the owner tier, regardless of crown-jewel membership", () => {
    const group = ["players:read", "players:mutate"];
    expect(excludedCrownJewelActions(group, ["players:mutate"], true)).toEqual([]);
  });

  it("returns an empty list when the group contains no crown-jewel action", () => {
    expect(excludedCrownJewelActions(["players:read", "players:kick"], ["players:mutate"], false)).toEqual([]);
  });
});

describe("selectAllGrantTargets", () => {
  it("grants every ungranted, non-crown-jewel action in the group for a non-owner tier", () => {
    const group = ["players:read", "players:kick", "players:mutate"];
    const already = new Set(["players:read"]);
    expect(selectAllGrantTargets(group, already, ["players:mutate"], false)).toEqual(["players:kick"]);
  });

  it("includes a crown-jewel action for the owner tier", () => {
    const group = ["players:read", "players:mutate"];
    expect(selectAllGrantTargets(group, new Set(), ["players:mutate"], true)).toEqual(["players:read", "players:mutate"]);
  });

  it("returns an empty list when everything grantable is already granted", () => {
    const group = ["players:read"];
    expect(selectAllGrantTargets(group, new Set(["players:read"]), [], false)).toEqual([]);
  });
});

describe("selectAllRevokeTargets", () => {
  it("revokes only actions that are exact-literal Allow grants -- a wildcard or locked grant is left untouched", () => {
    const group = ["players:read", "players:kick", "server:read"];
    const allowed = new Set(["players:read", "players:kick", "server:read"]);
    const allowLiterals = new Set(["players:read"]); // players:kick granted via a wildcard, server:read isn't even in this group's tier grant at all -- only players:read is a real literal
    expect(selectAllRevokeTargets(group, allowed, allowLiterals)).toEqual(["players:read"]);
  });

  it("returns an empty list when nothing in the group is currently an exact-literal grant", () => {
    expect(selectAllRevokeTargets(["players:read"], new Set(["players:read"]), new Set())).toEqual([]);
  });

  // code-review finding: structural symmetry with selectAllGrantTargets's own
  // crown-jewel exclusion -- currently a no-op in practice (a non-owner tier
  // can never have an exact crown-jewel literal to begin with, setPolicies()
  // refuses it at save time), but without this parameter nothing in either
  // function's signature signals crown-jewel status was ever supposed to
  // matter to a revoke.
  it("excludes a crown-jewel action from revoke targets for a non-owner tier, even if (hypothetically) exact-literal-granted", () => {
    const group = ["players:mutate", "players:read"];
    const allowed = new Set(["players:mutate", "players:read"]);
    const allowLiterals = new Set(["players:mutate", "players:read"]);
    expect(selectAllRevokeTargets(group, allowed, allowLiterals, ["players:mutate"], false)).toEqual(["players:read"]);
  });

  it("owner tier still revokes a crown-jewel action -- the exclusion only applies to non-owner tiers", () => {
    const group = ["players:mutate", "players:read"];
    const allowed = new Set(["players:mutate", "players:read"]);
    const allowLiterals = new Set(["players:mutate", "players:read"]);
    expect(selectAllRevokeTargets(group, allowed, allowLiterals, ["players:mutate"], true).sort()).toEqual(["players:mutate", "players:read"]);
  });
});
