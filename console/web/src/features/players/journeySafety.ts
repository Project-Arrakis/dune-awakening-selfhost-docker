export function journeyActionsAvailable(category: string) {
  return ["Story", "Contract", "Codex", "Tutorial"].includes(category);
}
