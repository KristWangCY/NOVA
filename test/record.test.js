import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/core/canonical.js";
import { hashFile } from "../src/runtime/file-hash.js";

test("file hashing streams exact bytes without exposing file contents", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-record-hash-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "personal-note.txt");
  const contents = "NOVA keeps this content off chain.\n第二行。";
  writeFileSync(path, contents, "utf8");

  const result = await hashFile(path);
  assert.equal(result.hashAlgorithm, "sha256");
  assert.equal(result.contentHash, sha256(contents));
  assert.equal(result.contentSize, Buffer.byteLength(contents));
  assert.equal(result.file, path);
  assert.equal(Object.hasOwn(result, "contents"), false);
});
