/** Formats raw Exchange text as a human-facing label without changing IDs. */
export function exchangeDisplayLabel(value: unknown, humanizeSeparators = false) {
  const text = String(value ?? "").trim();
  const label = humanizeSeparators ? text.replace(/[_-]+/g, " ") : text;
  return label.replace(/(^|[\s-])(\p{L})/gu, (_match, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase()}`);
}
