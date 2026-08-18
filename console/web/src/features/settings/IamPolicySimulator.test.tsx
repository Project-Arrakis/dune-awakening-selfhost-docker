import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IamPolicySimulator } from "./IamPolicySimulator";

// Per the Layer 2 audit (QA hat): IamPolicySimulator.tsx -- the fix for
// the previously non-functional "Test" tab, and the new AWS-style
// two-mode simulator this design adds -- had zero test coverage,
// isolated or indirect, despite being one of the most functionally
// significant net-new pieces of this feature.

const apiMock = vi.fn();
vi.mock("../../api/client", () => ({
  api: (...args: unknown[]) => apiMock(...args)
}));

beforeEach(() => {
  apiMock.mockReset();
});

describe("IamPolicySimulator", () => {
  it("draft mode sends {mode:'draft', statements} and renders the real results", async () => {
    apiMock.mockResolvedValue({ results: { "server:read": true, "settings:write": false } });
    render(<IamPolicySimulator mode="draft" draftStatements={[{ Effect: "Allow", Action: ["server:read"] }]} />);

    fireEvent.click(screen.getByText("Run test"));

    await waitFor(() => expect(screen.getByText("1 allowed")).toBeTruthy());
    expect(screen.getByText("1 denied")).toBeTruthy();
    expect(screen.getByText("server:read")).toBeTruthy();
    expect(screen.getByText("settings:write")).toBeTruthy();

    const [path, options] = apiMock.mock.calls[0];
    expect(path).toBe("/api/settings/iam/policy/test");
    expect(JSON.parse((options as RequestInit).body as string)).toEqual({
      mode: "draft",
      statements: [{ Effect: "Allow", Action: ["server:read"] }]
    });
  });

  it("tier mode sends {mode:'tier', tier} -- the new AWS-style real-aggregate capability, not the old broken {action,tier} contract", async () => {
    apiMock.mockResolvedValue({ results: { "server:read": true } });
    render(<IamPolicySimulator mode="tier" tier="moderator" />);

    fireEvent.click(screen.getByText("Run test"));

    await waitFor(() => expect(screen.getByText("1 allowed")).toBeTruthy());
    const [, options] = apiMock.mock.calls[0];
    expect(JSON.parse((options as RequestInit).body as string)).toEqual({ mode: "tier", tier: "moderator" });
  });

  it("surfaces the real backend error message when the simulator call fails", async () => {
    apiMock.mockRejectedValue(new Error("No such tier."));
    render(<IamPolicySimulator mode="tier" tier="ghost-tier" />);

    fireEvent.click(screen.getByText("Run test"));

    await waitFor(() => expect(screen.getByText("No such tier.")).toBeTruthy());
  });

  it("allows re-running the test after results are shown", async () => {
    apiMock.mockResolvedValue({ results: { "server:read": true } });
    render(<IamPolicySimulator mode="draft" draftStatements={[]} />);

    fireEvent.click(screen.getByText("Run test"));
    await waitFor(() => expect(screen.getByText("Re-run test")).toBeTruthy());

    fireEvent.click(screen.getByText("Re-run test"));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
  });
});
