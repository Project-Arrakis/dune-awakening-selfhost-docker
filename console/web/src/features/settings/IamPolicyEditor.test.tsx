import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IamPolicyEditor } from "./IamPolicyEditor";

const apiMock = vi.fn();

vi.mock("../../api/client", () => ({
  api: (...args: unknown[]) => apiMock(...args)
}));

const BASE_CATALOG = {
  tiers: {
    owner: { inline: { statements: [{ Effect: "Allow", Action: "*" }] }, attached: [] },
    admin: { inline: { statements: [{ Effect: "Allow", Action: "server:*" }] }, attached: [] },
    moderator: { inline: { statements: [{ Effect: "Allow", Action: "players:read" }] }, attached: [] },
    player: { inline: { statements: [{ Effect: "Allow", Action: "server:read" }] }, attached: [] },
    observer: { inline: { statements: [{ Effect: "Allow", Action: "server:read" }] }, attached: [] }
  },
  policies: {},
  actions: ["GET /api/server/status", "POST /api/server/restart"],
  actionMap: { "GET /api/server/status": "server:read", "POST /api/server/restart": "server:restart" },
  namespaces: { server: "server" }
};

function mockRoute(matcher: (path: string, options?: RequestInit) => unknown) {
  apiMock.mockImplementation(async (path: string, options?: RequestInit) => {
    const result = matcher(path, options);
    if (result === undefined) throw new Error(`Unhandled mock route: ${options?.method || "GET"} ${path}`);
    return result;
  });
}

beforeEach(() => {
  apiMock.mockReset();
});

