import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const script = resolve(repoRoot, "runtime/scripts/usersettings.py");

function runUsersettings(args, env) {
  return spawnSync("python3", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

test("usersettings keeps password-bearing files private and metadata secret-free", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-usersettings-security-"));
  const generated = join(root, "generated");
  const gameRoot = join(root, "game");
  const saved = join(gameRoot, "survival-1", "Saved");
  const config = join(generated, "usersettings.json");
  const profile = join(generated, "gameplay-profile.ini");
  const sietchConfig = join(generated, "sietch-config.json");
  const env = {
    DUNE_USERSETTINGS_CONFIG: config,
    DUNE_GAMEPLAY_PROFILE: profile,
    DUNE_USERSETTINGS_GAME_ROOT: gameRoot,
    DUNE_SIETCH_CONFIG: sietchConfig,
    DUNE_LANDSRAAD_RESTART_MARKER: join(generated, "landsraad-restart-required")
  };

  mkdirSync(saved, { recursive: true });
  mkdirSync(generated, { recursive: true });
  writeFileSync(config, '{"engine":{},"maps":{},"partitions":{}}\n', { mode: 0o644 });
  chmodSync(config, 0o644);
  writeFileSync(sietchConfig, '{"partitions":[{"password":"legacy-secret"}]}\n', { mode: 0o644 });
  chmodSync(sietchConfig, 0o644);

  try {
    const save = runUsersettings(["partition-engine-set", "Survival_1", "1", "server_login_password", "private-test-password"], env);
    assert.equal(save.status, 0, save.stderr);
    const materialize = runUsersettings(["materialize", "Survival_1", saved, "1"], env);
    assert.equal(materialize.status, 0, materialize.stderr);

    const engine = join(saved, "UserSettings", "UserEngine.ini");
    const game = join(saved, "UserSettings", "UserGame.ini");
    assert.match(readFileSync(engine, "utf8"), /Bgd\.ServerLoginPassword="private-test-password"/);
    for (const path of [config, profile, sietchConfig, engine, game]) {
      assert.equal(mode(path), 0o600, `${path} should be readable only by its owner`);
    }

    const metadata = runUsersettings(["metadata"], env);
    assert.equal(metadata.status, 0, metadata.stderr);
    assert.doesNotMatch(metadata.stdout, /server_login_password|Bgd\.ServerLoginPassword|private-test-password|legacy-secret/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gameplay settings preflight refuses to invent defaults when no persisted source exists", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-usersettings-preflight-"));
  const generated = join(root, "generated");
  mkdirSync(generated, { recursive: true });
  const result = runUsersettings(["preflight"], {
    DUNE_USERSETTINGS_CONFIG: join(generated, "usersettings.json"),
    DUNE_GAMEPLAY_PROFILE: join(generated, "gameplay-profile.ini"),
    DUNE_USERSETTINGS_GAME_ROOT: join(root, "game"),
    DUNE_SIETCH_CONFIG: join(generated, "sietch-config.json")
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No persisted gameplay settings source was found/);
  rmSync(root, { recursive: true, force: true });
});
