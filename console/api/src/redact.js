const patterns = [
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
  /(ServiceAuthToken[":= ]+)[^,"'\s]+/gi,
  /(GameRmqSecret[":= ]+)[^,"'\s]+/gi,
  /(RMQ_HTTP_TOKEN_AUTH_SECRET=)[^"'\s]+/g,
  /(funcom[-_ ]?token[":= ]+)[^,"'\s]+/gi,
  /(password[":= ]+)[^,"'\s]+/gi,
  /runtime\/secrets\/funcom-token\.txt/g
];

export function redact(value) {
  let output = String(value ?? "");
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
