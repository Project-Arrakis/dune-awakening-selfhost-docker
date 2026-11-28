// Storage give-item over real HTTP against real PostgreSQL: the shipped route,
// the shipped catalog loaders and the shipped data files. The server is spawned
// the way baseContainerMutationRoutes.integration.test.js does it, because
// server.js is an entrypoint and cannot be imported.
//
// The throwaway repo root holds a copy of runtime/data and is also the server's
// working directory, as in the container, so a test can change a data file and
// both loaders (adminCatalog.js and duneDb.js) read it from there.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pgConnectionConfig, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(API_ROOT, "../..");

const SCHEMA = `
  create schema dune;
  create table dune.inventories (
    id bigint primary key,
    actor_id bigint not null,
    max_item_count integer not null,
    max_item_volume real not null default 0
  );
  create table dune.items (
    id bigint generated always as identity primary key,
    inventory_id bigint not null references dune.inventories(id),
    template_id text not null,
    stack_size integer not null,
    quality_level integer not null,
    position_index integer not null,
    stats jsonb not null,
    volume_override real
  );
`;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createTcpServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
    probe.on("error", reject);
  });
}

function pgEnv(database) {
  const cfg = pgConnectionConfig(database);
  if (cfg.connectionString) return { ADMIN_DATABASE_URL: cfg.connectionString };
  return {
    DUNE_DB_HOST: cfg.host,
    DUNE_DB_PORT: String(cfg.port),
    DUNE_DB_NAME: database,
    DUNE_DB_USER: cfg.user,
    DUNE_DB_PASSWORD: cfg.password
  };
}

async function startServer(repoRoot, database) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(API_ROOT, "src/server.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: repoRoot,
      ADMIN_AUTH_DISABLED: "1",
      ADMIN_BIND_HOST: "127.0.0.1",
      ADMIN_BIND_PORT: String(port),
      ADMIN_STATIC_DIR: join(repoRoot, "console/web/dist"),
      ...pgEnv(database)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(force);
  };
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, stop };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await stop();
  throw new Error(`API did not start listening.\n${output}`);
}

async function withConsole(t, fn) {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_storage_give_http",
    unavailableLabel: "the storage give-item HTTP integration test",
    createFailLabel: "the storage give-item HTTP integration test"
  }, async (pool, database) => {
    await pool.query(SCHEMA);
    const repoRoot = mkdtempSync(join(tmpdir(), "dune-storage-give-http-"));
    let server;
    try {
      mkdirSync(join(repoRoot, "console/web/dist"), { recursive: true });
      cpSync(join(REPO_ROOT, "runtime/data"), join(repoRoot, "runtime/data"), { recursive: true });
      writeFileSync(join(repoRoot, "VERSION"), "test\n");
      server = await startServer(repoRoot, database);

      let nextStorage = 700;
      const box = async ({ slots = 10, volume = 0, rows = [] } = {}) => {
        const id = ++nextStorage;
        await pool.query("insert into dune.inventories values ($1, $1, $2, $3)", [id, slots, volume]);
        // Rows as the game writes them: no volume_override.
        for (const [position, [templateId, stackSize]] of rows.entries()) {
          await pool.query(
            "insert into dune.items (inventory_id, template_id, stack_size, quality_level, position_index, stats) values ($1, $2, $3, 0, $4, '{}'::jsonb)",
            [id, templateId, stackSize, position]);
        }
        return id;
      };
      const give = async (storageId, body) => {
        const response = await fetch(`${server.base}/api/storage/${storageId}/give-item`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "GIVE ITEM TO STORAGE", ...body })
        });
        const json = await response.json();
        assert.equal(response.status, 200, JSON.stringify(json));
        return json.result;
      };
      // The rows a give wrote, oldest first.
      const written = async (storageId) => (await pool.query(
        "select template_id, stack_size, volume_override, stats from dune.items where inventory_id = $1 and stats <> '{}'::jsonb order by id",
        [storageId])).rows;
      const catalogRow = async (itemId) => {
        const response = await fetch(`${server.base}/api/admin/items/catalog?q=${encodeURIComponent(itemId)}&limit=50`);
        assert.equal(response.status, 200);
        return (await response.json()).rows.find((row) => row.itemId === itemId);
      };

      await fn({ repoRoot, box, give, written, catalogRow });
    } finally {
      await server?.stop();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
}

const stacksOf = (rows) => rows.map((row) => row.stack_size);
const overridesOf = (rows) => rows.map((row) => row.volume_override);

test("Storage give holds an item the catalog does not list to its game volume", async (t) => {
  await withConsole(t, async ({ box, give, written }) => {
    // Volume 10 each.
    const storage = await box({ volume: 25 });
    const result = await give(storage, { itemId: "D_AccessCard_Vehicle_Atre", quantity: 3 });
    assert.equal(result.given, 2);
    assert.equal(result.clamped, true);
    assert.deepEqual(overridesOf(await written(storage)), [null, null]);
  });
});

