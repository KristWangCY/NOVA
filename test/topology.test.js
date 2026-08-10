import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decryptKeyRecord, isEncryptedKeystore } from "../src/core/keystore.js";
import { generateKeyRecord } from "../src/core/crypto.js";
import { createTransfer } from "../src/core/transaction.js";
import { NovaNode } from "../src/node.js";
import { initializeNetworkFromTopology } from "../src/runtime/bootstrap.js";
import { atomicWriteJson, readJson } from "../src/runtime/files.js";
import { diagnoseNetwork } from "../src/runtime/network-inspection.js";
import { createNetworkTopologyTemplate, validateNetworkTopology } from "../src/runtime/topology.js";

const PASSWORDS = {
  NOVA_FAUCET_PASSWORD: "topology faucet password",
  NOVA_NODE1_PASSWORD: "topology validator one password",
  NOVA_NODE2_PASSWORD: "topology validator two password",
  NOVA_NODE3_PASSWORD: "topology validator three password",
};
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function loopbackTopology(basePort = 30000 + Math.floor(Math.random() * 10000)) {
  return {
    ...createNetworkTopologyTemplate(),
    chainId: "nova-topology-test-1",
    blockTimeMs: 800,
    validators: [0, 1, 2].map((index) => ({
      url: `http://127.0.0.1:${basePort + index}`,
      listenHost: "127.0.0.1",
      port: basePort + index,
      passwordEnv: `NOVA_NODE${index + 1}_PASSWORD`,
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

test("distributed topology is public, exact, and private-transport constrained", () => {
  const topology = loopbackTopology();
  assert.deepEqual(validateNetworkTopology(topology), topology);
  assert.throws(
    () => validateNetworkTopology({ ...topology, password: "must never appear here" }),
    /unsupported or missing fields/,
  );
  assert.throws(
    () => validateNetworkTopology({ ...topology, transport: "public-http" }),
    /private-network-required/,
  );
  assert.throws(
    () => validateNetworkTopology({
      ...topology,
      validators: topology.validators.map((validator, index) => (
        index === 0 ? { ...validator, url: `http://8.8.8.8:${validator.port}` } : validator
      )),
    }),
    /globally routable IPv4/,
  );
  assert.throws(
    () => validateNetworkTopology({
      ...topology,
      validators: topology.validators.map((validator, index) => (
        index === 1 ? { ...validator, passwordEnv: topology.validators[0].passwordEnv } : validator
      )),
    }),
    /environment names must be unique/,
  );
  assert.throws(
    () => validateNetworkTopology({
      ...topology,
      validators: topology.validators.map((validator, index) => (
        index === 1 ? { ...validator, url: topology.validators[0].url, port: topology.validators[0].port } : validator
      )),
    }),
    /advertised URLs must be unique/,
  );
  assert.throws(
    () => validateNetworkTopology({ ...topology, validators: topology.validators.slice(0, 2) }),
    /between 3 and 20 validators/,
  );
});

test("topology initialization requires four distinct passwords before writing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-topology-password-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = resolve(root, "network");
  const topology = loopbackTopology();

  assert.throws(
    () => initializeNetworkFromTopology({ directory, topology, environment: {} }),
    /NOVA_FAUCET_PASSWORD/,
  );
  assert.equal(existsSync(directory), false);
  assert.throws(
    () => initializeNetworkFromTopology({
      directory,
      topology,
      environment: { ...PASSWORDS, NOVA_NODE3_PASSWORD: PASSWORDS.NOVA_NODE2_PASSWORD },
    }),
    /must use a password different/,
  );
  assert.equal(existsSync(directory), false);
});

test("three independently encrypted topology validators finalize a transfer", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-topology-network-test-"));
  const topology = loopbackTopology();
  const previousEnvironment = Object.fromEntries(
    Object.keys(PASSWORDS).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, PASSWORDS);
  const network = initializeNetworkFromTopology({
    directory: resolve(root, "network"),
    topology,
    environment: PASSWORDS,
  });
  const nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true }));
  t.after(async () => {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal(network.deploymentFile, resolve(root, "network", "deployment.json"));
  assert.equal(readJson(network.deploymentFile).transport, "private-network-required");
  assert.equal(readFileSync(network.deploymentFile, "utf8").includes("topology validator"), false);
  const faucetStore = readJson(network.faucet.keyFile);
  assert.equal(isEncryptedKeystore(faucetStore), true);
  assert.throws(() => decryptKeyRecord(faucetStore, PASSWORDS.NOVA_NODE1_PASSWORD), /decrypt/);
  const faucet = decryptKeyRecord(faucetStore, PASSWORDS.NOVA_FAUCET_PASSWORD);

  for (let index = 0; index < network.nodes.length; index += 1) {
    const storedKey = readJson(resolve(network.nodes[index].home, "node-key.json"));
    const config = readJson(resolve(network.nodes[index].home, "config.json"));
    assert.equal(isEncryptedKeystore(storedKey), true);
    assert.equal(config.version, 2);
    assert.equal(config.advertisedUrl, topology.validators[index].url);
    assert.equal(config.keyPasswordEnv, topology.validators[index].passwordEnv);
    assert.doesNotThrow(() => decryptKeyRecord(storedKey, PASSWORDS[config.keyPasswordEnv]));
    const wrongPassword = PASSWORDS[`NOVA_NODE${((index + 1) % 3) + 1}_PASSWORD`];
    assert.throws(() => decryptKeyRecord(storedKey, wrongPassword), /decrypt/);
  }

  await Promise.all(nodes.map((node) => node.start()));
  const recipient = generateKeyRecord("topology-recipient");
  nodes[0].addTransaction(createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "2500000",
    fee: "5",
    nonce: 1,
    memo: "independent validator passwords",
  }));
  await waitFor(
    () => nodes.every((node) => node.storage.state.balances[recipient.address] === "2500000"),
    "topology transfer replication",
  );
  const diagnosis = await diagnoseNetwork({ directory: network.directory, requireOnline: true });
  assert.equal(diagnosis.healthy, true);
  assert.equal(diagnosis.onlineValidators, 3);
  assert.ok(diagnosis.nodes.every(({ keyUnlockVerified }) => keyUnlockVerified));
  assert.ok(nodes.every((node, index) => node.status().advertisedUrl === topology.validators[index].url));

  await Promise.all(nodes.map((node) => node.stop()));
  const configPath = resolve(network.nodes[0].home, "config.json");
  const config = readJson(configPath);
  atomicWriteJson(configPath, { ...config, advertisedUrl: `http://127.0.0.2:${config.port}` });
  assert.throws(
    () => new NovaNode(network.nodes[0].home, { quiet: true }),
    /advertised URL differs from its genesis validator URL/,
  );
  const { advertisedUrl, ...legacyConfig } = config;
  atomicWriteJson(configPath, { ...legacyConfig, version: 1 });
  const legacyNode = new NovaNode(network.nodes[0].home, { quiet: true });
  assert.equal(legacyNode.status().advertisedUrl, advertisedUrl);
  await legacyNode.stop();
});
