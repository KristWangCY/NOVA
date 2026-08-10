import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decryptKeyRecord } from "../src/core/keystore.js";
import { generateKeyRecord } from "../src/core/crypto.js";
import { createTransfer } from "../src/core/transaction.js";
import { NovaNode } from "../src/node.js";
import { initializeNetworkFromTopology } from "../src/runtime/bootstrap.js";
import { readJson } from "../src/runtime/files.js";
import { createNetworkBackup } from "../src/runtime/network-inspection.js";
import {
  createValidatorBundle,
  installValidatorBundle,
  verifyValidatorBundle,
} from "../src/runtime/validator-bundle.js";

const PASSWORDS = {
  NOVA_BUNDLE_FAUCET_PASSWORD: "bundle faucet private password",
  NOVA_BUNDLE_NODE1_PASSWORD: "bundle validator one password",
  NOVA_BUNDLE_NODE2_PASSWORD: "bundle validator two password",
  NOVA_BUNDLE_NODE3_PASSWORD: "bundle validator three password",
};
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function topology(basePort) {
  return {
    version: 1,
    chainId: "nova-bundle-test-1",
    blockTimeMs: 800,
    initialSupply: "1000000000000",
    transport: "private-network-required",
    faucetPasswordEnv: "NOVA_BUNDLE_FAUCET_PASSWORD",
    validators: [0, 1, 2].map((index) => ({
      url: `http://127.0.0.1:${basePort + index}`,
      listenHost: "127.0.0.1",
      port: basePort + index,
      passwordEnv: `NOVA_BUNDLE_NODE${index + 1}_PASSWORD`,
    })),
  };
}

async function waitFor(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

test("one-validator bundles install isolated identities that form the network", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-validator-bundle-test-"));
  const basePort = 40000 + Math.floor(Math.random() * 5000);
  const previousEnvironment = Object.fromEntries(
    Object.keys(PASSWORDS).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, PASSWORDS);
  const network = initializeNetworkFromTopology({
    directory: resolve(root, "source"),
    topology: topology(basePort),
    environment: PASSWORDS,
  });
  const installedHomes = [];
  const nodes = [];
  let sourceNode;
  t.after(async () => {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    if (sourceNode) await sourceNode.stop();
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const sourceKeyStores = network.nodes.map(({ home }) => readJson(resolve(home, "node-key.json")));
  const faucetStore = readJson(network.faucet.keyFile);
  assert.throws(
    () => createNetworkBackup(network.directory, resolve(root, "unsafe-distributed-backup.json")),
    /bootstrap copies, not live remote chains/,
  );
  for (let index = 0; index < network.nodes.length; index += 1) {
    const node = `node${index + 1}`;
    const bundleFile = resolve(root, "bundles", `${node}.json`);
    const created = createValidatorBundle(network.directory, node, bundleFile);
    assert.equal(created.node, node);
    const serialized = readFileSync(bundleFile, "utf8");
    assert.equal(serialized.includes(faucetStore.crypto.ciphertext), false, "bundle must exclude the faucet key");
    for (let otherIndex = 0; otherIndex < sourceKeyStores.length; otherIndex += 1) {
      if (otherIndex !== index) {
        assert.equal(
          serialized.includes(sourceKeyStores[otherIndex].crypto.ciphertext),
          false,
          "bundle must exclude every other validator key",
        );
      }
    }
    const verified = verifyValidatorBundle(readJson(bundleFile));
    assert.equal(verified.valid, true);
    assert.equal(verified.validator, network.nodes[index].validator);

    const installedHome = resolve(root, "devices", node);
    installedHomes.push(installedHome);
    const installed = installValidatorBundle(bundleFile, installedHome);
    assert.equal(installed.installedTo, installedHome);
    assert.throws(() => installValidatorBundle(bundleFile, installedHome), /non-empty directory/);

    const tampered = structuredClone(readJson(bundleFile));
    tampered.config.listenHost = "0.0.0.0";
    assert.throws(() => verifyValidatorBundle(tampered), /checksum/);
  }

  nodes.push(...installedHomes.map((home) => new NovaNode(home, { quiet: true })));
  await Promise.all(nodes.map((node) => node.start()));
  const faucet = decryptKeyRecord(faucetStore, PASSWORDS.NOVA_BUNDLE_FAUCET_PASSWORD);
  const recipient = generateKeyRecord("bundle-recipient");
  nodes[0].addTransaction(createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "1000000",
    fee: "2",
    nonce: 1,
    memo: "validator bundles on isolated homes",
  }));
  await waitFor(
    () => nodes.every((node) => node.storage.state.balances[recipient.address] === "1000000"),
    "installed bundle validator finality",
  );
  await Promise.all(nodes.map((node) => node.stop()));

  sourceNode = new NovaNode(network.nodes[0].home, { quiet: true });
  await sourceNode.start();
  assert.throws(
    () => createValidatorBundle(network.directory, "node1", resolve(root, "bundles", "duplicate-node1.json")),
    /already in use/,
  );
});