test("Storage give resolves an id typed in another case the way the volume totals do", async (t) => {
  await withConsole(t, async ({ box, give, written }) => {
    // Game volume 2 each.
    const gear = await box({ volume: 5 });
    assert.equal((await give(gear, { itemId: "combat_light_unique_benegeserit_top", quantity: 3 })).given, 2);
    assert.deepEqual(overridesOf(await written(gear)), [null, null]);

    // Curated: volume 1 and one per slot. The game data says 0.1 and 500.
    const corpses = await box({ volume: 5 });
    assert.equal((await give(corpses, { itemId: "t2muaddibcomponent", quantity: 10 })).given, 5);
    const rows = await written(corpses);
    assert.deepEqual(stacksOf(rows), [1, 1, 1, 1, 1]);
    assert.deepEqual(overridesOf(rows), [null, null, null, null, null]);
  });
});

test("Storage give stores a curated volume and no volume taken from the game data", async (t) => {
  await withConsole(t, async ({ box, give, written }) => {
    const storage = await box({ volume: 100 });
    // Curated at 0.2.
    await give(storage, { itemId: "AzuriteOre", quantity: 3 });
    // Volume from the game data only. The route takes no volume from the request.
    await give(storage, { itemId: "Combat_Light_Unique_BeneGeserit_Top", quantity: 1, itemVolume: 999 });
    // A cosmetic token takes no volume and gets no clothing stats.
    await give(storage, { itemId: "LeakingStillsuit_T1_SetVariant", quantity: 1 });

    const rows = await written(storage);
    assert.equal(rows.length, 3);
    assert.equal(Math.fround(Number(rows[0].volume_override)), Math.fround(0.2));
    assert.deepEqual(overridesOf(rows.slice(1)), [null, null]);
    assert.ok(rows[1].stats.FCustomizationStats, "clothing keeps its gear stats");
    assert.equal(rows[2].stats.FCustomizationStats, undefined);
  });
});

test("Storage give writes gear one per slot within the volume limit and leaves the box usable", async (t) => {
  await withConsole(t, async ({ box, give, written }) => {
    // Volume 2 each: only two of the three fit a box of volume 5.
    const storage = await box({ volume: 5 });
    const gear = await give(storage, { itemId: "Combat_Light_Unique_BeneGeserit_Top", quantity: 3 });
    assert.equal(gear.given, 2);
    assert.equal(gear.clamped, true);
    // A resource still fits what is left: the gear counts as known volume.
    assert.equal((await give(storage, { itemId: "AzuriteOre", quantity: 3 })).given, 3);
    assert.deepEqual(stacksOf(await written(storage)), [1, 1, 3]);
  });
});

test("Storage give counts what the game put in the box, curated values first", async (t) => {
  await withConsole(t, async ({ box, give }) => {
    // Not in the catalog; game volume 1 each, so 3 of 5 are used: ten ore at 0.2 fit.
    const uncatalogued = await box({ volume: 5, rows: [["D_ArmorPack_Med_T1_Atre", 3]] });
    assert.equal((await give(uncatalogued, { itemId: "AzuriteOre", quantity: 100 })).given, 10);
    // Curated at 1 each (game data: 0.1), so 4 of 5 are used: five ore fit.
    const curated = await box({ volume: 5, rows: [["T2MuaddibComponent", 4]] });
    assert.equal((await give(curated, { itemId: "AzuriteOre", quantity: 100 })).given, 5);
  });
});

test("Storage give splits by the game's stack limit unless the catalog curates one", async (t) => {
  await withConsole(t, async ({ box, give, written }) => {
    const packs = await box();
    await give(packs, { itemId: "D_AmmoPack_Dart_Heavy", quantity: 3 });
    assert.deepEqual(stacksOf(await written(packs)), [1, 1, 1]);

    // Curated at one per slot; the game data says 500.
    const corpses = await box();
    await give(corpses, { itemId: "T2MuaddibComponent", quantity: 3 });
    const rows = await written(corpses);
    assert.deepEqual(stacksOf(rows), [1, 1, 1]);
    assert.deepEqual(overridesOf(rows), [1, 1, 1]);
  });
});

test("a changed, deleted or restored game data file reaches the item list and the give together", async (t) => {
  await withConsole(t, async ({ repoRoot, box, give, written, catalogRow }) => {
    const file = join(repoRoot, "runtime/data/item-game-data.json");
    const original = readFileSync(file, "utf8");
    const replace = (content) => {
      writeFileSync(`${file}.next`, content);
      renameSync(`${file}.next`, file);
    };
    // No curated volume or stack limit: both come from the game data.
    const item = "HealthPack_Channeled_2";
    const observe = async () => {
      const listed = await catalogRow(item);
      const storage = await box({ volume: 10 });
      const result = await give(storage, { itemId: item, quantity: 25 });
      return {
        listed: [listed.volume, listed.stackSize],
        given: result.given,
        stacks: stacksOf(await written(storage))
      };
    };
    const shipped = { listed: [0.05, 20], given: 25, stacks: [20, 5] };
    assert.deepEqual(await observe(), shipped);

    const edited = JSON.parse(original);
    edited.volume[item] = 1;
    edited.maxStack[item] = 4;
    replace(JSON.stringify(edited));
    assert.deepEqual(await observe(), { listed: [1, 4], given: 10, stacks: [4, 4, 2] });

    rmSync(file);
    assert.deepEqual(await observe(), { listed: [undefined, undefined], given: 25, stacks: [25] });

    replace(original);
    assert.deepEqual(await observe(), shipped);
  });
});
