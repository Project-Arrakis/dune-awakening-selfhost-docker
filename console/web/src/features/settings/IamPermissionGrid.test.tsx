import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IamPermissionGrid } from "./IamPermissionGrid";

// Regression coverage for Layer 2 audit finding C1 (Architect hat): an
// earlier version of iamTypes.ts's `groupActionsByNamespace()` iterated
// `Object.values(actionMap)` (IAM action strings like "server:read")
// instead of `Object.keys(actionMap)` (HTTP-route strings like
// "GET /api/server/status"), which nsFromAction()/humanLabel() both
// require. This silently broke namespace grouping (everything fell into
// "Other") AND the checkbox grid's own `allowed.has(action)` lookup
// (always false, so every checkbox appeared unchecked regardless of
// what was actually granted, and every click only ever appended a
// permission, never removed one). This file did not exist before that
// bug was found and fixed -- per the QA hat's Layer 2 finding that
// IamPermissionGrid.tsx and IamPolicySimulator.tsx had zero test
// coverage, isolated or indirect, despite being two of the most
// functionally significant pieces of this feature.

const ACTION_MAP = {
  "GET /api/server/status": "server:read",
  "POST /api/server/restart": "server:restart",
  "GET /api/players": "players:read",
};

describe("IamPermissionGrid", () => {
  it("groups actions under real namespace labels, not a catch-all 'Other' bucket", () => {
    render(<IamPermissionGrid actionMap={ACTION_MAP} statements={[]} onChange={() => {}} />);
    expect(screen.getByText("Server")).toBeTruthy();
    expect(screen.getByText("Players")).toBeTruthy();
    expect(screen.queryByText("Other")).toBeNull();
  });

  it("checks exactly the boxes covered by a wildcard grant, and none of the others", () => {
    render(<IamPermissionGrid
      actionMap={ACTION_MAP}
      statements={[{ Effect: "Allow", Action: ["server:*"] }]}
      onChange={() => {}}
    />);
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    const checked = checkboxes.filter((c) => c.checked);
    expect(checked.length).toBe(2); // server:read + server:restart, not players:read
  });

  it("clicking a checked box removes exactly that action, without touching unrelated Allow entries", () => {
    const onChange = vi.fn();
    render(<IamPermissionGrid
      actionMap={ACTION_MAP}
      statements={[{ Effect: "Allow", Action: ["server:read", "players:read"] }]}
      onChange={onChange}
    />);
    const checkbox = document.querySelector('[title="GET /api/server/status"]')!.closest("label")!.querySelector("input")!;
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith([{ Effect: "Allow", Action: ["players:read"] }]);
  });

  it("clicking an unchecked box appends the real IAM action string to the existing Allow statement", () => {
    const onChange = vi.fn();
    render(<IamPermissionGrid
      actionMap={ACTION_MAP}
      statements={[{ Effect: "Allow", Action: ["players:read"] }]}
      onChange={onChange}
    />);
    const checkbox = document.querySelector('[title="GET /api/server/status"]')!.closest("label")!.querySelector("input")!;
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith([{ Effect: "Allow", Action: ["players:read", "server:read"] }]);
  });

  it("search filters the visible namespace cards without altering grant state", () => {
    render(<IamPermissionGrid actionMap={ACTION_MAP} statements={[]} onChange={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Search permissions..."), { target: { value: "players" } });
    expect(screen.getByText("Players")).toBeTruthy();
    expect(screen.queryByText("Server")).toBeNull();
  });
});
