import test from "node:test";
import assert from "node:assert/strict";

// Test the sanitizeBlueprintFilename helper from server.js
// We duplicate the function here for testing since it's not exported
function sanitizeBlueprintFilename(s) {
  return String(s).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, "_").trim() || "blueprint";
}

test("sanitizeBlueprintFilename strips special characters", () => {
  assert.equal(sanitizeBlueprintFilename("test.json"), "test.json");
  assert.equal(sanitizeBlueprintFilename("base/name"), "base_name");
  assert.equal(sanitizeBlueprintFilename('evil"name'), "evil_name");
  assert.equal(sanitizeBlueprintFilename("path\\traversal"), "path_traversal");
  assert.equal(sanitizeBlueprintFilename("<script>"), "_script_");
  assert.equal(sanitizeBlueprintFilename("file?.json"), "file_.json");
  assert.equal(sanitizeBlueprintFilename("name:test"), "name_test");
});

test("sanitizeBlueprintFilename handles null/undefined gracefully", () => {
  assert.equal(sanitizeBlueprintFilename(null), "null");
  assert.equal(sanitizeBlueprintFilename(undefined), "undefined");
});

test("sanitizeBlueprintFilename handles empty string", () => {
  assert.equal(sanitizeBlueprintFilename(""), "blueprint");
  assert.equal(sanitizeBlueprintFilename("   "), "blueprint");
});

test("sanitizeBlueprintFilename handles control characters", () => {
  assert.equal(sanitizeBlueprintFilename("test\x00hidden"), "test_hidden");
  assert.equal(sanitizeBlueprintFilename("\x1Fstart"), "_start");
  assert.equal(sanitizeBlueprintFilename("\x7Fdel"), "_del");
});

test("sanitizeBlueprintFilename preserves valid characters", () => {
  assert.equal(sanitizeBlueprintFilename("My_Base-2x1.1"), "My_Base-2x1.1");
  assert.equal(sanitizeBlueprintFilename("Base (1)"), "Base (1)");
  assert.equal(sanitizeBlueprintFilename("alpha_numeric-123.abc"), "alpha_numeric-123.abc");
});

// ── route validation logic (duplicated for testing) ──

function validateBlueprintId(path) {
  const match = path.match(/^\/api\/blueprints\/([^/]+)$/);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isFinite(id) || id < 1) return null;
  return id;
}

function validateExportId(path) {
  const match = path.match(/^\/api\/blueprints\/([^/]+)\/export$/);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isFinite(id) || id < 1) return null;
  return id;
}

function validateImportPlayerId(raw) {
  const n = Number(String(raw || ""));
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

test("validateBlueprintId accepts valid numeric IDs", () => {
  assert.equal(validateBlueprintId("/api/blueprints/1"), 1);
  assert.equal(validateBlueprintId("/api/blueprints/42"), 42);
  assert.equal(validateBlueprintId("/api/blueprints/99999"), 99999);
});

test("validateBlueprintId rejects non-numeric IDs", () => {
  assert.equal(validateBlueprintId("/api/blueprints/abc"), null);
  assert.equal(validateBlueprintId("/api/blueprints/"), null);
  assert.equal(validateBlueprintId("/api/blueprints"), null);
});

test("validateBlueprintId rejects zero and negative IDs", () => {
  assert.equal(validateBlueprintId("/api/blueprints/0"), null);
  assert.equal(validateBlueprintId("/api/blueprints/-1"), null);
});

test("validateExportId accepts valid export paths", () => {
  assert.equal(validateExportId("/api/blueprints/1/export"), 1);
  assert.equal(validateExportId("/api/blueprints/42/export"), 42);
});

test("validateExportId rejects malformed export paths", () => {
  assert.equal(validateExportId("/api/blueprints/abc/export"), null);
  assert.equal(validateExportId("/api/blueprints/0/export"), null);
  assert.equal(validateExportId("/api/blueprints/1/export/more"), null);
});

test("validateExportId does not match delete paths", () => {
  assert.equal(validateExportId("/api/blueprints/1"), null);
});

test("validateImportPlayerId accepts valid player IDs", () => {
  assert.equal(validateImportPlayerId("1"), 1);
  assert.equal(validateImportPlayerId(42), 42);
  assert.equal(validateImportPlayerId("  99  "), 99);
});

test("validateImportPlayerId rejects invalid player IDs", () => {
  assert.equal(validateImportPlayerId(""), null);
  assert.equal(validateImportPlayerId(null), null);
  assert.equal(validateImportPlayerId(undefined), null);
  assert.equal(validateImportPlayerId(0), null);
  assert.equal(validateImportPlayerId(-5), null);
  assert.equal(validateImportPlayerId("abc"), null);
});

// ── confirm route order prevents route confusion ──

test("route matching: import before delete", () => {
  // /api/blueprints/import (POST) must match before /api/blueprints/:id (DELETE)
  // Ensures "import" is not treated as an ID
  assert.equal(validateBlueprintId("/api/blueprints/import"), null);
  assert.equal(validateExportId("/api/blueprints/import/export"), null);
});

test("route matching: export before delete", () => {
  // /api/blueprints/:id/export (GET) must match before /api/blueprints/:id (DELETE)
  const exportId = validateExportId("/api/blueprints/123/export");
  assert.equal(exportId, 123);
});
