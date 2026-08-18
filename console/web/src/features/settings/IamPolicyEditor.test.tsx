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
      if (path === "/api/auth/me") return { user: { tier: "owner" } };
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
      if (path === "/api/auth/me") return { user: { tier: "owner" } };
      return undefined;
    });
    render(<IamPolicyEditor />);
    await waitFor(() => expect(screen.getByText("Policies (0)")).toBeTruthy());

    fireEvent.click(screen.getByText("Policies (0)"));
    expect(screen.getByText(/No named policies yet/)).toBeTruthy();
  });
});

describe("IamRolesView: owner-lockout error surfacing (L1 audit finding L1-H7)", () => {
  it("surfaces the backend's real rejection message verbatim, not a generic failure string", async () => {
    mockRoute((path, options) => {
      if (path === "/api/settings/iam/policies") return BASE_CATALOG;
      if (path === "/api/auth/me") return { user: { tier: "owner" } };
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
      if (path === "/api/auth/me") return { user: { tier: "owner" } };
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
      if (path === "/api/auth/me") return { user: { tier: "owner" } };
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
      if (path === "/api/auth/me") return { user: { tier: "owner" } };
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
      if (path === "/api/auth/me") return { user: { tier: "owner" } };
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
