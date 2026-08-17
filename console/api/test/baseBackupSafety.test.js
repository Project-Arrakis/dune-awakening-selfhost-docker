import assert from "node:assert/strict";
import test from "node:test";
import { verifyBaseBackupState } from "../src/services/baseBackupSafety.js";

test("base backup safety returns the verified state", async () => {
  const duneDb = { baseIsBackedUp: async (_db, baseId) => baseId === 42 };
  assert.equal(await verifyBaseBackupState(duneDb, {}, 42), true);
  assert.equal(await verifyBaseBackupState(duneDb, {}, 7), false);
});
test("base backup safety fails closed when verification errors", async () => {
  const queryError = new Error("database connection failed");
  const duneDb = { baseIsBackedUp: async () => { throw queryError; } };

  await assert.rejects(
    verifyBaseBackupState(duneDb, {}, 42),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.cause, queryError);
      assert.match(error.message, /could not verify.*backup state/i);
      assert.match(error.message, /No changes were made/i);
      return true;
    }
  );
});
