const FIEF_CLAIM_PLACEABLE_TYPES = new Set([
  "totem_small_placeable",
  "totem_placeable"
]);

export function isFiefClaimPlaceable(buildingType) {
  return FIEF_CLAIM_PLACEABLE_TYPES.has(String(buildingType || "").trim().toLowerCase());
}

export function partitionFiefClaimPlaceables(placeables) {
  const safe = [];
  const removed = [];
  for (const placeable of Array.isArray(placeables) ? placeables : []) {
    if (isFiefClaimPlaceable(placeable?.building_type)) removed.push(placeable);
    else safe.push(placeable);
  }
  return { safe, removed };
}
