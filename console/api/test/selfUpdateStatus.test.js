import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSelfUpdateStatus } from "../src/services/selfUpdateStatus.js";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

test("self-update status returns a bounded pending result before the helper writes", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-self-update-status-"));
  try {
    assert.deepEqual(readSelfUpdateStatus(root, RUN_ID), {
      runId: RUN_ID,
      state: "pending",
      stage: "launching",
      percent: 1,
      message: "Waiting for the update helper to start."
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-update status validates and normalizes a durable helper result", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-self-update-status-"));
  const directory = join(root, "runtime", "generated", "self-update-status");
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${RUN_ID}.env`), [
      `run_id=${RUN_ID}`,
      "state=failed",
      "stage=building",
      "percent=124",
      "message=npm ci timed out\u0000",
      "started_at=2026-08-18T07:00:00+00:00",
      "updated_at=not-a-date",
      "finished_at=2026-08-18T07:30:00+00:00"
    ].join("\n"));

    assert.deepEqual(readSelfUpdateStatus(root, RUN_ID), {
      runId: RUN_ID,
      state: "failed",
      stage: "building",
      percent: 100,
      message: "npm ci timed out",
      startedAt: "2026-08-18T07:00:00+00:00",
      updatedAt: null,
      finishedAt: "2026-08-18T07:30:00+00:00",
      discordHealthOk: null
    });
    assert.throws(() => readSelfUpdateStatus(root, "../../etc/passwd"), /Invalid console update run ID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-update status rejects mismatched or corrupt helper state", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-self-update-status-"));
  const directory = join(root, "runtime", "generated", "self-update-status");
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${RUN_ID}.env`), `run_id=aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa\nstate=running\n`);
    assert.throws(() => readSelfUpdateStatus(root, RUN_ID), /does not match/);
    writeFileSync(join(directory, `${RUN_ID}.env`), `run_id=${RUN_ID}\nstate=unknown\n`);
    assert.throws(() => readSelfUpdateStatus(root, RUN_ID), /invalid state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readSelfUpdateStatus surfaces an optional discordHealthOk field when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-selfupdate-status-"));
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  const statusDir = join(dir, "runtime", "generated", "self-update-status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(join(statusDir, `${runId}.env`), [
    `run_id=${runId}`,
    "state=succeeded",
    "stage=complete",
    "percent=100",
    "message=Discord adapter enabled.",
    "started_at=2026-09-09T00:00:00Z",
    "updated_at=2026-09-09T00:01:00Z",
    "finished_at=2026-09-09T00:01:00Z",
    "discord_health_ok=1"
  ].join("\n"));

  const result = readSelfUpdateStatus(dir, runId);
  assert.equal(result.discordHealthOk, true);
});

test("readSelfUpdateStatus reports discordHealthOk as null when the field is absent (ordinary self-update status files)", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-selfupdate-status-plain-"));
  const runId = "223e4567-e89b-42d3-a456-426614174000";
  const statusDir = join(dir, "runtime", "generated", "self-update-status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(join(statusDir, `${runId}.env`), [
    `run_id=${runId}`,
    "state=succeeded",
    "stage=complete",
    "percent=100",
    "message=Console update completed successfully.",
    "started_at=2026-09-09T00:00:00Z",
    "updated_at=2026-09-09T00:01:00Z",
    "finished_at=2026-09-09T00:01:00Z"
  ].join("\n"));

  const result = readSelfUpdateStatus(dir, runId);
  assert.equal(result.discordHealthOk, null);
});
