const patterns = [
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
  /runtime\/secrets\/funcom-token\.txt/g
];

function isSensitiveName(name) {
  const lower = name.toLowerCase();
  return lower.endsWith("token")
    || lower.endsWith("secret")
    || lower.endsWith("passwd")
    || lower.endsWith("password")
    || lower.endsWith("apikey")
    || lower.endsWith("api_key")
    || lower.endsWith("api-key");
}

function isAsciiLetter(char) {
  const code = char?.charCodeAt(0) ?? -1;
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(char) {
  const code = char?.charCodeAt(0) ?? -1;
  return code >= 48 && code <= 57;
}

function isAssignedNameCharacter(char) {
  return isAsciiLetter(char) || isAsciiDigit(char) || char === "_" || char === "-";
}

function isAssignmentSeparator(char) {
  return char === "\"" || char === ":" || char === "=" || char === " ";
}

function isWhitespace(char) {
  return Boolean(char) && char.trim() === "";
}

function isAssignedValueCharacter(char) {
  return Boolean(char) && char !== "," && char !== "\"" && char !== "'" && !isWhitespace(char);
}

function isSchemeCharacter(char) {
  return isAsciiLetter(char) || isAsciiDigit(char) || char === "+" || char === "." || char === "-";
}

function redactAssignedSecrets(value) {
  const pieces = [];
  let copyFrom = 0;
  let cursor = 0;

  while (cursor < value.length) {
    if (!isAssignedNameCharacter(value[cursor])) {
      cursor += 1;
      continue;
    }

    const nameStart = cursor;
    while (cursor < value.length && isAssignedNameCharacter(value[cursor])) cursor += 1;
    const separatorStart = cursor;
    if (!isSensitiveName(value.slice(nameStart, separatorStart))) continue;

    while (cursor < value.length && isAssignmentSeparator(value[cursor])) cursor += 1;
    if (cursor === separatorStart) continue;

    const valueStart = cursor;
    while (cursor < value.length && isAssignedValueCharacter(value[cursor])) cursor += 1;
    if (cursor === valueStart) continue;

    pieces.push(value.slice(copyFrom, valueStart), "<redacted>");
    copyFrom = cursor;
  }

  if (copyFrom === 0) return value;
  pieces.push(value.slice(copyFrom));
  return pieces.join("");
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
    if (!isAsciiLetter(value[schemeStart])) {
      searchFrom = marker + 3;
      continue;
    }

    const authorityStart = marker + 3;
    let separator = -1;
    let authorityEnd = authorityStart;
    for (; authorityEnd < value.length; authorityEnd += 1) {
      const char = value[authorityEnd];
      if (char === "@") break;
      if (char === "/" || isWhitespace(char)) break;
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
  output = redactAssignedSecrets(output);
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