describe("IamPolicyEditor (top-level container)", () => {
  it("loads the catalog and defaults to the Roles view, including the observer tier (regression guard for the pre-existing drift bug)", async () => {
    mockRoute((path) => {
      if (path === "/api/settings/iam/policies") return BASE_CATALOG;
      if (path === "/api/auth/me") return { user: { tier: "owner" }, allowedActions: ["settings:write"] };
      return undefined;
    });

    render(<IamPolicyEditor />);

    await waitFor(() => expect(screen.getByText("Policies (0)")).toBeTruthy());
    // Every one of the 5 built-in tiers must be selectable, including
    // "observer" -- the original hardcoded `TIERS` array (removed by
    // this rewrite) was missing it, a real, pre-existing bug.
    for (const tier of ["Owner", "Admin", "Moderator", "Player", "Observer"]) {
      expect(screen.getByRole("button", { name: tier })).toBeTruthy();
    }
  });

  it("shows a retry option when the catalog fails to load", async () => {
    apiMock.mockRejectedValue(new Error("network down"));
    render(<IamPolicyEditor />);
    await waitFor(() => expect(screen.getByText("Failed to load IAM policies")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("switches to the Policies view and shows the empty-state hint when no named policies exist", async () => {
    mockRoute((path) => {
      if (path === "/api/settings/iam/policies") return BASE_CATALOG;
      if (path === "/api/auth/me") return { user: { tier: "owner" }, allowedActions: ["settings:write"] };
      return undefined;
    });
    render(<IamPolicyEditor />);
    await waitFor(() => expect(screen.getByText("Policies (0)")).toBeTruthy());

    fireEvent.click(screen.getByText("Policies (0)"));
    expect(screen.getByText(/No named policies yet/)).toBeTruthy();
  });

  // ---- L3-H1b regression (Layer 3 re-audit, Architect hat -- component-
  // level gate mismatch) ----
  //
  // canMutate (formerly actorTierIsOwner) was previously hardcoded to
  // `tier === "owner"`, which did not match the backend's actual
  // settings:write-based capability model. A custom, non-owner tier
  // deliberately granted settings:write (this feature's own documented
  // intended use case) would have every mutating control hidden despite
  // the backend accepting every one of its mutation calls.
  it("REGRESSION (L3-H1b): a non-owner tier holding settings:write sees mutating controls (e.g. the 'New Role' input) -- this must be derived from allowedActions, not a hardcoded tier==owner check", async () => {
    mockRoute((path) => {
      if (path === "/api/settings/iam/policies") return BASE_CATALOG;
      // Deliberately NOT "owner" -- a custom tier with settings:write.
      if (path === "/api/auth/me") return { user: { tier: "iam-admin" }, allowedActions: ["settings:write"] };
      return undefined;
    });
    render(<IamPolicyEditor />);
    await waitFor(() => expect(screen.getByText("Policies (0)")).toBeTruthy());

    // The "New Role" control is gated by canMutate in IamRolesView and
    // must be visible for this settings:write-holding, non-owner tier.
    expect(screen.getByPlaceholderText("new-role-name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New Role/ })).toBeInTheDocument();
  });

  it("REGRESSION (L3-H1b, negative case): a tier WITHOUT settings:write does not see mutating controls, even if this component somehow rendered for it", async () => {
    mockRoute((path) => {
      if (path === "/api/settings/iam/policies") return BASE_CATALOG;
      if (path === "/api/auth/me") return { user: { tier: "read-only-viewer" }, allowedActions: ["settings:read"] };
      return undefined;
    });
    render(<IamPolicyEditor />);
    await waitFor(() => expect(screen.getByText("Policies (0)")).toBeTruthy());

    expect(screen.queryByPlaceholderText("new-role-name")).not.toBeInTheDocument();
  });
});

describe("IamRolesView: owner-lockout error surfacing (L1 audit finding L1-H7)", () => {
  it("surfaces the backend's real rejection message verbatim, not a generic failure string", async () => {
    mockRoute((path, options) => {
      if (path === "/api/settings/iam/policies") return BASE_CATALOG;
      if (path === "/api/auth/me") return { user: { tier: "owner" }, allowedActions: ["settings:write"] };
      if (path === "/api/settings/iam/tiers/owner/inline" && options?.method === "PUT") {
        return { ok: false, error: "This change would remove the owner tier's settings:write access, including through its attached policies. Rejected to prevent lockout." };
      }
      return undefined;
    });
    render(<IamPolicyEditor />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Owner" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Owner" }));
    fireEvent.click(screen.getByText("JSON"));
    const textarea = document.querySelector(".iam-json-textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    // Non-empty but deliberately narrowed (no settings:write) -- the
    // client-side empty-array guard is a separate, legitimate check;
    // this test exercises the SERVER's rejection path specifically, so
    // the statement list must be non-empty to reach that call at all.
    fireEvent.change(textarea, { target: { value: '[{"Effect":"Allow","Action":"server:read"}]' } });
    fireEvent.click(screen.getByText(/Save owner inline policy/));

    await waitFor(() => expect(screen.getByText(/Rejected to prevent lockout/)).toBeTruthy());
  });
});

describe("IamPoliciesView: delete-while-attached error surfacing (L1 audit finding L1-H7)", () => {
  it("shows the real attaching-tier list from the backend when a policy delete is rejected", async () => {
    const catalogWithPolicy = {
      ...BASE_CATALOG,
      policies: {
        "pol-1": { name: "shared-policy", managed: false, defaultVersionId: "v1", statements: [{ Effect: "Allow", Action: "server:read" }], versionCount: 1, attachedTo: ["moderator", "player"] }
      }
    };
    mockRoute((path, options) => {
      if (path === "/api/settings/iam/policies") return catalogWithPolicy;
      if (path === "/api/auth/me") return { user: { tier: "owner" }, allowedActions: ["settings:write"] };
      if (path === "/api/settings/iam/policies/pol-1") {
        if (options?.method === "DELETE") {
          return { ok: false, error: "Cannot delete this policy -- it is attached to: moderator, player. Detach it from every tier first." };
        }
        return {
          policyId: "pol-1", name: "shared-policy", managed: false, defaultVersionId: "v1",
          versions: { v1: { statements: [{ Effect: "Allow", Action: "server:read" }], createdAt: "2026-01-01T00:00:00.000Z", createdBy: "owner" } },
          attachedTo: ["moderator", "player"]
        };
      }
      return undefined;
    });

    render(<IamPolicyEditor />);
    await waitFor(() => expect(screen.getByText("Policies (1)")).toBeTruthy());
    fireEvent.click(screen.getByText("Policies (1)"));

    await waitFor(() => expect(screen.getByText("shared-policy")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /shared-policy/ }));

    await waitFor(() => expect(screen.getByText("Delete Policy")).toBeTruthy());
    fireEvent.click(screen.getByText("Delete Policy"));

    // Attached-while-delete is disabled server-side and surfaced
    // proactively in the confirm UI itself (attachedTo is known from the
    // catalog/detail fetch, no extra round-trip needed) -- confirms the
    // UI hat's "proactive disclosure" recommendation is honored.
    await waitFor(() => expect(screen.getByText(/Attached to: moderator, player/)).toBeTruthy());
  });
});

describe("IamPoliciesView: delete-confirmation state is scoped to the selected policy (Layer 2 audit finding C1)", () => {
  it("does not leave a delete confirmation armed for policy B after arming it for policy A and switching selection", async () => {
    const catalogWithTwoPolicies = {
      ...BASE_CATALOG,
      policies: {
        "pol-a": { name: "policy-a", managed: false, defaultVersionId: "v1", statements: [], versionCount: 1, attachedTo: [] },
        "pol-b": { name: "policy-b", managed: false, defaultVersionId: "v1", statements: [], versionCount: 1, attachedTo: [] }
      }
    };
    mockRoute((path) => {
      if (path === "/api/settings/iam/policies") return catalogWithTwoPolicies;
      if (path === "/api/auth/me") return { user: { tier: "owner" }, allowedActions: ["settings:write"] };
      if (path === "/api/settings/iam/policies/pol-a") {
        return { policyId: "pol-a", name: "policy-a", managed: false, defaultVersionId: "v1", versions: { v1: { statements: [], createdAt: "2026-01-01T00:00:00.000Z", createdBy: "owner" } }, attachedTo: [] };
      }
      if (path === "/api/settings/iam/policies/pol-b") {
        return { policyId: "pol-b", name: "policy-b", managed: false, defaultVersionId: "v1", versions: { v1: { statements: [], createdAt: "2026-01-01T00:00:00.000Z", createdBy: "owner" } }, attachedTo: [] };
      }
      return undefined;
    });

    render(<IamPolicyEditor />);
    await waitFor(() => expect(screen.getByText("Policies (2)")).toBeTruthy());
    fireEvent.click(screen.getByText("Policies (2)"));

    // Select policy A and arm its delete confirmation.
    await waitFor(() => expect(screen.getByText("policy-a")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /policy-a/ }));
    await waitFor(() => expect(screen.getByText("Delete Policy")).toBeTruthy());
    fireEvent.click(screen.getByText("Delete Policy"));
    await waitFor(() => expect(screen.getByText("Confirm Delete")).toBeTruthy());

    // Switch to policy B WITHOUT clicking Cancel first -- per the L2 audit
    // finding, the previous implementation left the "Confirm Delete"
    // button armed and pointed at whatever selectedPolicyId had become,
    // which could delete the WRONG policy. The fix must reset the confirm
    // state on every selection change.
    fireEvent.click(screen.getByRole("button", { name: /policy-b/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "policy-b" })).toBeTruthy());

    expect(screen.queryByText("Confirm Delete")).toBeNull();
    expect(screen.getByText("Delete Policy")).toBeTruthy(); // back to the un-armed state
  });

  it("clears stale detail content immediately on selection change, before the new fetch resolves", async () => {
    let resolveB: ((value: unknown) => void) | undefined;
    const catalogWithTwoPolicies = {
      ...BASE_CATALOG,
      policies: {
        "pol-a": { name: "policy-a", managed: false, defaultVersionId: "v1", statements: [], versionCount: 1, attachedTo: [] },
        "pol-b": { name: "policy-b", managed: false, defaultVersionId: "v1", statements: [], versionCount: 1, attachedTo: [] }
      }
    };
    mockRoute((path) => {
      if (path === "/api/settings/iam/policies") return catalogWithTwoPolicies;
      if (path === "/api/auth/me") return { user: { tier: "owner" }, allowedActions: ["settings:write"] };
      if (path === "/api/settings/iam/policies/pol-a") {
        return { policyId: "pol-a", name: "policy-a", managed: false, defaultVersionId: "v1", versions: { v1: { statements: [], createdAt: "2026-01-01T00:00:00.000Z", createdBy: "owner" } }, attachedTo: [] };
      }
      if (path === "/api/settings/iam/policies/pol-b") {
        // Deliberately never resolves within this test -- simulates a
        // slow network so we can assert on the intermediate render.
        return new Promise((resolve) => { resolveB = resolve; });
      }
      return undefined;
    });

    render(<IamPolicyEditor />);
    await waitFor(() => expect(screen.getByText("Policies (2)")).toBeTruthy());
    fireEvent.click(screen.getByText("Policies (2)"));
    await waitFor(() => expect(screen.getByText("policy-a")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /policy-a/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "policy-a" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /policy-b/ }));
    // Immediately after clicking B, while B's fetch is still pending,
    // policy-a's detail heading must NOT still be on screen -- it must
    // show the loading state instead, not stale content.
    expect(screen.queryByRole("heading", { name: "policy-a" })).toBeNull();
    expect(screen.getByText("Loading policy...")).toBeTruthy();

    resolveB?.({ policyId: "pol-b", name: "policy-b", managed: false, defaultVersionId: "v1", versions: { v1: { statements: [], createdAt: "2026-01-01T00:00:00.000Z", createdBy: "owner" } }, attachedTo: [] });
    await waitFor(() => expect(screen.getByRole("heading", { name: "policy-b" })).toBeTruthy());
  });
});

describe("IamPoliciesView: version cap proactive disclosure (L1 audit finding L1-M8)", () => {
  it("shows a persistent N/5 version count, not only a reactive error at the 6th attempt", async () => {
    const catalogWithPolicy = {
      ...BASE_CATALOG,
      policies: {
        "pol-1": { name: "capped-policy", managed: false, defaultVersionId: "v3", statements: [], versionCount: 3, attachedTo: [] }
      }
    };
    mockRoute((path) => {
      if (path === "/api/settings/iam/policies") return catalogWithPolicy;
      if (path === "/api/auth/me") return { user: { tier: "owner" }, allowedActions: ["settings:write"] };
      if (path === "/api/settings/iam/policies/pol-1") {
        return {
          policyId: "pol-1", name: "capped-policy", managed: false, defaultVersionId: "v3",
          versions: {
            v1: { statements: [], createdAt: "2026-01-01T00:00:00.000Z", createdBy: "owner" },
            v2: { statements: [], createdAt: "2026-01-02T00:00:00.000Z", createdBy: "owner" },
            v3: { statements: [], createdAt: "2026-01-03T00:00:00.000Z", createdBy: "owner" }
          },
          attachedTo: []
        };
      }
      return undefined;
    });

    render(<IamPolicyEditor />);
    await waitFor(() => expect(screen.getByText("Policies (1)")).toBeTruthy());
    fireEvent.click(screen.getByText("Policies (1)"));
    await waitFor(() => expect(screen.getByText("capped-policy")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /capped-policy/ }));

    await waitFor(() => expect(screen.getByText("Versions (3/5)")).toBeTruthy());
  });
});

