import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api } from "../../api/client";
import { IamPolicyEditor } from "./IamPolicyEditor";
// Vite raw-import suffix (no ambient module declared in this project -- no
// vite-env.d.ts -- but the suffix is resolved by Vite's transform pipeline at
// build/test time regardless of TS's own module resolution).
// @ts-expect-error -- see comment above
import iamPolicyEditorSource from "./IamPolicyEditor.tsx?raw";

// Regression tests for three IAM-editor contract bugs found in review:
//   (a) save issued POST {tier,statements} but the route is PUT {whole store}
//   (b) the Test tab called a server route whose contract it did not match
//   (c) the owner tier's string Action ("*") crashed toggleAction, and a
//       wildcard-granted checkbox silently snapped back
vi.mock("../../api/client", () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);

const CATALOG = {
  policies: {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] }, // STRING Action -> case (c)
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
  // players:kick is a parameterized-route action: it has NO literal actionMap
  // key, so it exists only here. regression -- the grid must still show it.
  allActions: ["server:restart", "server:read", "settings:change-password", "players:kick"],
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

  it("renders a checkbox for a parameterized-route action present only in allActions (players:kick)", async () => {
    mockLoad();
    render(<IamPolicyEditor />);
    // #634: namespace groups are collapsed by default -- expand "Players",
    // then its one access-level sub-group (no accessLevels field in this
    // fixture, so every action falls back to "Read" -- see levelForAction).
    fireEvent.click(await screen.findByLabelText("Expand Players"));
    fireEvent.click(await screen.findByLabelText("Expand Read"));
    // players:kick has no actionMap route key; before the fix the grid iterated
    // only actionMap values and this action never appeared (raw-JSON only).
    expect(await screen.findByText("players:kick")).toBeTruthy();
  });

  // /code-review ultra finding on PR #647, directly verified by hand: the
  // namespace header's select-all read the UNFILTERED groupedActions instead
  // of the search-filtered set the visible rows actually render from,
  // silently granting/revoking actions the operator never saw. Moderator
  // starts with server:read granted (exact literal) and server:restart not
  // -- searching "restart" should narrow what select-all can touch to just
  // server:restart.
  it("code-review finding: namespace select-all (revoke direction) only touches the search-filtered actions, not every action in the namespace", async () => {
    mockLoad();
    const { container } = render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Moderator"));
    fireEvent.click(await screen.findByLabelText("Expand Server"));

    // Grant server:restart too (no search active yet), so both server:read
    // and server:restart are now granted as exact literals.
    fireEvent.click(await screen.findByLabelText("Select all Server permissions"));
    fireEvent.click(screen.getByText("JSON"));
    const textareaEl = container.querySelector(".iam-json-textarea") as HTMLTextAreaElement;
    let stmts = JSON.parse(textareaEl.value) as Array<{ Effect: string; Action: string[] }>;
    let allowed = new Set(stmts.filter((s) => s.Effect === "Allow").flatMap((s) => s.Action));
    expect(allowed.has("server:read")).toBe(true);
    expect(allowed.has("server:restart")).toBe(true);

    // Now narrow to just server:restart and revoke -- the header's fresh
    // tri-state (scoped to the search) is "checked" (the one filtered action
    // is granted), so this click reverses direction to revoke. Only
    // server:restart is in scope; server:read must survive untouched.
    fireEvent.click(screen.getByText("Permissions"));
    fireEvent.change(await screen.findByLabelText("Search permissions"), { target: { value: "restart" } });
    fireEvent.click(await screen.findByLabelText("Select all Server permissions"));

    fireEvent.click(screen.getByText("JSON"));
    stmts = JSON.parse((container.querySelector(".iam-json-textarea") as HTMLTextAreaElement).value);
    allowed = new Set(stmts.filter((s) => s.Effect === "Allow").flatMap((s) => s.Action));
    expect(allowed.has("server:restart")).toBe(false);
    // The bug: scoping to the full unfiltered namespace would revoke BOTH
    // exact literals, wrongly removing an action outside the search filter
    // the operator never saw or intended to touch.
    expect(allowed.has("server:read")).toBe(true);
  });

  // /code-review ultra finding on PR #647: applyGroupSelection's grant-vs-
  // revoke direction used to be captured from the render-time tri-state
  // (nsState/levelState, itself derived from the `allowedActions` memo --
  // only current as of the last completed render), not re-derived fresh
  // inside the functional setJsonText update the way toggleAction already
  // does for the single-checkbox case (see the #10 test above). Two clicks
  // landing before a re-render both saw the same stale direction, so the
  // second click silently no-op'd instead of reverting -- the checkbox
  // looked permanently stuck checked. A DOM-event-timing reproduction is
  // not reliably reproducible under jsdom/RTL for the same reason #10's own
  // comment gives (each dispatched event is independently flushed by
  // React's per-event batching in this environment) -- pinning the actual
  // regression via source inspection instead, matching #10's own approach.
  it("code-review finding: applyGroupSelection's direction is re-derived from the freshly-parsed statements, not a caller-supplied `select` parameter (source pin)", () => {
    const src = iamPolicyEditorSource as string;
    const fnStart = src.indexOf("const applyGroupSelection = (groupActions: string[]) => {");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, fnStart + 1200);
    // The direction must be computed from `groupTriState(groupActions,
    // currentAllowed, ...)` -- currentAllowed itself derived from the
    // freshly-parsed `stmts` a few lines above -- never from a `select`
    // function parameter (the pre-fix shape) or the outer nsState/levelState.
    expect(fnBody).toMatch(/const select = groupTriState\(groupActions, currentAllowed,/);
    expect(fnBody).not.toMatch(/nsState|levelState/);
    // And the two call sites must no longer pass a second argument at all.
    expect(src).toMatch(/applyGroupSelection\(nsActions\)/);
    expect(src).not.toMatch(/applyGroupSelection\(nsActions,/);
    expect(src).toMatch(/applyGroupSelection\(levelActions\)/);
    expect(src).not.toMatch(/applyGroupSelection\(levelActions,/);
  });

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

  it("Test tab evaluates the draft locally and honors Deny, with no /policy/test call", async () => {
    mockLoad();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Test"));

    // admin: server:* -> server:restart + server:read allowed (2); settings:* Deny -> change-password
    // denied, and players:kick is neither allowed nor denied so it default-denies too (2 denied).
    expect(await screen.findByText("2 allowed")).toBeTruthy();
    expect(screen.getByText("2 denied")).toBeTruthy();
    expect(mockApi).not.toHaveBeenCalledWith("/api/settings/iam/policy/test", expect.anything());
  });

  it("#7 the owner tier's string Action does not crash the grid, and a wildcard grant surfaces a hint instead of snapping back", async () => {
    mockLoad();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Owner")); // string Action "*" -> would throw before the fix

    // The grid renders (owner sees everything allowed via "*") without throwing;
    // before the fix, toggleAction's s.Action.filter on the string "*" threw.
    // #634: expand a namespace + its access-level sub-group to reach an
    // individual action's checkbox (the header tri-state checkboxes visible
    // before expanding are select-all controls, not this one).
    fireEvent.click(await screen.findByLabelText("Expand Server"));
    fireEvent.click(await screen.findByLabelText("Expand Read"));
    const row = (await screen.findByText("server:read")).closest("label")!;
    const checkbox = row.querySelector('input[type="checkbox"]')!;
    fireEvent.click(checkbox); // wildcard-granted: cannot be toggled off by checkbox
    expect(await screen.findByText(/granted by a wildcard rule/i)).toBeTruthy();
  });

  it("action-centric grid: many routes sharing one IAM action render ONE checkbox (unchecking no longer clears siblings)", async () => {
    // GET /api/server, /status, /health all map to server:read. The old
    // route-centric grid drew THREE "Read" checkboxes and unchecking one cleared
    // the others (the reported bug). Action-centric => one "Read" checkbox.
    const dup = structuredClone(CATALOG) as { policies: typeof CATALOG.policies; actions: string[]; actionMap: Record<string, string>; allActions: string[]; namespaces: Record<string, unknown> };
    dup.actions = ["GET /api/server", "GET /api/server/status", "GET /api/server/health", "POST /api/server/restart"];
    dup.actionMap = {
      "GET /api/server": "server:read",
      "GET /api/server/status": "server:read",
      "GET /api/server/health": "server:read",
      "POST /api/server/restart": "server:restart",
    };
    mockApi.mockImplementation((path: string, opts?: RequestInit) => {
      if (path === "/api/settings/iam/policies" && (!opts || opts.method === undefined)) return Promise.resolve(dup as never);
      if (path === "/api/settings/iam/policy" && opts?.method === "PUT") return Promise.resolve({ ok: true, policies: JSON.parse(String(opts.body)) } as never);
      return Promise.reject(new Error("unexpected"));
    });
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Moderator")); // moderator allows exactly server:read (exact literal, toggleable)
    // #634: expand "Server", then its one access-level sub-group (no
    // accessLevels field in this fixture -- every action falls back to "Read").
    fireEvent.click(await screen.findByLabelText("Expand Server"));
    fireEvent.click(await screen.findByLabelText("Expand Read"));

    // 3 read routes collapse to ONE action-row "Read" checkbox (the
    // ".iam-perm-label" selector excludes the "Read" access-level sub-header
    // introduced by #634, which also renders the literal text "Read");
    // one "Restart" too.
    await waitFor(() => expect(screen.getAllByText("Read", { selector: ".iam-perm-label" }).length).toBe(1));
    expect(screen.getAllByText("Restart", { selector: ".iam-perm-label" }).length).toBe(1);

    // Unchecking Read removes only server:read; save PUTs moderator without it.
    const readRow = screen.getByText("Read", { selector: ".iam-perm-label" }).closest("label")!;
    fireEvent.click(readRow.querySelector('input[type="checkbox"]')!);
    fireEvent.click(screen.getByText("Save moderator policy"));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/settings/iam/policy", expect.objectContaining({ method: "PUT" })));
    const put = mockApi.mock.calls.find(([p, o]) => p === "/api/settings/iam/policy" && (o as RequestInit)?.method === "PUT")!;
    const body = JSON.parse(String((put[1] as RequestInit).body));
    const modActions = body.moderator.statements.flatMap((st: { Action: string[] }) => st.Action);
    expect(modActions).not.toContain("server:read");
  });

  it("#10 toggleAction's grant/revoke branch decision reads the freshly-parsed statements, not the outer allowedActions memo (review finding, source pin)", () => {
    // A DOM-event-timing reproduction of "two toggles fired before React
    // re-renders between them" is not reliably reproducible under jsdom/RTL
    // (each dispatched event is independently flushed by React's per-event
    // batching in this environment, even nested inside one act() call) --
    // actionGrantedByStatements' own behavior across chained statement lists
    // is covered directly in IamPolicyEditor.grouping.test.ts. This pins the
    // actual regression: toggleAction's branch decision must call
    // actionGrantedByStatements(stmts, ...) -- the freshly-parsed, in-flight
    // statement list -- never allowedActions.has(...), the memoized value
    // from the last completed render, which the first fix (c3b416d4) left in
    // place when it moved only the text mutation to a functional update.
    const src = iamPolicyEditorSource as string;
    const toggleActionStart = src.indexOf("const toggleAction = (iamAction: string) => {");
    expect(toggleActionStart).toBeGreaterThan(-1);
    const toggleActionBody = src.slice(toggleActionStart, toggleActionStart + 1200);
    expect(toggleActionBody).toMatch(/actionGrantedByStatements\(stmts,\s*iamAction\)/);
    expect(toggleActionBody).not.toMatch(/allowedActions\.has\(iamAction\)/);
  });
});

