const patterns = [
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
  /(ServiceAuthToken[":= ]+)[^,"'\s]+/gi,
  /(GameRmqSecret[":= ]+)[^,"'\s]+/gi,
  /(RMQ_HTTP_TOKEN_AUTH_SECRET=)[^"'\s]+/g,
  /(funcom[-_ ]?token[":= ]+)[^,"'\s]+/gi,
  /(password[":= ]+)[^,"'\s]+/gi,
  /runtime\/secrets\/funcom-token\.txt/g
];

const assignedValuePattern = /([A-Za-z0-9_-]+)([":= ]+)([^,"'\s]+)/g;

function isSensitiveName(name) {
  const lower = name.toLowerCase();
  return lower.endsWith("token")
    || lower.endsWith("secret")
    || lower.endsWith("passwd")
    || lower.endsWith("apikey")
    || lower.endsWith("api_key")
    || lower.endsWith("api-key");
}

function isSchemeCharacter(char) {
  return /[A-Za-z0-9+.-]/.test(char);
}

function redactUriCredentials(value) {
  const pieces = [];
  let copyFrom = 0;
  let searchFrom = 0;

  while (searchFrom < value.length) {
    const marker = value.indexOf("://", searchFrom);
    if (marker < 0) break;

    let schemeStart = marker;
    while (schemeStart > 0 && isSchemeCharacter(value[schemeStart - 1])) schemeStart -= 1;
    if (!/[A-Za-z]/.test(value[schemeStart] || "")) {
      searchFrom = marker + 3;
      continue;
    }

    const authorityStart = marker + 3;
    let separator = -1;
    let authorityEnd = authorityStart;
    for (; authorityEnd < value.length; authorityEnd += 1) {
      const char = value[authorityEnd];
      if (char === "@") break;
      if (char === "/" || /\s/.test(char)) break;
      if (char === ":" && separator < 0) separator = authorityEnd;
    }

    if (value[authorityEnd] === "@" && separator > authorityStart) {
      pieces.push(value.slice(copyFrom, authorityStart), "<redacted>");
      copyFrom = authorityEnd;
      searchFrom = authorityEnd + 1;
    } else {
      searchFrom = marker + 3;
    }
  }

  if (copyFrom === 0) return value;
  pieces.push(value.slice(copyFrom));
  return pieces.join("");
}

export function redact(value) {
  let output = redactUriCredentials(String(value ?? ""));
  output = output.replace(assignedValuePattern, (match, name, separator) => (
    isSensitiveName(name) ? `${name}${separator}<redacted>` : match
  ));
  for (const pattern of patterns) {
    output = output.replace(pattern, (match, prefix) => {
      if (typeof prefix === "string") return `${prefix}<redacted>`;
      return "<redacted>";
    });
  }
  return output;
}

export function redactLines(lines) {
  return lines.map((line) => redact(line));
}

export function redactValue(value) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /password|token|secret|credential/i.test(key) ? "<redacted>" : redactValue(item)
    ]));
  }
  if (typeof value === "string") return redact(value);
  return value;
}
