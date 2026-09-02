// Wire format for DISCORD_CONSOLE_ROLE_NAMES (F3, #573): base64url-encoded
// JSON, matching the server's storage format exactly (console/api/src/
// integrations/discord/roleTiers.js's encodeRoleNames/decodeRoleNamesSafe) --
// see that file's own comment for why base64url specifically (a raw JSON
// object literal does not round-trip through this codebase's .env quoting).

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeRoleNamesForWire(map: Record<string, string>): string {
  return base64UrlEncode(JSON.stringify(map));
}

// Fails safe to {} on any malformed input -- mirrors the server's own
// decodeRoleNamesSafe fail-closed-to-empty behavior. A malformed value here
// must degrade the label section to "nothing configured", never crash the
// Settings panel.
export function decodeRoleNamesFromWire(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") clean[key] = value;
    }
    return clean;
  } catch {
    return {};
  }
}
