import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(fileURLToPath(new URL("../src/", import.meta.url)));
const unsafeExceptionFallbacks = [
  /\b(error|err)(?:\?\.|\.)message\s*\|\|\s*\1\b/,
  /\b(error|err)(?:\?\.|\.)message\s*\|\|\s*String\(\1\)/,
  /\bString\((error|err)\)/,
  /\bredact\((error|err)\)/,
];

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return extname(entry.name) === ".js" ? [path] : [];
  });
}

test("API error handling never falls back to a whole caught exception", () => {
  const failures = [];
  for (const path of javascriptFiles(sourceRoot)) {
    const source = readFileSync(path, "utf8");
    for (const pattern of unsafeExceptionFallbacks) {
      if (pattern.test(source)) failures.push(`${path}: ${pattern}`);
    }
  }
  assert.deepEqual(failures, []);
});
