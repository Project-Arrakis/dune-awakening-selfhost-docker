import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { IamPolicyEditor } from "./IamPolicyEditor";
import { api } from "../../api/client";

vi.mock("../../api/client", () => ({ api: vi.fn(), post: vi.fn() }));

// Issue #1160: a saved policy that silently gained Deny rules at load (or deliberately kept a
// system-backup Allow) must say so on the Settings page, not only in the container log.

const statements = [{ Effect: "Allow" as const, Action: ["backups:*"] }];
const catalog = (notices?: unknown) => ({
  policies: Object.fromEntries(
    ["owner", "admin", "moderator", "player"].map((tier) => [tier, { version: 1, tier, statements }]),
  ),
  actions: ["backups:create", "backups:download-system"],
  actionMap: {},
  namespaces: {},
  ...(notices === undefined ? {} : { notices }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

test("explains the Deny rules that were added to a saved policy at load", async () => {
  vi.mocked(api).mockResolvedValue(catalog({
    addedDefaultDenies: [
      { tier: "admin", action: "backups:download-system" },
      { tier: "admin", action: "backups:restore-system" },
    ],
    keptExactAllows: [],
  }));
  render(<IamPolicyEditor />);
  const notice = await screen.findByRole("status");
  expect(notice).toHaveTextContent("Deny rules were added when the Console started");
  expect(notice).toHaveTextContent("Admin: backups:download-system, Admin: backups:restore-system");
  expect(notice).toHaveTextContent("403");
  expect(notice).toHaveTextContent("Save the policy to keep the change");
  expect(screen.getAllByRole("status")).toHaveLength(1);
});

test("warns when an exact-name Allow kept the shipped Deny away", async () => {
  vi.mocked(api).mockResolvedValue(catalog({
    addedDefaultDenies: [],
    keptExactAllows: [{ tier: "admin", action: "backups:download-system" }],
  }));
  render(<IamPolicyEditor />);
  const notice = await screen.findByRole("status");
  expect(notice).toHaveTextContent("Allowed by name, so the shipped Deny was not applied");
  expect(notice).toHaveTextContent("Admin: backups:download-system");
  expect(notice).toHaveTextContent("every credential on this host");
  expect(notice).toHaveClass("iam-notice-warning");
});

test("shows nothing when there is nothing to explain, including from an older API without notices", async () => {
  vi.mocked(api).mockResolvedValue(catalog({ addedDefaultDenies: [], keptExactAllows: [] }));
  const { unmount } = render(<IamPolicyEditor />);
  await screen.findByRole("button", { name: "Admin" });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  unmount();

  vi.mocked(api).mockResolvedValue(catalog());
  render(<IamPolicyEditor />);
  await screen.findByRole("button", { name: "Admin" });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
