const BRACKETED_UTC = /^(\s*)\[(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})([,.])(\d{1,6})\]/gm;
const ISO_UTC = /^(\s*)(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z(?=\s|$)/gm;

export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
  } catch {
    return "Local";
  }
}

export function convertUtcLogTimestamps(text: string, timeZone = browserTimeZone()) {
  if (!text || !timeZone) return text;
  const convert = (year: string, month: string, day: string, hour: string, minute: string, second: string, fraction = "") => {
    const milliseconds = Number((fraction || "0").slice(0, 3).padEnd(3, "0"));
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds));
    if (!Number.isFinite(date.getTime())
      || date.getUTCFullYear() !== Number(year)
      || date.getUTCMonth() !== Number(month) - 1
      || date.getUTCDate() !== Number(day)
      || date.getUTCHours() !== Number(hour)
      || date.getUTCMinutes() !== Number(minute)
      || date.getUTCSeconds() !== Number(second)) return null;
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short"
      }).formatToParts(date);
      const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
      return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")} ${value("timeZoneName")}`.trim();
    } catch {
      return null;
    }
  };

  return text
    .replace(BRACKETED_UTC, (match, leading, year, month, day, hour, minute, second, separator, fraction) => {
      const local = convert(year, month, day, hour, minute, second, fraction);
      if (!local) return match;
      const [dateAndTime, zone = ""] = local.split(/\s+(?=[^\s]+$)/);
      return `${leading}[${dateAndTime}${separator}${fraction}${zone ? ` ${zone}` : ""}]`;
    })
    .replace(ISO_UTC, (match, leading, year, month, day, hour, minute, second, fraction = "") => {
      const digits = String(fraction).replace(/^\./, "");
      const local = convert(year, month, day, hour, minute, second, digits);
      if (!local) return match;
      const [dateAndTime, zone = ""] = local.split(/\s+(?=[^\s]+$)/);
      return `${leading}${dateAndTime}${fraction}${zone ? ` ${zone}` : ""}`;
    });
}
