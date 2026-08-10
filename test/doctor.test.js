import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyRecord } from "../src/core/crypto.js";
import { createProposal, createVote } from "../src/core/block.js";
import { decryptKeyRecord } from "../src/core/keystore.js";
import { createGenesisState } from "../src/core/state.js";
import { createTransfer } from "../src/core/transaction.js";
import { NovaNode } from "../src/node.js";
import { verifyBackup } from "../src/runtime/backup.js";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { atomicWriteJson, readJson } from "../src/runtime/files.js";
import {
  createNetworkBackup,
  diagnoseNetwork,
  inspectNetwork,
} from "../src/runtime/network-inspection.js";

const PASSWORD = "doctor network test password";
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitFor(check, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

test("doctor distinguishes healthy, stopped, and degraded encrypted networks", { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-doctor-test-"));
  const basePort = 12000 + Math.floor(Math.random() * 1000);
  const network = initializeDevnet({
    directory: resolve(root, "network"),
    basePort,
    blockTimeMs: 800,
    chainId: "nova-doctor-test-1",
    encryptKeys: true,
    keyPassword: PASSWORD,
    keyPasswordEnv: "NOVA_DOCTOR_TEST_PASSWORD",
  });
  const nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true, keyPassword: PASSWORD }));
  const previousPassword = process.env.NOVA_DOCTOR_TEST_PASSWORD;
  process.env.NOVA_DOCTOR_TEST_PASSWORD = PASSWORD;
  t.after(async () => {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    if (previousPassword === undefined) delete process.env.NOVA_DOCTOR_TEST_PASSWORD;
    else process.env.NOVA_DOCTOR_TEST_PASSWORD = previousPassword;
    rmSync(root, { recursive: true, force: true });
  });

  const stopped = await diagnoseNetwork({ directory: network.directory });
  assert.equal(stopped.healthy, true);
  assert.equal(stopped.onlineValidators, 0);
  assert.ok(stopped.nodes.every(({ keyUnlockVerified }) => keyUnlockVerified));
  assert.ok(stopped.checks.some(({ id, status }) => id === "online-validator-count" && status === "warn"));

  process.env.NOVA_DOCTOR_TEST_PASSWORD = "incorrect doctor password";
  const wrongPassword = await diagnoseNetwork({ directory: network.directory, probeOnline: false });
  assert.equal(wrongPassword.healthy, false);
  assert.ok(wrongPassword.checks.some(({ id, status }) => id === "key-unlock.node1" && status === "fail"));
  process.env.NOVA_DOCTOR_TEST_PASSWORD = PASSWORD;

  await Promise.all(nodes.map((node) => node.start()));
  const online = await diagnoseNetwork({ directory: network.directory, requireOnline: true });
  assert.equal(online.healthy, true);
  assert.equal(online.onlineValidators, 3);
  assert.ok(online.checks.some(({ id, status }) => id === "online-heads" && status === "pass"));

  await nodes[2].stop();
  const degraded = await diagnoseNetwork({ directory: network.directory, requireOnline: true });
  assert.equal(degraded.healthy, false);
  assert.equal(degraded.onlineValidators, 2);
  assert.ok(degraded.checks.some(({ id, status }) => id === "online-validator-count" && status === "fail"));
});

test("network backup selects the highest verified common chain and rejects bad configuration", { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-network-backup-test-"));
  const basePort = 14000 + Math.floor(Math.random() * 1000);
  const network = initializeDevnet({
    directory: resolve(root, "network"),
    basePort,
    blockTimeMs: 800,
    chainId: "nova-network-backup-test-1",
    encryptKeys: true,
    keyPassword: PASSWORD,
    keyPasswordEnv: "NOVA_DOCTOR_TEST_PASSWORD",
  });
  const nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true, keyPassword: PASSWORD }));
  t.after(async () => {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    rmSync(root, { recursive: true, force: true });
  });

  const faucet = decryptKeyRecord(readJson(network.faucet.keyFile), PASSWORD);
  const recipient = generateKeyRecord("doctor-recipient");
  await Promise.all(nodes.map((node) => node.start()));
  nodes[0].addTransaction(createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "3000000",
    fee: "7",
    nonce: 1,
    memo: "network backup source selection",
  }));
  await waitFor(
    () => nodes.every((node) => node.storage.state.balances[recipient.address] === "3000000"),
    "replicated transaction",
  );
  await Promise.all(nodes.map((node) => node.stop()));

  const committedHeight = readJson(resolve(network.nodes[0].home, "chain.json")).at(-1).header.height;
  const laggingChainPath = resolve(network.nodes[2].home, "chain.json");
  const laggingChain = readJson(laggingChainPath);
  atomicWriteJson(laggingChainPath, laggingChain.slice(0, -1));

  const inspection = inspectNetwork(network.directory);
  assert.equal(inspection.healthy, true);
  assert.equal(inspection.backupSource.height, committedHeight);
  assert.notEqual(inspection.backupSource.name, "node3");
  assert.ok(inspection.checks.some(({ id, status }) => id === "offline-heads" && status === "warn"));

  const output = resolve(root, "backups", "network.json");
  const created = createNetworkBackup(network.directory, output);
  assert.equal(created.height, committedHeight);
  assert.notEqual(created.sourceNode, "node3");
  assert.equal(verifyBackup(readJson(output)).height, committedHeight);

  const originalBlock = laggingChain[1];
  const alternateRecipient = generateKeyRecord("alternate-history-recipient");
  const alternateTransaction = createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: alternateRecipient.address,
    amount: "1000000",
    fee: "9",
    nonce: 1,
    memo: "conflicting signed history",
  });
  const slot = originalBlock.header.slot;
  const proposer = nodes[slot % nodes.length].key;
  const alternateProposal = createProposal({
    genesis: network.genesis,
    tip: laggingChain[0],
    state: createGenesisState(network.genesis),
    transactions: [alternateTransaction],
    key: proposer,
    slot,
    timestamp: slot * network.genesis.blockTimeMs,
  });
  const alternateBlock = {
    ...alternateProposal,
    commit: { votes: [createVote(alternateProposal, nodes[0].key), createVote(alternateProposal, nodes[1].key)] },
  };
  atomicWriteJson(laggingChainPath, [laggingChain[0], alternateBlock]);
  const divergent = inspectNetwork(network.directory);
  assert.equal(divergent.healthy, false);
  assert.equal(divergent.backupSource, null);
  assert.ok(divergent.checks.some(({ id, status }) => id === "chain-prefix" && status === "fail"));
  assert.throws(
    () => createNetworkBackup(network.directory, resolve(root, "backups", "divergent.json")),
    /network is not safe to back up/,
  );

  atomicWriteJson(laggingChainPath, laggingChain.slice(0, -1));

  const configPath = resolve(network.nodes[1].home, "config.json");
  const config = readJson(configPath);
  atomicWriteJson(configPath, { ...config, peers: [] });
  const broken = inspectNetwork(network.directory);
  assert.equal(broken.healthy, false);
  assert.ok(broken.checks.some(({ id, status }) => id === "node.node2" && status === "fail"));
  assert.throws(
    () => createNetworkBackup(network.directory, resolve(root, "backups", "unsafe.json")),
    /network is not safe to back up/,
  );
});
