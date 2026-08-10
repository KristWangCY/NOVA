import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashObject } from "../src/core/canonical.js";
import { NovaNode } from "../src/node.js";
import { createBackup, restoreBackup, verifyBackup } from "../src/runtime/backup.js";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { atomicWriteJson, readJson } from "../src/runtime/files.js";

test("backup excludes private keys, verifies, and restores deterministic state", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-backup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const network = initializeDevnet({ directory: resolve(root, "network"), basePort: 46001 });
  const home = network.nodes[0].home;
  const node = new NovaNode(home, { quiet: true });
  const storage = node.storage;
  const output = resolve(root, "backup.json");

  const result = createBackup(home, output);
  assert.equal(result.valid, true);
  assert.equal(result.height, 0);
  const serialized = readFileSync(output, "utf8");
  assert.equal(serialized.includes(storage.key.privateKey), false);
  assert.equal(serialized.includes(readJson(network.faucet.keyFile).privateKey), false);

  const backup = readJson(output);
  assert.equal(verifyBackup(backup).stateRoot, result.stateRoot);

  await node.stop();
  atomicWriteJson(resolve(home, "state.json"), { corrupted: true });
  const restored = restoreBackup(home, output);
  assert.equal(restored.stateRoot, result.stateRoot);
  const recoveredNode = new NovaNode(home, { quiet: true });
  assert.equal(recoveredNode.storage.state.height, 0);
  await recoveredNode.stop();
});

test("backup verification rejects checksum and signed-chain tampering", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-backup-tamper-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const network = initializeDevnet({ directory: resolve(root, "network"), basePort: 47001 });
  const output = resolve(root, "backup.json");
  createBackup(network.nodes[0].home, output);
  const backup = readJson(output);

  assert.throws(
    () => verifyBackup({ ...backup, createdAt: backup.createdAt + 1 }),
    /checksum/,
  );

  const changedChain = structuredClone(backup.chain);
  changedChain[0].hash = "0".repeat(64);
  const changed = { ...backup, chain: changedChain };
  changed.snapshotHash = hashObject({
    version: changed.version,
    type: changed.type,
    createdAt: changed.createdAt,
    genesis: changed.genesis,
    chain: changed.chain,
  });
  assert.throws(() => verifyBackup(changed), /genesis block/);
});
