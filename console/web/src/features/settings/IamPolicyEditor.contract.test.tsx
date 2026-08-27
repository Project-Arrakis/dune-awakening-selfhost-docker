import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api } from "../../api/client";
import { IamPolicyEditor } from "./IamPolicyEditor";

// Regression tests for the three IAM-editor contract bugs found by the
// /code-review ultra pass on PR #554 (all against committed HEAD at the time):
//   #5  save issued POST {tier,statements} but the route is PUT {whole store}
//   #12 the Test tab called a server route whose contract it did not match
//   #7  the owner tier's string Action ("*") crashed toggleAction, and a
//       wildcard-granted checkbox silently snapped back
vi.mock("../../api/client", () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);

const CATALOG = {
  policies: {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] }, // STRING Action -> #7
    admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: ["server:*"] }, { Effect: "Deny", Action: ["settings:*"] }] },
    moderator: { version: 1, tier: "moderator", statements: [{ Effect: "Allow", Action: ["server:read"] }] },
    player: { version: 1, tier: "player", statements: [{ Effect: "Allow", Action: ["server:read"] }] },
  },
  actions: ["POST /api/server/restart", "GET /api/server", "POST /api/settings/admin-password"],
  actionMap: {
    "POST /api/server/restart": "server:restart",
    "GET /api/server": "server:read",
    "POST /api/settings/admin-password": "settings:change-password",
  },
  namespaces: {},
};

function mockLoad() {
  mockApi.mockImplementation((path: string, opts?: RequestInit) => {
    if (path === "/api/settings/iam/policies" && (!opts || opts.method === undefined)) {
      return Promise.resolve(structuredClone(CATALOG) as never);
    }
    if (path === "/api/settings/iam/policy" && opts?.method === "PUT") {
      return Promise.resolve({ ok: true, policies: JSON.parse(String(opts.body)) } as never);
    }
    return Promise.reject(new Error(`unexpected api call: ${opts?.method || "GET"} ${path}`));
  });
}

describe("IamPolicyEditor server contracts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("#5 save PUTs the whole tier-keyed store, not POST {tier, statements}", async () => {
    mockLoad();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Save admin policy"));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        "/api/settings/iam/policy",
        expect.objectContaining({ method: "PUT" })
      )
    );
    const putCall = mockApi.mock.calls.find(([p, o]) => p === "/api/settings/iam/policy" && (o as RequestInit)?.method === "PUT")!;
    const body = JSON.parse(String((putCall[1] as RequestInit).body));
    // Every tier is present (whole store), with admin's edited document in place.
    expect(Object.keys(body).sort()).toEqual(["admin", "moderator", "owner", "player"]);
    expect(body.admin.statements).toEqual(CATALOG.policies.admin.statements);
    // Never the broken POST-single-document shape.
    expect(mockApi).not.toHaveBeenCalledWith("/api/settings/iam/policy", expect.objectContaining({ method: "POST" }));
  });

  it("#12 Test tab evaluates the draft locally and honors Deny, with no /policy/test call", async () => {
    mockLoad();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Test"));

    // admin: server:* -> server:restart + server:read allowed (2); settings:* Deny -> change-password denied (1).
    expect(await screen.findByText("2 allowed")).toBeTruthy();
    expect(screen.getByText("1 denied")).toBeTruthy();
    expect(mockApi).not.toHaveBeenCalledWith("/api/settings/iam/policy/test", expect.anything());
  });

  it("#7 the owner tier's string Action does not crash the grid, and a wildcard grant surfaces a hint instead of snapping back", async () => {
    mockLoad();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Owner")); // string Action "*" -> would throw before the fix

    // The grid renders (owner sees everything allowed via "*") without throwing;
    // before the fix, toggleAction's s.Action.filter on the string "*" threw.
    const checkboxes = await screen.findAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);
    fireEvent.click(checkboxes[0]); // wildcard-granted: cannot be toggled off by checkbox
    expect(await screen.findByText(/granted by a wildcard rule/i)).toBeTruthy();
  });
});
