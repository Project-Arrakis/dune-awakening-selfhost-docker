import { afterEach, describe, expect, it, vi } from "vitest";
import { secretsApi } from "./secrets";
import type { SecretState } from "./secrets";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("secretsApi", () => {
  it("status() calls the /api/secrets/status endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ secrets: [] }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    await secretsApi.status();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/secrets/status");
  });

  it("returns all 4 possible SecretState values without transformation", async () => {
    const allStates: SecretState[] = ["backend-not-configured", "not-migrated", "migrated", "broken"];
    const fixture = allStates.map((state, index) => ({ name: `secret-${index}`, state }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ secrets: fixture }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));

    const result = await secretsApi.status();

    expect(result.secrets).toHaveLength(4);
    expect(result.secrets.map((entry) => entry.state)).toEqual(allStates);
  });
});
