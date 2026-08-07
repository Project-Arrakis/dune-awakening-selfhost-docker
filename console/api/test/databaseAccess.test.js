import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("PostgreSQL host access stays loopback-only for SSH tunneling", () => {
  const script = readFileSync(new URL("../../../runtime/scripts/start-postgres.sh", import.meta.url), "utf8");
  assert.match(script, /-p\s+"127\.0\.0\.1:\$\{POSTGRES_PORT\}:5432"/);
  assert.doesNotMatch(script, /-p\s+"(?:0\.0\.0\.0|\[?::\]?):\$\{POSTGRES_PORT\}:5432"/);
});
