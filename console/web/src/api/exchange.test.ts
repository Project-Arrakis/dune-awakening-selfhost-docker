import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, post } from "./client";
import { exchangeApi } from "./exchange";

vi.mock("./client", () => ({ api: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exchangeApi", () => {
  it("builds the items query string from the standard params + owner", () => {
    exchangeApi.items({ q: "belt", page: 2, pageSize: 100, sortColumn: "lowest_price", sortDirection: "desc", owner: "bot", category: "weapons" });
    const url = vi.mocked(api).mock.calls[0][0];
    expect(url).toContain("/api/exchange/items?");
    expect(url).toContain("q=belt");
    expect(url).toContain("page=2");
    expect(url).toContain("pageSize=100");
    expect(url).toContain("sortColumn=lowest_price");
    expect(url).toContain("sortDirection=desc");
    expect(url).toContain("owner=bot");
    expect(url).toContain("category=weapons");
  });

  it("omits empty params from the items query", () => {
    exchangeApi.items({});
    expect(vi.mocked(api).mock.calls[0][0]).toBe("/api/exchange/items");
  });

  it("builds the listings query with templateId, quality, and owner", () => {
    exchangeApi.listings("PartialStabilizationBelt", 0, "all");
    const url = vi.mocked(api).mock.calls[0][0];
    expect(url).toContain("templateId=PartialStabilizationBelt");
    expect(url).toContain("quality=0");
    expect(url).toContain("owner=all");
  });

  it("saves config via POST", () => {
    exchangeApi.saveConfig({ includeNpcBroker: true, botOwnerIds: ["75"], blacklistedOwnerIds: [] });
    expect(vi.mocked(post)).toHaveBeenCalledWith("/api/exchange/config", { includeNpcBroker: true, botOwnerIds: ["75"], blacklistedOwnerIds: [] });
  });
});