describe("IamPolicyEditor: ambiguous action labels get a plain-language explanation (live-testing finding)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("relabels the Deny-locked, jargon action players:mutate to something meaningful, with a description tooltip too", async () => {
    const dup = structuredClone(CATALOG) as { policies: typeof CATALOG.policies; actions: string[]; actionMap: Record<string, string>; allActions: string[]; namespaces: Record<string, unknown> };
    dup.policies.admin = {
      version: 1, tier: "admin",
      statements: [{ Effect: "Allow", Action: ["players:*"] }, { Effect: "Deny", Action: ["players:mutate"] }],
    };
    dup.actions = ["POST /api/players/give-item"];
    dup.actionMap = { "POST /api/players/give-item": "players:mutate" };
    dup.allActions = ["players:mutate"];
    mockApi.mockImplementation((path: string, opts?: RequestInit) => {
      if (path === "/api/settings/iam/policies" && (!opts || opts.method === undefined)) return Promise.resolve(dup as never);
      return Promise.reject(new Error("unexpected"));
    });
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Admin"));
    // #634: namespace groups are collapsed by default -- expand "Players",
    // then its one access-level sub-group (no accessLevels field in this
    // fixture, so every action falls back to "Read").
    fireEvent.click(await screen.findByLabelText("Expand Players"));
    fireEvent.click(await screen.findByLabelText("Expand Read"));

    // The bare mechanical label ("Mutate") is overridden entirely -- an
    // operator shouldn't have to hover to learn what an action does.
    expect(screen.queryByText("Mutate")).toBeNull();
    const label = await screen.findByText("Give Items / Currency");
    expect(label.getAttribute("title")).toMatch(/give items, add currency/i);
    const row = label.closest("label")!;
    expect(row.getAttribute("title")).toMatch(/give items, add currency/i);
    expect(row.getAttribute("title")).toMatch(/blocked by a deny rule/i);
  });

  it("relabels admin:vehicles:read so it doesn't read as the unrelated live-Vehicles-panel permission", async () => {
    const dup = structuredClone(CATALOG) as { policies: typeof CATALOG.policies; actions: string[]; actionMap: Record<string, string>; allActions: string[]; namespaces: Record<string, unknown> };
    dup.policies.admin = { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: ["admin:vehicles:read"] }] };
    dup.actions = ["GET /api/admin/vehicles/structured"];
    dup.actionMap = { "GET /api/admin/vehicles/structured": "admin:vehicles:read" };
    dup.allActions = ["admin:vehicles:read"];
    mockApi.mockImplementation((path: string, opts?: RequestInit) => {
      if (path === "/api/settings/iam/policies" && (!opts || opts.method === undefined)) return Promise.resolve(dup as never);
      return Promise.reject(new Error("unexpected"));
    });
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Admin"));
    // #634: expand "Admin Tools", then its one access-level sub-group (no
    // accessLevels field in this fixture -- every action falls back to "Read").
    fireEvent.click(await screen.findByLabelText("Expand Admin Tools"));
    fireEvent.click(await screen.findByLabelText("Expand Read"));

    expect(await screen.findByText("Vehicle Catalog")).toBeTruthy();
    expect(screen.queryByText("Vehicles Read")).toBeNull();
  });
});

