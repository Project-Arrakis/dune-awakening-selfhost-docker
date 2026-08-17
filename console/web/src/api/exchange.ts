import { api, post } from "./client";

export type ExchangeOwner = "all" | "player" | "bot";

export type ExchangeItem = {
  template_id: string;
  quality_level: number;
  display_name: string;
  category: string;
  tier: number | null;
  lowest_price: number;
  total_stock: number;
  npc_stock: number;
  listing_count: number;
  icon: string | null;
};

export type ExchangeItemsResponse = {
  rows: ExchangeItem[];
  totalCount: number;
  totalItems: number;
  categories: string[];
  capabilities: { exchange?: boolean } & Record<string, unknown>;
  reason?: string;
};

export type ExchangeListing = {
  order_id: string;
  template_id: string;
  owner_type: "player" | "bot";
  owner_name: string;
  price: number;
  stock: number;
  quality: number;
};

export type ExchangeListingsResponse = {
  rows: ExchangeListing[];
  capabilities: { exchange?: boolean } & Record<string, unknown>;
  reason?: string;
};

export type ExchangeConfig = {
  includeNpcBroker: boolean;
  botOwnerIds: string[];
  blacklistedOwnerIds: string[];
};

export const exchangeApi = {
  items: (params: { q?: string; page?: number; pageSize?: number; sortColumn?: string; sortDirection?: "asc" | "desc"; owner?: ExchangeOwner; category?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.page) search.set("page", String(params.page));
    if (params.pageSize) search.set("pageSize", String(params.pageSize));
    if (params.sortColumn) search.set("sortColumn", params.sortColumn);
    if (params.sortDirection) search.set("sortDirection", params.sortDirection);
    if (params.owner) search.set("owner", params.owner);
    if (params.category) search.set("category", params.category);
    const qs = search.toString();
    return api<ExchangeItemsResponse>(`/api/exchange/items${qs ? `?${qs}` : ""}`);
  },
  listings: (templateId: string, quality?: number | null, owner: ExchangeOwner = "all") => {
    const search = new URLSearchParams();
    search.set("templateId", templateId);
    if (quality !== null && quality !== undefined) search.set("quality", String(quality));
    if (owner) search.set("owner", owner);
    return api<ExchangeListingsResponse>(`/api/exchange/listings?${search.toString()}`);
  },
  stats: () => api<{ totalListings: number; botListings: number; playerListings: number; uniqueItems: number; capabilities: { exchange?: boolean }; reason?: string }>("/api/exchange/stats"),
  getConfig: () => api<ExchangeConfig>("/api/exchange/config"),
  saveConfig: (config: ExchangeConfig) => post<ExchangeConfig>("/api/exchange/config", config)
};
