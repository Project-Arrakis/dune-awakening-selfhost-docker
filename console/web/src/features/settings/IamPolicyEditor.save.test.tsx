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

test("saves on top of the store as it is now, not the copy loaded when the page opened", async () => {
  // Another admin changed the moderator tier after this page loaded.
  const stale = catalog();
  const fresh = catalog();
  fresh.policies.moderator = { version: 1, tier: "moderator", statements: [{ Effect: "Allow" as const, Action: ["players:read"] }] };
  const calls: { path: string; init?: RequestInit }[] = [];
  let gets = 0;
  vi.mocked(api).mockImplementation((async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (init?.method === "PUT") return { ok: true };
    gets += 1;
    return gets === 1 ? stale : fresh;
  }) as typeof api);
  render(<IamPolicyEditor />);
  fireEvent.click(await screen.findByRole("button", { name: "Save admin policy" }));
  await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
  const sent = JSON.parse(String(calls.find((c) => c.init?.method === "PUT")!.init?.body));
  expect(sent.moderator.statements).toEqual([{ Effect: "Allow", Action: ["players:read"] }]);
  expect(sent.admin.statements).toEqual([{ Effect: "Allow", Action: ["backups:*"] }]);
});

test("the note about what the last save added goes away when another policy is shown", async () => {
  const enforced = store();
  serve({
    ok: true,
    policies: enforced,
    addedDefaultDenies: SYSTEM.map((action) => ({ tier: "admin", action })),
    notices: { addedDefaultDenies: [], keptExactAllows: [] },
  });
  render(<IamPolicyEditor />);
  fireEvent.click(await screen.findByRole("button", { name: "Save admin policy" }));
  expect(await screen.findByText(/Saved\. The shipped Deny was also added for/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Moderator" }));
  expect(screen.queryByText(/Saved\. The shipped Deny was also added for/)).not.toBeInTheDocument();
});

test("a save that finishes after the operator switched tier does not rewrite the tier now on screen", async () => {
  // The PUT is held open while the operator clicks another tier.
  let release: (value: unknown) => void = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const enforced = store();
  enforced.admin = { version: 1, tier: "admin", statements: [
    { Effect: "Allow", Action: ["backups:*"] },
    { Effect: "Deny", Action: SYSTEM },
  ] } as typeof enforced.admin;
  vi.mocked(api).mockImplementation((async (_path: string, init?: RequestInit) => {
    if (init?.method === "PUT") return held;
    return catalog();
  }) as typeof api);
  render(<IamPolicyEditor />);
  fireEvent.click(await screen.findByRole("button", { name: "Save admin policy" }));
  fireEvent.click(screen.getByRole("button", { name: "Moderator" }));

  release({
    ok: true,
    policies: enforced,
    addedDefaultDenies: SYSTEM.map((action) => ({ tier: "admin", action })),
    notices: { addedDefaultDenies: [], keptExactAllows: [] },
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save moderator policy" })).toBeEnabled());

  // The admin tier's note and statements must not appear under the moderator tier.
  expect(screen.queryByText(/Saved\. The shipped Deny was also added for/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  const shown = (screen.getByRole("textbox") as HTMLTextAreaElement).value;
  expect(shown).not.toContain("\"Deny\"");
  expect(shown).toContain("backups:*");
});

// Issue #1193: the save carries the revision it loaded; the server refuses it if another admin saved first.

test("sends the revision of the store it just read as If-Match", async () => {
  const calls = serve({ ok: true }, catalog({ revision: "rev-1" }));
  render(<IamPolicyEditor />);
  fireEvent.click(await screen.findByRole("button", { name: "Save admin policy" }));
  await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
  const put = calls.find((c) => c.init?.method === "PUT")!;
  expect(put.init?.headers).toEqual({ "If-Match": "rev-1" });
});

test("on a conflict it keeps the admin's edit, shows the server's message, and the next Save uses the new revision", async () => {
  const theirs = store();
  theirs.moderator = doc("moderator", "players:read");
  let putCount = 0;
  const putHeaders: unknown[] = [];
  let latest = catalog({ revision: "rev-1" });
  vi.mocked(api).mockImplementation((async (path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      putCount += 1;
      putHeaders.push(init.headers);
      if (putCount === 1) {
        latest = catalog({ revision: "rev-2", policies: theirs });
        throw Object.assign(new Error("The policies changed since you loaded them. Review the current policies and save again."), {
          status: 409,
          body: { conflict: true, policies: theirs, revision: "rev-2" }
        });
      }
      return { ok: true, revision: "rev-3" };
    }
    // After the conflict the refetch fails, so the second Save depends on what the conflict response handed back.
    if (putCount >= 1) throw new Error("offline");
    return latest;
  }) as typeof api);

  render(<IamPolicyEditor />);
  const save = await screen.findByRole("button", { name: "Save admin policy" });
  fireEvent.click(save);
  expect(await screen.findByText(/The policies changed since you loaded them/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Saved" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("backups:*");

  fireEvent.click(await screen.findByRole("button", { name: "Save admin policy" }));
  expect(await screen.findByRole("button", { name: "Saved" })).toBeInTheDocument();
  expect(putHeaders).toEqual([{ "If-Match": "rev-1" }, { "If-Match": "rev-2" }]);
});

// Review of #1194: the editor re-reads the store before saving. That fresh revision must NOT be sent if
// the tier being saved changed since the page showed it, or the server would accept the overwrite.

test("does not send a save when another admin changed this tier since the page showed it", async () => {
  const theirs = store();
  theirs.admin = doc("admin", "backups:delete");
  const calls: { path: string; init?: RequestInit }[] = [];
  let gets = 0;
  vi.mocked(api).mockImplementation((async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (init?.method === "PUT") return { ok: true };
    gets += 1;
    return gets === 1 ? catalog({ revision: "rev-1" }) : catalog({ revision: "rev-2", policies: theirs });
  }) as typeof api);

  render(<IamPolicyEditor />);
  fireEvent.click(await screen.findByRole("button", { name: "Save admin policy" }));
  expect(await screen.findByText(/Another admin changed the admin policy/)).toBeInTheDocument();
  expect(calls.some((c) => c.init?.method === "PUT")).toBe(false);

  // Their version is available on request; the admin's own text was kept until then.
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("backups:*");
  fireEvent.click(screen.getByRole("button", { name: "Show current policy" }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("backups:delete");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a change to ANOTHER tier does not stop the save, and its revision is the one sent", async () => {
  const theirs = store();
  theirs.moderator = doc("moderator", "players:read");
  const calls: { path: string; init?: RequestInit }[] = [];
  let gets = 0;
  vi.mocked(api).mockImplementation((async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (init?.method === "PUT") return { ok: true, revision: "rev-3" };
    gets += 1;
    return gets === 1 ? catalog({ revision: "rev-1" }) : catalog({ revision: "rev-2", policies: theirs });
  }) as typeof api);

  render(<IamPolicyEditor />);
  fireEvent.click(await screen.findByRole("button", { name: "Save admin policy" }));
  expect(await screen.findByRole("button", { name: "Saved" })).toBeInTheDocument();
  const put = calls.find((c) => c.init?.method === "PUT")!;
  expect(put.init?.headers).toEqual({ "If-Match": "rev-2" });
  expect(JSON.parse(String(put.init?.body)).moderator).toEqual(theirs.moderator);
});

test("a save response without a revision does not leave the consumed one to be sent again", async () => {
  const puts: unknown[] = [];
  let putCount = 0;
  vi.mocked(api).mockImplementation((async (_path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      putCount += 1;
      puts.push(init.headers);
      return { ok: true };
    }
    // The first read succeeds; later re-reads fail, so the second Save falls back to what the page holds.
    if (putCount >= 1) throw new Error("offline");
    return catalog({ revision: "rev-1" });
  }) as typeof api);

  render(<IamPolicyEditor />);
  fireEvent.click(await screen.findByRole("button", { name: "Save admin policy" }));
  expect(await screen.findByRole("button", { name: "Saved" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Saved" }));
  await waitFor(() => expect(puts).toHaveLength(2));
  expect(puts[0]).toEqual({ "If-Match": "rev-1" });
  expect(puts[1]).toBeUndefined();
});
