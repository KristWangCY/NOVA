import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NovaNode } from "../src/node.js";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { atomicWriteJson, readJson } from "../src/runtime/files.js";

test("node home lock prevents duplicate writers and recovers a stale owner", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-lock-test-"));
  const network = initializeDevnet({ directory: resolve(root, "network"), validators: 1, basePort: 49001 });
  const home = network.nodes[0].home;
  const lockPath = resolve(home, "node.lock");
  const nodes = [];
  t.after(async () => {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    rmSync(root, { recursive: true, force: true });
  });

  const first = new NovaNode(home, { quiet: true });
  nodes.push(first);
  assert.equal(existsSync(lockPath), true);
  assert.equal(readJson(lockPath).pid, process.pid);
  assert.throws(() => new NovaNode(home, { quiet: true }), /already in use/);

  await first.stop();
  assert.equal(existsSync(lockPath), false);

  atomicWriteJson(lockPath, {
    version: 1,
    pid: 99999999,
    instanceId: "stale-instance",
    startedAt: Date.now() - 60000,
  });
  const recovered = new NovaNode(home, { quiet: true });
  nodes.push(recovered);
  assert.equal(readJson(lockPath).pid, process.pid);
  await recovered.stop();
  assert.equal(existsSync(lockPath), false);
});

test("backup restore refuses a node home held by a live process", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-lock-restore-test-"));
  const network = initializeDevnet({ directory: resolve(root, "network"), validators: 1, basePort: 49101 });
  const home = network.nodes[0].home;
  const node = new NovaNode(home, { quiet: true });
  t.after(async () => {
    await node.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const { createBackup, restoreBackup } = await import("../src/runtime/backup.js");
  const backup = resolve(root, "backup.json");
  createBackup(home, backup);
  assert.throws(() => restoreBackup(home, backup), /already in use/);
});

test("graceful stop drains in-flight writers before releasing the node home lock", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-graceful-stop-test-"));
  const network = initializeDevnet({ directory: resolve(root, "network"), validators: 1, basePort: 49201 });
  const home = network.nodes[0].home;
  const lockPath = resolve(home, "node.lock");
  const node = new NovaNode(home, { quiet: true });
  let replacement;
  t.after(async () => {
    await node.stop();
    if (replacement) await replacement.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await node.start();

  let releaseWriter;
  let writerStarted = false;
  const writerGate = new Promise((resolveWriter) => {
    releaseWriter = resolveWriter;
  });
  node.runBackground(async () => {
    writerStarted = true;
    await writerGate;
    node.storage.persistMempool();
  });
  while (!writerStarted) {
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  }

  let stopCompleted = false;
  const firstStop = node.stop().then(() => { stopCompleted = true; });
  const repeatedStop = node.stop();
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(stopCompleted, false);
  assert.equal(existsSync(lockPath), true);
  assert.throws(() => new NovaNode(home, { quiet: true }), /already in use/);

  releaseWriter();
  await Promise.all([firstStop, repeatedStop]);
  assert.equal(stopCompleted, true);
  assert.equal(existsSync(lockPath), false);
  await assert.rejects(node.start(), /stopped node instance cannot be restarted/);
  assert.equal(node.runBackground(() => node.storage.persistMempool()), null);
  assert.throws(() => node.commitBlock({}), /stopped node instance cannot mutate/);

  replacement = new NovaNode(home, { quiet: true });
  assert.equal(existsSync(lockPath), true);
  await replacement.stop();
  assert.equal(existsSync(lockPath), false);
});
