import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsApi } from "../../api/maps";
import { cachedInstanceNames, invalidateInstanceNames, resolveInstanceNames } from "./instanceNames";

vi.mock("../../api/maps", () => ({ mapsApi: { sietchDimensions: vi.fn() } }));

const TABLE = [
  "DIMENSION  DISPLAY NAME                     PASSWORD",
  "0          Deep Desert PvP                  (unset)",
  "1          Deep Desert PvE                  (unset)"
].join("\n");

function respond(table = TABLE, ids = "8\n59\n", exitCode = 0) {
  vi.mocked(mapsApi.sietchDimensions).mockImplementation((_map?: string, wantIds?: boolean) =>
    Promise.resolve({ stdout: wantIds ? ids : table, exitCode }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateInstanceNames();
});

describe("instance names", () => {
  it("resolves names keyed by map and partition", async () => {
    respond();
    expect([...(await resolveInstanceNames(["DeepDesert_1"]))!]).toEqual([
      ["DeepDesert_1:8", "Deep Desert PvP"],
      ["DeepDesert_1:59", "Deep Desert PvE"]
    ]);
  });

  it("serves a repeat lookup from cache without touching the CLI", async () => {
    respond();
    await resolveInstanceNames(["DeepDesert_1"]);
    const calls = vi.mocked(mapsApi.sietchDimensions).mock.calls.length;

    expect(cachedInstanceNames(["DeepDesert_1"])?.get("DeepDesert_1:8")).toBe("Deep Desert PvP");
    expect(vi.mocked(mapsApi.sietchDimensions).mock.calls).toHaveLength(calls);
  });

  // The reason this module exists: renaming a sietch changes nothing the Bases
  // panel keys on, so without an explicit signal a remount would keep serving
  // the old label and the operator would have no way to force a refresh.
  it("drops the cache when a sietch is written", async () => {
    respond();
    await resolveInstanceNames(["DeepDesert_1"]);
    expect(cachedInstanceNames(["DeepDesert_1"])).not.toBeNull();

    invalidateInstanceNames();

    expect(cachedInstanceNames(["DeepDesert_1"])).toBeNull();
  });

  it("does not restore a lookup invalidated while its requests are in flight", async () => {
    let resolveTable!: (value: { stdout: string; exitCode: number }) => void;
    let resolveIds!: (value: { stdout: string; exitCode: number }) => void;
    vi.mocked(mapsApi.sietchDimensions).mockImplementation((_map?: string, wantIds?: boolean) =>
      new Promise((resolve) => {
        if (wantIds) resolveIds = resolve;
        else resolveTable = resolve;
      }) as never);

    const pending = resolveInstanceNames(["DeepDesert_1"]);
    invalidateInstanceNames();
    resolveTable({ stdout: TABLE, exitCode: 0 });
    resolveIds({ stdout: "8\n59\n", exitCode: 0 });

    await expect(pending).resolves.toBeNull();
    expect(cachedInstanceNames(["DeepDesert_1"])).toBeNull();
  });

  it("does not answer a lookup for a different set of maps", async () => {
    respond();
    await resolveInstanceNames(["DeepDesert_1"]);

    expect(cachedInstanceNames(["Survival_1"])).toBeNull();
    // Order is not part of the identity.
    expect(cachedInstanceNames(["DeepDesert_1"])).not.toBeNull();
  });

  // A non-zero exit still answers 200 with a body, so trusting stdout alone
  // would publish names read from a failed command.
  it("resolves nothing when the command failed", async () => {
    respond(TABLE, "8\n59\n", 1);
    expect(await resolveInstanceNames(["DeepDesert_1"])).toBeNull();
    expect(cachedInstanceNames(["DeepDesert_1"])).toBeNull();
  });

  it("resolves nothing when the partition ids could not be read", async () => {
    respond(TABLE, "");
    expect(await resolveInstanceNames(["DeepDesert_1"])).toBeNull();
  });
});
