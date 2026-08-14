import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const helper = resolve(repoRoot, "runtime/scripts/generated-file-paths.sh");

function repair(path) {
  return spawnSync("bash", ["-c", 'source "$1"; repair_generated_file_path "$2"', "generated-file-path-test", helper, path], {
    encoding: "utf8",
  });
}

test("generated file repair removes only an empty misplaced directory", () => {
  const root = mkdtempSync(resolve(tmpdir(), "dune-generated-path-"));
  const target = resolve(root, "rabbitmq.conf");
  mkdirSync(target);

  try {
    const result = repair(target);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Repairing empty Docker-created directory/);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated file repair leaves an existing regular file unchanged", () => {
  const root = mkdtempSync(resolve(tmpdir(), "dune-generated-path-"));
  const target = resolve(root, "enabled_plugins");
  writeFileSync(target, "keep this configuration\n");

  try {
    const result = repair(target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(target, "utf8"), "keep this configuration\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated file repair treats shell metacharacters as literal path characters", () => {
  const root = mkdtempSync(resolve(tmpdir(), "dune-generated-path-"));
  const target = resolve(root, "rabbitmq; echo should-not-run");
  mkdirSync(target);

  try {
    const result = repair(target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(target), false);
    assert.doesNotMatch(result.stdout, /^should-not-run$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated file repair preserves and reports a non-empty directory", () => {
  const root = mkdtempSync(resolve(tmpdir(), "dune-generated-path-"));
  const target = resolve(root, "key.pem");
  mkdirSync(target);
  writeFileSync(resolve(target, "unexpected"), "preserve me\n");

  try {
    const result = repair(target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /non-empty directory and was not removed/);
    assert.equal(readFileSync(resolve(target, "unexpected"), "utf8"), "preserve me\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RabbitMQ and Director guard every generated file bind path", () => {
  const rabbitmq = readFileSync(resolve(repoRoot, "runtime/scripts/start-rabbitmq.sh"), "utf8");
  const director = readFileSync(resolve(repoRoot, "runtime/scripts/start-director.sh"), "utf8");

  for (const path of [
    "runtime/rabbitmq-admin/config/rabbitmq.conf",
    "runtime/rabbitmq-admin/config/enabled_plugins",
    "runtime/rabbitmq-game/config/rabbitmq.conf",
    "runtime/rabbitmq-game/config/enabled_plugins",
    "runtime/rabbitmq-game/certs/key.pem",
    "runtime/rabbitmq-game/certs/cert.pem",
    "runtime/rabbitmq-game/certs/cacert.pem",
  ]) {
    assert.ok(rabbitmq.includes(path), `missing generated-file guard for ${path}`);
  }
  assert.match(rabbitmq, /repair_generated_file_path "\$generated_file"/);
  assert.match(director, /repair_generated_file_path runtime\/director\/config\/director_config\.ini/);
  assert.doesNotMatch(director, /rm -rf runtime\/director\/config\/director_config\.ini/);
});
