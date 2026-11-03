import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerAssetsPage, playerListNotice, visibleRows } from "./PlayerPages";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function stub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    calls.push(path);
    const key = Object.keys(routes).find((k) => path.includes(k));
    return Promise.resolve(new Response(JSON.stringify(key ? routes[key] : {}), { status: key ? 200 : 403, headers: { "content-type": "application/json" } }));
  }));
  return calls;
}

describe("player pages", () => {
  it("shows the link instructions for an unlinked account instead of an empty list", async () => {
    stub({ "/api/bases": { rows: [], notLinked: true, reason: "Not linked.", linkInstructions: { message: "Run /dune player link <name>." } } });
    render(<PlayerAssetsPage kind="bases" />);
    expect(await screen.findByText("Run /dune player link <name>.")).toBeInTheDocument();
    expect(screen.queryByText(/don't own any/)).not.toBeInTheDocument();
  });
  it("says so when the player owns nothing", async () => {
    stub({ "/api/vehicles": { rows: [] } });
    render(<PlayerAssetsPage kind="vehicles" />);
    expect(await screen.findByText("You don't own any vehicles yet.")).toBeInTheDocument();
  });
  it("never shows a shared_with column", () => {
    expect(visibleRows([{ id: 1, shared_with: [{ name: "X" }] }])).toEqual([{ id: 1 }]);
    expect(playerListNotice(null)).toBe("");
  });
  it("reports a failed load as unavailable, not as empty", async () => {
    stub({});
    render(<PlayerAssetsPage kind="storage" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
  });
});
