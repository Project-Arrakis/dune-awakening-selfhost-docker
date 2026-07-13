import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { createZipArchive } from "../src/services/zipArchive.js";

test("creates a compressed ZIP containing each requested JSON file", () => {
  const first = Buffer.from('{"name":"Alpha"}\n');
  const second = Buffer.from('{"name":"Beta"}\n');
  const archive = createZipArchive([
    { name: "Alpha.json", content: first },
    { name: "Beta.json", content: second }
  ], new Date("2026-07-13T12:00:00Z"));

  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
  assert.equal(archive.readUInt16LE(archive.length - 12), 2);

  let offset = 0;
  for (const expected of [first, second]) {
    assert.equal(archive.readUInt32LE(offset), 0x04034b50);
    assert.equal(archive.readUInt16LE(offset + 8), 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    assert.deepEqual(inflateRawSync(archive.subarray(dataOffset, dataOffset + compressedSize)), expected);
    offset = dataOffset + compressedSize;
  }
});

test("rejects an empty ZIP archive", () => {
  assert.throws(() => createZipArchive([]), /at least one file/i);
});
