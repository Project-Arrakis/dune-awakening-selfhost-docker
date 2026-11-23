import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Route inventory mined from server.js (shared by the static and HTTP authorization matrices).
const serverSource = readFileSync(fileURLToPath(new URL("../src/server.js", import.meta.url)), "utf8");
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function sampleFromRegexSource(src) {
  let s = src.replace(/^\^/, "").replace(/\$$/, "");
  s = s.replace(/\(\?:[^)]*\)\??/g, "").replace(/\[\^\/\]\+/g, "abc123").replace(/\[\^\/\]\*/g, "abc123")
    .replace(/\\\//g, "/").replace(/\\\./g, ".").replace(/\\d\+/g, "1").replace(/\\-/g, "-");
  if (/[\\()[\]|?+*^$]/.test(s)) return null;
  return s;
}

export const matchers = []; // { methods, test(path), sample } -- what the handler chain would actually accept

function mineRoutes() {
  const found = new Map(); // key "METHOD path" -> true
  const add = (path, methods) => { for (const m of methods) found.set(`${m} ${path}`, true); };
  for (const line of serverSource.split("\n")) {
    if (!line.includes("/api/")) continue;
    const declared = [...line.matchAll(/req\.method === "([A-Z]+)"/g)].map((m) => m[1]);
    // Negative guards on the same condition ("... && !path.startsWith(x) && path !== y") narrow what the handler accepts.
    const negs = [
      ...[...line.matchAll(/!path\.startsWith\("([^"]*)"\)/g)].map((m) => (p) => p.startsWith(m[1])),
      ...[...line.matchAll(/path !== "([^"]*)"/g)].map((m) => (p) => p === m[1])
    ];
    const allowed = (t) => (p) => t(p) && !negs.some((n) => n(p));
    const methods = declared.length ? declared : ["GET"]; // no verb on the line: a method-agnostic dispatch is covered by the prefix review below
    for (const m of line.matchAll(/path === "(\/api\/[^"]*)"/g)) { add(m[1], methods); matchers.push({ methods, sample: m[1], test: allowed((p) => p === m[1]) }); }
    for (const m of line.matchAll(/path\.startsWith\("(\/api\/[^"]*)"\)/g)) { add(`${m[1]}abc123`, methods); matchers.push({ methods, sample: `${m[1]}abc123`, test: allowed((p) => p.startsWith(m[1])) }); }
    for (const m of line.matchAll(/path\.match\(\/(\^\\\/api\\\/.*?)\/[a-z]*\)/g)) {
      const sample = sampleFromRegexSource(m[1]);
      if (sample?.startsWith("/api/")) add(sample, methods);
      if (sample?.startsWith("/api/")) { const re = new RegExp(m[1]); matchers.push({ methods, sample, test: allowed((p) => re.test(p)) }); }
    }
  }
  return [...found.keys()].map((k) => { const i = k.indexOf(" "); return { method: k.slice(0, i), path: k.slice(i + 1) }; });
}


export const routes = mineRoutes();
