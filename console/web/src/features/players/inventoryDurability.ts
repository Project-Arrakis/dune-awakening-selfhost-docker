export function inventoryDurabilityError(
  currentValue: unknown,
  storedMaxValue: unknown,
  hasCurrent: boolean
) {
  if (!hasCurrent) return "";

  if (storedMaxValue === null || storedMaxValue === undefined || storedMaxValue === "") {
    return "This item's stored maximum durability is invalid and cannot be edited safely.";
  }
  const currentDurability = Number(currentValue);
  const storedMaxDurability = Number(storedMaxValue);
  if (!Number.isFinite(storedMaxDurability) || storedMaxDurability < 0) {
    return "This item's stored maximum durability is invalid and cannot be edited safely.";
  }
  if (!Number.isFinite(currentDurability) || currentDurability < 0 || currentDurability > storedMaxDurability) {
    return "Current Durability must be a number between 0 and the item's stored Max Durability.";
  }
  return "";
}
