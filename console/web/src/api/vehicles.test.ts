import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { vehiclesApi } from "./vehicles";

vi.mock("./client", () => ({ api: vi.fn() }));

describe("vehiclesApi.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests the bare endpoint when no params are given", () => {
    vehiclesApi.list();
    expect(api).toHaveBeenCalledWith("/api/vehicles");
  });

  it("serializes every provided param into the query string in order", () => {
    vehiclesApi.list({ q: "worm", page: 2, pageSize: 100, sortColumn: "owner", sortDirection: "desc" });
    expect(api).toHaveBeenCalledWith("/api/vehicles?q=worm&page=2&pageSize=100&sortColumn=owner&sortDirection=desc");
  });

  it("omits an empty search term and a falsy page (0)", () => {
    vehiclesApi.list({ q: "", page: 0, pageSize: 50 });
    expect(api).toHaveBeenCalledWith("/api/vehicles?pageSize=50");
  });

  it("URL-encodes special characters in the search term", () => {
    vehiclesApi.list({ q: "a&b c" });
    expect(api).toHaveBeenCalledWith("/api/vehicles?q=a%26b+c");
  });
});
