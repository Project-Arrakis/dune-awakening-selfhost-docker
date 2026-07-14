import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const helperScripts = new Map([
  ["runtime/scripts/restart-schedule.sh", 3],
  ["runtime/scripts/ip-change-restart.sh", 3],
  ["runtime/scripts/shutdown-protection.sh", 4],
  ["runtime/scripts/db.sh", 3],
  ["runtime/scripts/update.sh", 3]
]);

test("host systemd helpers explicitly run as root", () => {
  for (const [relativePath, expectedHelpers] of helperScripts) {
    const source = readFileSync(resolve(repoRoot, relativePath), "utf8");
    const helpers = source
      .split("\n")
      .filter((line) => line.includes("docker run --rm") && line.includes("--privileged"));

    assert.equal(helpers.length, expectedHelpers, `${relativePath} helper count changed`);
    for (const helper of helpers) {
      assert.match(helper, /docker run --rm --user 0:0 --privileged/,
        `${relativePath} must run its host systemd helper as root`);
    }
  }
});

test("shell self-update helper uses host ownership and Docker socket group", () => {
  const source = readFileSync(resolve(repoRoot, "runtime/scripts/self-update.sh"), "utf8");

  assert.match(source, /--user "\$\{DUNE_HOST_UID:-0\}:\$\{DUNE_HOST_GID:-0\}"/);
  assert.match(source, /--group-add "\$\{DOCKER_SOCKET_GID:-0\}"/);
  assert.match(source, /-e "DUNE_HOST_UID=\$\{DUNE_HOST_UID:-0\}"/);
  assert.match(source, /-e "DUNE_HOST_GID=\$\{DUNE_HOST_GID:-0\}"/);
});
