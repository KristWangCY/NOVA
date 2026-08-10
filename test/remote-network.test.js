import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyRecord } from "../src/core/crypto.js";
import { decryptKeyRecord } from "../src/core/keystore.js";
import { createTransfer } from "../src/core/transaction.js";
import { createSignedStatus } from "../src/core/signed-status.js";
import { NovaNode } from "../src/node.js";
import { restoreBackup, verifyBackup } from "../src/runtime/backup.js";
import { initializeNetworkFromTopology } from "../src/runtime/bootstrap.js";
import { validateDeploymentManifest } from "../src/runtime/deployment.js";
import { readJson } from "../src/runtime/files.js";
import {
  createRemoteNetworkBackup,
  diagnoseRemoteDeployment,
} from "../src/runtime/remote-network.js";
import {
  createValidatorBundle,
  installValidatorBundle,
} from "../src/runtime/validator-bundle.js";

const PASSWORDS = {
  NOVA_REMOTE_FAUCET_PASSWORD: "remote faucet private password",
  NOVA_REMOTE_NODE1_PASSWORD: "remote validator one password",
  NOVA_REMOTE_NODE2_PASSWORD: "remote validator two password",
  NOVA_REMOTE_NODE3_PASSWORD: "remote validator three password",
};

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function topology(basePort) {
  return {
    version: 1,
    chainId: "nova-remote-test-1",
    blockTimeMs: 800,
    initialSupply: "1000000000000",
    transport: "private-network-required",
    faucetPasswordEnv: "NOVA_REMOTE_FAUCET_PASSWORD",
    validators: [0, 1, 2].map((index) => ({
      url: `http://127.0.0.1:${basePort + index}`,
      listenHost: "127.0.0.1",
      port: basePort + index,
      passwordEnv: `NOVA_REMOTE_NODE${index + 1}_PASSWORD`,
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

test("remote diagnosis authenticates quorum and remote backup survives one unavailable validator", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-remote-network-test-"));
  const basePort = 45000 + Math.floor(Math.random() * 3000);
  const previousEnvironment = Object.fromEntries(
    Object.keys(PASSWORDS).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, PASSWORDS);
  const network = initializeNetworkFromTopology({
    directory: resolve(root, "network"),
    topology: topology(basePort),
    environment: PASSWORDS,
  });
  const thirdValidatorBundle = resolve(root, "recovery", "node3-bundle.json");
  createValidatorBundle(network.directory, "node3", thirdValidatorBundle);
  const nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true }));
  let fakeServer;
  let recoveredNode;
  t.after(async () => {
    if (fakeServer?.listening) {
      await new Promise((resolveClose) => fakeServer.close(resolveClose));
    }
    if (recoveredNode) await recoveredNode.stop();
    await Promise.allSettled(nodes.map((node) => node.stop()));
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const deployment = readJson(network.deploymentFile);
  assert.equal(validateDeploymentManifest(deployment, network.genesis), deployment);
  assert.throws(
    () => validateDeploymentManifest({
      ...deployment,
      nodes: deployment.nodes.map((node, index) => (
        index === 0 ? { ...node, url: `http://127.0.0.1:${basePort + 99}` } : node
      )),
    }, network.genesis),
    /differs from genesis/,
  );

  await Promise.all(nodes.map((node) => node.start()));
  const missingChallenge = await fetch(`${network.nodes[0].url}/status/signed`);
  assert.equal(missingChallenge.status, 400);
  assert.match((await missingChallenge.json()).error, /challenge must be a UUID/);

  const initialDiagnosis = await diagnoseRemoteDeployment({
    directory: network.directory,
    timeoutMs: 1000,
  });
  assert.equal(initialDiagnosis.healthy, true);
  assert.equal(initialDiagnosis.operational, true);
  assert.equal(initialDiagnosis.onlineValidators, 3);
  assert.ok(initialDiagnosis.nodes.every(({ valid, reachable }) => valid && reachable));
  assert.ok(initialDiagnosis.checks.some(({ id, status }) => id === "remote-heads" && status === "pass"));

  const faucet = decryptKeyRecord(readJson(network.faucet.keyFile), PASSWORDS.NOVA_REMOTE_FAUCET_PASSWORD);
  const recipient = generateKeyRecord("remote-backup-recipient");
  nodes[0].addTransaction(createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "7000000",
    fee: "9",
    nonce: 1,
    memo: "remote backup quorum integration",
  }));
  await waitFor(
    () => nodes.every((node) => node.storage.state.balances[recipient.address] === "7000000"),
    "remote backup transaction finality",
  );

  const allBackupFile = resolve(root, "backups", "all-online.json");
  const allBackup = await createRemoteNetworkBackup({
    directory: network.directory,
    output: allBackupFile,
    timeoutMs: 1000,
  });
  const allVerification = verifyBackup(readJson(allBackupFile));
  assert.equal(allBackup.observedValidators, 3);
  assert.equal(allBackup.height, nodes[0].status().height);
  assert.equal(allVerification.blockHash, allBackup.blockHash);
  assert.equal(allVerification.state.balances[recipient.address], "7000000");
  const serializedBackup = readFileSync(allBackupFile, "utf8");
  assert.equal(serializedBackup.includes("privateKey"), false);
  assert.equal(serializedBackup.includes("ciphertext"), false);

  await nodes[2].stop();
  const recoveredHome = resolve(root, "replacement-device", "node3");
  installValidatorBundle(thirdValidatorBundle, recoveredHome);
  const restoredThirdNode = restoreBackup(recoveredHome, allBackupFile);
  assert.equal(restoredThirdNode.height, allBackup.height);
  assert.equal(restoredThirdNode.blockHash, allBackup.blockHash);
  recoveredNode = new NovaNode(recoveredHome, { quiet: true });
  await recoveredNode.start();
  await waitFor(async () => {
    try {
      return (await fetch(`${network.nodes[2].url}/health`)).ok;
    } catch {
      return false;
    }
  }, "replacement validator reachability", 3000);
  const recoveredDiagnosis = await diagnoseRemoteDeployment({
    directory: network.directory,
    timeoutMs: 1000,
  });
  assert.equal(recoveredDiagnosis.healthy, true);
  assert.equal(
    recoveredDiagnosis.onlineValidators,
    3,
    JSON.stringify(recoveredDiagnosis.nodes.map(({ name, valid, error }) => ({ name, valid, error }))),
  );
  assert.equal(recoveredDiagnosis.nodes[2].status.blockHash, allBackup.blockHash);
  await recoveredNode.stop();
  const quorumDiagnosis = await diagnoseRemoteDeployment({
    directory: network.directory,
    timeoutMs: 500,
  });
  assert.equal(quorumDiagnosis.healthy, true);
  assert.equal(quorumDiagnosis.operational, true);
  assert.equal(quorumDiagnosis.onlineValidators, 2);
  assert.equal(quorumDiagnosis.summary.warnings, 1);
  assert.equal(quorumDiagnosis.nodes[2].reachable, false);
  assert.equal(quorumDiagnosis.nodes[2].securityFailure, false);

  const quorumBackupFile = resolve(root, "backups", "one-offline.json");
  const quorumBackup = await createRemoteNetworkBackup({
    directory: network.directory,
    output: quorumBackupFile,
    timeoutMs: 500,
  });
  assert.equal(quorumBackup.observedValidators, 2);
  assert.equal(quorumBackup.unavailableValidators, 1);
  assert.equal(verifyBackup(readJson(quorumBackupFile)).blockHash, quorumBackup.blockHash);

  await nodes[1].stop();
  const minorityDiagnosis = await diagnoseRemoteDeployment({
    directory: network.directory,
    timeoutMs: 500,
  });
  assert.equal(minorityDiagnosis.healthy, false);
  assert.equal(minorityDiagnosis.operational, false);
  assert.equal(minorityDiagnosis.onlineValidators, 1);
  await assert.rejects(
    createRemoteNetworkBackup({
      directory: network.directory,
      output: resolve(root, "backups", "minority.json"),
      timeoutMs: 500,
    }),
    /requires authenticated validator quorum/,
  );

  const thirdValidatorKey = decryptKeyRecord(
    readJson(resolve(network.nodes[2].home, "node-key.json")),
    PASSWORDS.NOVA_REMOTE_NODE3_PASSWORD,
  );
  let fakeMode = "incomplete-chain";
  fakeServer = createServer((request, response) => {
    const url = new URL(request.url, network.nodes[2].url);
    let payload;
    if (url.pathname === "/status/signed") {
      payload = fakeMode === "invalid-status"
        ? { forged: true }
        : createSignedStatus({
          status: nodes[2].status(),
          key: thirdValidatorKey,
          challenge: url.searchParams.get("challenge"),
        });
    } else if (url.pathname === "/blocks") {
      payload = { blocks: [] };
    } else {
      response.statusCode = 404;
      payload = { error: "not found" };
    }
    const body = JSON.stringify(payload);
    response.writeHead(response.statusCode || 200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise((resolveListen, rejectListen) => {
    fakeServer.once("error", rejectListen);
    fakeServer.listen(basePort + 2, "127.0.0.1", resolveListen);
  });

  const untrustedChainDiagnosis = await diagnoseRemoteDeployment({
    directory: network.directory,
    timeoutMs: 500,
  });
  assert.equal(untrustedChainDiagnosis.healthy, true);
  assert.equal(untrustedChainDiagnosis.operational, true);
  assert.equal(untrustedChainDiagnosis.onlineValidators, 2);
  await assert.rejects(
    createRemoteNetworkBackup({
      directory: network.directory,
      output: resolve(root, "backups", "incomplete-chain.json"),
      timeoutMs: 500,
    }),
    /only 1 complete remote chains passed verification; quorum is 2/,
  );

  fakeMode = "invalid-status";
  const forgedDiagnosis = await diagnoseRemoteDeployment({
    directory: network.directory,
    timeoutMs: 500,
  });
  assert.equal(forgedDiagnosis.healthy, false);
  assert.equal(forgedDiagnosis.nodes[2].reachable, true);
  assert.equal(forgedDiagnosis.nodes[2].valid, false);
  assert.equal(forgedDiagnosis.nodes[2].securityFailure, true);
  await assert.rejects(
    createRemoteNetworkBackup({
      directory: network.directory,
      output: resolve(root, "backups", "forged-status.json"),
      timeoutMs: 500,
    }),
    /invalid signed status/,
  );
});
