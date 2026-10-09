import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { IamPolicyEditor } from "./IamPolicyEditor";
import { api } from "../../api/client";

vi.mock("../../api/client", () => ({ api: vi.fn(), post: vi.fn() }));

// Issue #1179: the editor's Save used to POST { tier, statements } to a route that does not exist,
// so nothing was ever saved. The server takes the COMPLETE store on PUT /api/settings/iam/policy.

const TIERS = ["owner", "admin", "moderator", "player"];
const doc = (tier: string, action = "backups:*") => ({ version: 1, tier, statements: [{ Effect: "Allow" as const, Action: [action] }] });
const store = () => Object.fromEntries(TIERS.map((tier) => [tier, doc(tier)]));
const catalog = (extra: Record<string, unknown> = {}) => ({
  policies: store(),
  actions: ["backups:create", "backups:download-system"],
  actionMap: {},
  namespaces: {},
  ...extra,
});

const SYSTEM = ["backups:download-system", "backups:import-system", "backups:restore-system"];

function serve(putResult: unknown, get = catalog()) {
  const calls: { path: string; init?: RequestInit }[] = [];
  vi.mocked(api).mockImplementation((async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (init?.method === "PUT") {
      if (putResult instanceof Error) throw putResult;
      return putResult;
    }
    return get;
  }) as typeof api);
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("saving PUTs the complete policy store, with the edited tier replaced and the others kept", async () => {
  const calls = serve({ ok: true });
  render(<IamPolicyEditor />);
  fireEvent.click(await screen.findByRole("button", { name: "Save admin policy" }));
  await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));

  const put = calls.find((c) => c.init?.method === "PUT")!;
  expect(put.path).toBe("/api/settings/iam/policy");
  const sent = JSON.parse(String(put.init?.body));
  expect(Object.keys(sent).sort()).toEqual([...TIERS].sort());
  expect(sent.admin.statements).toEqual([{ Effect: "Allow", Action: ["backups:*"] }]);
  expect(sent.owner).toEqual(doc("owner"));
  expect(await screen.findByRole("button", { name: "Saved" })).toBeInTheDocument();
});

test("adopts what the server now enforces and says which shipped Deny the save added", async () => {
  const enforced = store();
  enforced.admin = { version: 1, tier: "admin", statements: [
    { Effect: "Allow", Action: ["backups:*"] },
    { Effect: "Deny", Action: SYSTEM },
  ] } as typeof enforced.admin;
  serve({
    ok: true,
    policies: enforced,
    addedDefaultDenies: SYSTEM.map((action) => ({ tier: "admin", action })),
    notices: { addedDefaultDenies: [], keptExactAllows: [] },
  }, catalog({
    notices: { addedDefaultDenies: [], keptExactAllows: [{ tier: "admin", action: "backups:download-system" }] },
  }));
  render(<IamPolicyEditor />);
  // The warning about the kept exact-name Allow is on screen before the save ...
  expect(await screen.findByText(/Allowed by name, so the shipped Deny was not applied/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save admin policy" }));

  // ... and gone after it, replaced by an honest account of what the save did.
  const note = await screen.findByText(/Saved\. The shipped Deny was also added for/);
  expect(note).toHaveTextContent("Admin: backups:download-system, Admin: backups:import-system, Admin: backups:restore-system");
  expect(screen.queryByText(/Allowed by name, so the shipped Deny was not applied/)).not.toBeInTheDocument();

  // The JSON view now shows the statements the server enforces, including the Deny it added.
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("\"Deny\"");
});

test("shows the server's reason when a save is rejected instead of a generic failure", async () => {
  serve(new Error("The owner policy must retain settings:write access."));
  render(<IamPolicyEditor />);
  fireEvent.click(await screen.findByRole("button", { name: "Save admin policy" }));
  expect(await screen.findByText("The owner policy must retain settings:write access.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Saved" })).not.toBeInTheDocument();
});