describe("IamPolicyEditor: the Permissions grid is read-only while the JSON tab holds invalid JSON", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not replace the draft with a single Allow when a box is clicked over unparseable JSON", async () => {
    mockLoad();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Admin"));
    fireEvent.click(await screen.findByText("JSON"));
    const textarea = document.querySelector("textarea.iam-json-textarea") as HTMLTextAreaElement;
    const broken = '[{"Effect":"Allow","Action":["server:*"]},{"Effect":"Deny","Action":["settings:*"]},]'; // trailing comma
    fireEvent.change(textarea, { target: { value: broken } });
    fireEvent.click(screen.getByText("Permissions"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid JSON/i);
    const boxes = document.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box).toBeDisabled();
    fireEvent.click(boxes[0]);

    fireEvent.click(screen.getByText("JSON"));
    const after = document.querySelector("textarea.iam-json-textarea") as HTMLTextAreaElement;
    expect(after.value).toBe(broken); // the operator's draft -- Deny block included -- is untouched
    expect(mockApi).not.toHaveBeenCalledWith("/api/settings/iam/policy", expect.objectContaining({ method: "PUT" }));
  });
});

// #634 (AWS-IAM-Visual-Editor-style Access Control UI). Integration coverage
// for the accordion/select-all wiring on top of the pure functions already
// unit-tested in iamPolicyGroups.test.ts.
const GROUP_CATALOG = {
  policies: {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: ["players:read"] }] },
  },
  actions: [],
  actionMap: {},
  allActions: ["players:read", "players:kick", "players:mutate"],
  accessLevels: { "players:read": "read", "players:kick": "write", "players:mutate": "permissions" },
  crownJewelActions: ["players:mutate"],
  namespaces: {},
};