describe("IamRolesView: Policy Simulator does not show stale results after switching tiers (Layer 3 audit finding L3-H6)", () => {
  it("clears the previous tier's Test results when switching to a different tier while remaining on the Test tab", async () => {
    mockRoute((path, options) => {
      if (path === "/api/settings/iam/policies") return BASE_CATALOG;
      if (path === "/api/auth/me") return { user: { tier: "owner" }, allowedActions: ["settings:write"] };
      if (path === "/api/settings/iam/policy/test" && options?.method === "POST") {
        const body = JSON.parse(options.body as string);
        // Distinct, easily-distinguishable results per tier so a stale
        // render is unambiguous.
        return { results: body.tier === "admin" ? { "server:restart": true } : { "server:restart": false } };
      }
      return undefined;
    });

    render(<IamPolicyEditor />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Admin" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    fireEvent.click(screen.getByText("Test"));
    fireEvent.click(screen.getByText("Run test"));
    await waitFor(() => expect(screen.getByText("1 allowed")).toBeTruthy());

    // Switch tiers WITHOUT leaving the Test tab -- per the L3 finding,
    // the previous tier's result table must not still be shown.
    fireEvent.click(screen.getByRole("button", { name: "Moderator" }));

    // The stale "1 allowed" summary from Admin's run must be gone; the
    // fresh, unrun state ("Run test" button, no results table) must be
    // shown instead, proving the component instance was reset, not reused.
    expect(screen.queryByText("1 allowed")).toBeNull();
    expect(screen.getByText("Run test")).toBeTruthy();
  });
});

// ---- IamPoliciesView half of the L3-H6 fix (Layer 3 re-audit, QA hat --
// this half had the identical key={selectedPolicyId} fix already applied
// in the source, but ZERO test coverage -- only IamRolesView's half
// (key={selectedTier}) was tested, above. Mirrors that exact test
// structure/pattern for the Policies view's own selection axis
// (selectedPolicyId, not selectedTier), closing the coverage gap. ----
describe("IamPoliciesView: Policy Simulator does not show stale results after switching policies (Layer 3 re-audit finding, L3-H6 -- previously untested half)", () => {
  it("clears the previous policy's Test results when switching to a different policy while remaining on the Test tab", async () => {
    const catalogWithTwoPolicies = {
      ...BASE_CATALOG,
      policies: {
        "pol-a": { name: "policy-a", managed: false, defaultVersionId: "v1", statements: [{ Effect: "Allow", Action: "server:restart" }], versionCount: 1, attachedTo: [] },
        "pol-b": { name: "policy-b", managed: false, defaultVersionId: "v1", statements: [], versionCount: 1, attachedTo: [] }
      }
    };
    mockRoute((path, options) => {
      if (path === "/api/settings/iam/policies") return catalogWithTwoPolicies;
      if (path === "/api/auth/me") return { user: { tier: "owner" }, allowedActions: ["settings:write"] };
      if (path === "/api/settings/iam/policies/pol-a") {
        return { policyId: "pol-a", name: "policy-a", managed: false, defaultVersionId: "v1", versions: { v1: { statements: [{ Effect: "Allow", Action: "server:restart" }], createdAt: "2026-01-01T00:00:00.000Z", createdBy: "owner" } }, attachedTo: [] };
      }
      if (path === "/api/settings/iam/policies/pol-b") {
        return { policyId: "pol-b", name: "policy-b", managed: false, defaultVersionId: "v1", versions: { v1: { statements: [], createdAt: "2026-01-01T00:00:00.000Z", createdBy: "owner" } }, attachedTo: [] };
      }
      if (path === "/api/settings/iam/policy/test" && options?.method === "POST") {
        const body = JSON.parse(options.body as string);
        // Draft mode sends the current policy's own draft statements --
        // policy-a's draft grants server:restart, policy-b's is empty, so
        // a stale render carrying policy-a's result into policy-b's view
        // is unambiguous.
        const grantsRestart = Array.isArray(body.statements) && body.statements.some((s: { Action?: string | string[] }) => s.Action === "server:restart" || (Array.isArray(s.Action) && s.Action.includes("server:restart")));
        return { results: { "server:restart": grantsRestart } };
      }
      return undefined;
    });

    render(<IamPolicyEditor />);
    await waitFor(() => expect(screen.getByText("Policies (2)")).toBeTruthy());
    fireEvent.click(screen.getByText("Policies (2)"));

    await waitFor(() => expect(screen.getByText("policy-a")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /policy-a/ }));
    await waitFor(() => expect(screen.getByText("Test")).toBeTruthy());
    fireEvent.click(screen.getByText("Test"));
    fireEvent.click(screen.getByText("Run test"));
    await waitFor(() => expect(screen.getByText("1 allowed")).toBeTruthy());

    // Switch to the OTHER policy WITHOUT leaving the Test tab -- per the
    // L3-H6 finding, the previous policy's result table must not still
    // be shown for the newly-selected policy. Selection change clears
    // `detail` synchronously and re-fetches (a separate, already-fixed
    // L2-H2 behavior) -- wait for policy-b's detail to finish loading
    // before asserting on the Test tab's contents.
    fireEvent.click(screen.getByRole("button", { name: /policy-b/ }));
    await waitFor(() => expect(screen.queryByText("Loading policy...")).toBeNull());

    // The stale "1 allowed" summary from policy-a's run must be gone; the
    // fresh, unrun state must be shown instead, proving the component
    // instance was reset via key={selectedPolicyId}, not reused.
    expect(screen.queryByText("1 allowed")).toBeNull();
    expect(screen.getByText("Run test")).toBeTruthy();
  });
});
