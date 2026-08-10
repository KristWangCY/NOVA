import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyRecord } from "../src/core/crypto.js";
import { decryptKeyRecord, isEncryptedKeystore } from "../src/core/keystore.js";
import { createTransfer } from "../src/core/transaction.js";
import { NovaNode } from "../src/node.js";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { atomicWriteJson, readJson } from "../src/runtime/files.js";

const PASSWORD = "secure network test password";
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitFor(check, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

test("encrypted validators restart from signed chain and repair corrupted derived state", { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-secure-recovery-test-"));
  const basePort = 30000 + Math.floor(Math.random() * 10000);
  const network = initializeDevnet({
    directory: resolve(root, "network"),
    basePort,
    blockTimeMs: 800,
    chainId: "nova-secure-test-1",
    encryptKeys: true,
    keyPassword: PASSWORD,
    keyPasswordEnv: "NOVA_TEST_NODE_PASSWORD",
  });
  let nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true, keyPassword: PASSWORD }));
  t.after(async () => {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    rmSync(root, { recursive: true, force: true });
  });

  assert.ok(network.nodes.every(({ home }) => isEncryptedKeystore(readJson(resolve(home, "node-key.json")))));
  const faucetStore = readJson(network.faucet.keyFile);
  assert.equal(isEncryptedKeystore(faucetStore), true);
  const faucet = decryptKeyRecord(faucetStore, PASSWORD);
  const recipient = generateKeyRecord("secure-recipient");

  await Promise.all(nodes.map((node) => node.start()));
  nodes[0].addTransaction(createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "5000000",
    fee: "5",
    nonce: 1,
    memo: "before restart",
  }));
  await waitFor(
    () => nodes.every((node) => node.storage.state.balances[recipient.address] === "5000000"),
    "first secure transfer",
  );
  const committedHeight = Math.min(...nodes.map((node) => node.status().height));
  await Promise.all(nodes.map((node) => node.stop()));

  atomicWriteJson(resolve(network.nodes[1].home, "state.json"), { corrupted: true });
  nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true, keyPassword: PASSWORD }));
  assert.ok(nodes.every((node) => node.status().height === committedHeight));
  assert.ok(nodes.every((node) => node.storage.state.balances[recipient.address] === "5000000"));
  assert.equal(readJson(resolve(network.nodes[1].home, "state.json")).balances[recipient.address], "5000000");

  await Promise.all(nodes.map((node) => node.start()));
  nodes[2].addTransaction(createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "1000000",
    fee: "5",
    nonce: 2,
    memo: "after restart",
  }));
  await waitFor(
    () => nodes.every((node) => node.storage.state.balances[recipient.address] === "6000000"),
    "post-restart secure transfer",
  );
  assert.ok(nodes.every((node) => node.status().validatorKeyEncrypted === true));
  assert.ok(nodes.every((node) => node.status().height > committedHeight));
});
