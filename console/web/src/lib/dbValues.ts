export function serializeEditableDbValue(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function parseEditableDbValue(value: string, original: unknown) {
  const text = String(value);
  if (/^NULL$/i.test(text.trim())) return null;
  if (typeof original === "object" && original !== null) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}
