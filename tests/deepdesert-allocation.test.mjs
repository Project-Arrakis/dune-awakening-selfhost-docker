import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
function body(file, name) {
  const source = readFileSync(new URL(file, root), 'utf8');
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}
const demand = body('runtime/scripts/autoscaler.sh', 'handle_demand');
const response = body('runtime/scripts/autoscaler.sh', 'scan_deepdesert_loading_responses');
const binding = body('runtime/scripts/spawn-server.sh', 'bind_partition_to_live_server');

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dune-allocation-test-'));
  try {
    mkdirSync(join(dir, 'runtime/scripts'), { recursive: true });
    writeFileSync(join(dir, 'runtime/scripts/spawn-server.sh'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$SPAWN_LOG"\n', { mode: 0o755 });
    run(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function bash(dir, code, env = {}) {
  return spawnSync('bash', ['-c', code], { cwd: dir, encoding: 'utf8', env: { ...process.env, SPAWN_LOG: join(dir, 'spawns'), ...env } });
}

for (const [destination, expected, disabled = false] of [[35, '35'], [8, '8'], [null, 'DeepDesert_1'], [35, null, true]]) {
  test(`Deep Desert demand allocates only response destination ${destination ?? 'fallback'} (disabled=${disabled})`, () => fixture(dir => {
    const payload = { Code: 1, MapName: 'DeepDesert_1', ServerState: 0, RequestID: 'test-flow', DestinationPartitionId: destination };
    writeFileSync(join(dir, 'director.log'), `Notified player(s) "test-player" of travel response Overmap2: ${JSON.stringify(payload)}\n`);
    const result = bash(dir, `${demand}\n${response}
      demand_event_seen(){ return 1; }
      remember_map_demand(){ :; }
      remember_demand_event(){ :; }
      map_is_always_on(){ return 1; }
      map_exists(){ return 0; }
      map_is_disabled(){ return ${disabled ? 0 : 1}; }
      map_assigned_count(){ echo 0; }
      container_count_for_map(){ echo 0; }
      origin_server_id_for_origin_id(){ echo test-origin; }
      deepdesert_target_json(){ return 1; }
      docker(){ cat director.log; }
      SINCE=10m
      handle_demand DeepDesert_1 1 event
      scan_deepdesert_loading_responses
    `);
    assert.equal(result.status, 0, result.stderr);
    if (expected === null) assert.equal(existsSync(join(dir, 'spawns')), false);
    else assert.equal(readFileSync(join(dir, 'spawns'), 'utf8'), `${expected}\n`);
  }));
}

test('binding reports success only when PostgreSQL returns an assigned row', () => fixture(dir => {
  for (const [result, status, expected] of [['', 0, false], ['server-a', 0, true], ['', 1, false]]) {
    const run = bash(dir, `${binding}
      psql_value(){ echo server-a; }
      docker(){ printf '%s' "$BIND_RESULT"; return "$BIND_STATUS"; }
      bind_partition_to_live_server 35 DeepDesert_1 7783 7894 1 0
    `, { BIND_RESULT: result, BIND_STATUS: String(status) });
    assert.equal(run.status === 0, expected);
    assert.equal(run.stdout, expected ? 'server-a' : '');
  }
}));

test('assignment SQL rejects occupied IDs and preserves existing assignments', { skip: !process.env.DUNE_TEST_POSTGRES_CONTAINER }, () => fixture(dir => {
  const sqlPath = join(dir, 'bind.sql');
  bash(dir, `${binding}
    psql_value(){ echo server-a; }
    docker(){ printf '%s' "\${!#}" > "$SQL_PATH"; }
    bind_partition_to_live_server 35 DeepDesert_1 7783 7894 1 0
  `, { SQL_PATH: sqlPath });
  const sql = readFileSync(sqlPath, 'utf8');
  const query = text => {
    const result = spawnSync('docker', ['exec', '-i', process.env.DUNE_TEST_POSTGRES_CONTAINER, 'psql', '-U', 'postgres', '-d', 'dune', '-Atq', '-v', 'ON_ERROR_STOP=1'], { input: text, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  query('create schema dune; create table dune.world_partition(partition_id int primary key, map text, server_id text, unique(server_id,map)); insert into dune.world_partition values (8,\'DeepDesert_1\',\'server-a\'), (35,\'DeepDesert_1\',null);');
  assert.equal(query(sql), '');
  assert.equal(query('select server_id from dune.world_partition where partition_id=8'), 'server-a');
  query('update dune.world_partition set server_id=null where partition_id=8');
  assert.equal(query(sql), 'server-a');
  assert.equal(query(sql), 'server-a');
  query("update dune.world_partition set server_id='server-b' where partition_id=35");
  assert.equal(query(sql), '');
  assert.equal(query('select server_id from dune.world_partition where partition_id=35'), 'server-b');
}));
