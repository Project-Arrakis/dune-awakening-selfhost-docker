// Access filter for a player's Bases/Vehicles lists. Anything unrecognised
// (including a missing parameter, i.e. every older client) means "all".
export function playerAccessParam(url) {
  const value = url.searchParams.get("access");
  return value === "owner" || value === "coowner" ? value : "all";
}