function mockGroupCatalog() {
  mockApi.mockImplementation((path: string, opts?: RequestInit) => {
    if (path === "/api/settings/iam/policies" && (!opts || opts.method === undefined)) return Promise.resolve(structuredClone(GROUP_CATALOG) as never);
    if (path === "/api/settings/iam/policy" && opts?.method === "PUT") return Promise.resolve({ ok: true, policies: JSON.parse(String(opts.body)) } as never);
    return Promise.reject(new Error(`unexpected api call: ${opts?.method || "GET"} ${path}`));
  });
}

describe("IamPolicyEditor: namespace select-all excludes crown-jewel actions for a non-owner tier", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the owner-only count in the collapsed header, and select-all grants everything else without granting the crown jewel", async () => {
    mockGroupCatalog();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Admin"));

    // Visible without expanding -- an operator who selects-all from a
    // collapsed header and moves on must still see this (Eight Hats UI/UX
    // finding H2).
    expect(await screen.findByText(/1\/3 allowed — 1 owner-only/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Select all Players permissions"));
    fireEvent.click(await screen.findByLabelText("Expand Players"));
    fireEvent.click(await screen.findByLabelText("Expand Write"));
    // players:kick (write) is now granted by select-all.
    const kickRow = (await screen.findByText("players:kick")).closest("label")!;
    expect(kickRow.querySelector('input[type="checkbox"]')).toBeChecked();

    fireEvent.click(await screen.findByLabelText("Expand Permissions Management"));
    // players:mutate (the crown jewel) was NOT granted by select-all.
    const mutateRow = (await screen.findByText("players:mutate")).closest("label")!;
    expect(mutateRow.querySelector('input[type="checkbox"]')).not.toBeChecked();
  });

  it("owner's select-all DOES include the crown-jewel action -- the exclusion only applies to non-owner tiers", async () => {
    mockGroupCatalog();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Owner")); // default-selected tier is admin; switch explicitly

    fireEvent.click(await screen.findByLabelText("Select all Players permissions"));
    fireEvent.click(await screen.findByLabelText("Expand Players"));
    fireEvent.click(await screen.findByLabelText("Expand Permissions Management"));
    const mutateRow = (await screen.findByText("players:mutate")).closest("label")!;
    // Owner already grants everything via "*" -- select-all is a no-op here,
    // but the row must show granted (it already was), not excluded/locked.
    expect(mutateRow.querySelector('input[type="checkbox"]')).toBeChecked();
  });

  it("unchecking a fully-granted namespace header revokes every exact-literal grant in it", async () => {
    mockGroupCatalog();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Admin"));
    fireEvent.click(await screen.findByLabelText("Expand Players"));
    fireEvent.click(await screen.findByLabelText("Expand Read"));
    // players:read is admin's only current grant -- the namespace header
    // covers 1/3 (players:mutate is excluded from the denominator too), so
    // clicking it again after it reaches "checked" for the grantable subset
    // must revoke, not re-grant. Grant players:kick first via select-all so
    // the grantable subset (read+write) is fully checked, then verify
    // unchecking clears both literals.
    fireEvent.click(screen.getByLabelText("Select all Players permissions"));
    await waitFor(() => expect(screen.getByLabelText("Select all Players permissions")).toBeChecked());
    fireEvent.click(screen.getByLabelText("Select all Players permissions"));
    const readRow = (await screen.findByText("players:read")).closest("label")!;
    expect(readRow.querySelector('input[type="checkbox"]')).not.toBeChecked();
  });
});

describe("IamPolicyEditor: search auto-expands a matching group without discarding a manual toggle made during the search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-expands a namespace containing a search match, and preserves an unrelated namespace manually expanded during the same search after the search is cleared", async () => {
    mockGroupCatalog();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Admin"));

    // "Players" starts collapsed -- confirm the collapsed state before searching.
    expect(screen.queryByText("players:read")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search permissions"), { target: { value: "kick" } });
    // Auto-expanded by the search match, with no manual click.
    expect(await screen.findByText("players:kick")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search permissions"), { target: { value: "" } });
    // Reverts to collapsed -- the auto-expand was never written into the
    // manual expand state.
    expect(screen.queryByText("players:kick")).toBeNull();
  });
});
