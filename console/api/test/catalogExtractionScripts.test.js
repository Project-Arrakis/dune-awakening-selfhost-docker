import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function source(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

for (const [name, path, output] of [
  ["partition", "runtime/scripts/extract-partition-catalog.sh", "partition-catalog.json"],
  ["server", "runtime/scripts/extract-server-catalog.sh", "server-catalog.json"],
]) {
  test(`${name} catalog extraction streams to an atomic host file`, () => {
    const script = source(path);

    assert.match(script, new RegExp(`catalog_output="runtime/generated/${output.replace(".", "\\.")}"`));
    assert.match(script, /catalog_tmp="\$\(mktemp "\$\{catalog_output\}\.tmp\.XXXXXX"\)"/);
    assert.match(script, /trap cleanup_catalog_tmp EXIT/);
    assert.match(script, /docker compose exec -T orchestrator python3 - > "\$catalog_tmp"/);
    assert.match(script, /json\.dump\([^\n]+, sys\.stdout, indent=2\)/);
    assert.match(script, /file=sys\.stderr/);
    assert.match(script, /mv -f -- "\$catalog_tmp" "\$catalog_output"/);
    assert.doesNotMatch(script, /docker compose exec -T orchestrator cat/);
    assert.doesNotMatch(script, /Path\("\/work\//);
  });
}
