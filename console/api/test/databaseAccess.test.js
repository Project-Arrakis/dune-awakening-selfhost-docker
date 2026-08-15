import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("PostgreSQL host access stays loopback-only for SSH tunneling", () => {
  const script = readFileSync(new URL("../../../runtime/scripts/start-postgres.sh", import.meta.url), "utf8");
  assert.match(script, /-p\s+"127\.0\.0\.1:\$\{POSTGRES_PORT\}:5432"/);
  assert.doesNotMatch(script, /-p\s+"(?:0\.0\.0\.0|\[?::\]?):\$\{POSTGRES_PORT\}:5432"/);
});

test("all world server launchers use the configured database password", () => {
  const launchers = [
    "spawn-server.sh",
    "start-server-survival-1.sh",
    "start-server-overmap.sh"
  ];

  for (const launcher of launchers) {
    const script = readFileSync(new URL(`../../../runtime/scripts/${launcher}`, import.meta.url), "utf8");
    assert.match(script, /DUNE_DB_PASSWORD="\$\{DUNE_DB_PASSWORD:-dune\}"/,
      `${launcher} must resolve the configured password with the compatible default`);
    assert.match(script, /"-DatabasePassword=\$DUNE_DB_PASSWORD"/,
      `${launcher} must pass the configured password as one quoted argument`);
    assert.doesNotMatch(script, /(?:^|\s)-DatabasePassword=dune(?:\s|$)/m,
      `${launcher} must not hardcode the default password`);
  }
});
