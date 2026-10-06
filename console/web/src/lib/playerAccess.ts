// The Access filter on a player's Bases and Vehicles tabs. Both tabs and both
// list endpoints share this one definition so the options, the server query
// value and the wording cannot drift apart.
export type PlayerAccessFilter = "owner" | "coowner" | "all";

export const PLAYER_ACCESS_DEFAULT: PlayerAccessFilter = "owner";

export const PLAYER_ACCESS_OPTIONS: { value: PlayerAccessFilter; label: string }[] = [
  { value: "owner", label: "Owned" },
  { value: "coowner", label: "Co-owner" },
  { value: "all", label: "All (owner, co-owner, associate)" }
];

// The relationship label the API puts on a row for each narrowed level; "all"
// has none, meaning no narrowing. Used to re-check rows client-side so an older
// API that ignores the `access` parameter still shows the right list.
export function accessRelationship(access: PlayerAccessFilter) {
  return access === "owner" ? "Owner" : access === "coowner" ? "Co-Owner" : "";
}

export function filterRowsByAccess<T extends object>(rows: T[], access: PlayerAccessFilter) {
  const wanted = accessRelationship(access);
  return wanted ? rows.filter((row) => (row as { relationship?: unknown }).relationship === wanted) : rows;
}

// Query-string fragment for the list endpoints; empty for "all" (the default).
export function accessQuery(access?: PlayerAccessFilter) {
  return access && access !== "all" ? `access=${access}` : "";
}

// "Vehicles owned by Kovalt." / "...co-owns." / "...owner, co-owner or associate access...".
export function describePlayerAccess(noun: "Bases" | "Vehicles", playerName: string, access: PlayerAccessFilter) {
  if (access === "owner") return `${noun} owned by ${playerName}.`;
  if (access === "coowner") return `${noun} ${playerName} co-owns.`;
  return `${noun} ${playerName} owns or has owner, co-owner or associate access to (guild and public access are not listed).`;
}

// Count label for the summary strip ("3 Owned" / "2 Co-owned" / "5 Total").
export function accessCountLabel(access: PlayerAccessFilter) {
  return access === "owner" ? "Owned" : access === "coowner" ? "Co-owned" : "Total";
}

// Adjective for empty states: "has no owned vehicles".
export function accessEmptyAdjective(access: PlayerAccessFilter) {
  return access === "owner" ? "owned " : access === "coowner" ? "co-owned " : "";
}
