import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/core/canonical.js";
import { generateKeyRecord } from "../src/core/crypto.js";
import { createPeerAuthHeaders } from "../src/core/peer-auth.js";
import { createRecord, createTransfer } from "../src/core/transaction.js";
import { NovaNode } from "../src/node.js";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { atomicWriteJson, readJson } from "../src/runtime/files.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

test("three validators finalize and replicate a signed transfer", { timeout: 25000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-network-test-"));
  const basePort = 20000 + Math.floor(Math.random() * 20000);
  const network = initializeDevnet({ directory: root, basePort, blockTimeMs: 800 });
  for (const { home } of network.nodes) {
    const configPath = join(home, "config.json");
    const config = readJson(configPath);
    assert.equal(Object.hasOwn(config, "emptyBlockIntervalMs"), false);
    // A v0.19 node config may still contain this field. v0.20 must ignore it
    // instead of rewriting an owner's existing network files.
    atomicWriteJson(configPath, { ...config, emptyBlockIntervalMs: 100 });
  }
  const nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true }));
  t.after(async () => {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    rmSync(root, { recursive: true, force: true });
  });

  await Promise.all(nodes.map((node) => node.start()));
  await delay(network.genesis.blockTimeMs * 3);
  assert.ok(
    nodes.every((node) => node.status().height === 0),
    "idle nodes should not produce blocks even after multiple legacy empty-block intervals",
  );
  assert.ok(nodes.every((node) => node.status().peerAuthentication === "ed25519-v1"));

  const faucet = readJson(network.faucet.keyFile);
  const recipient = generateKeyRecord("recipient");
  const transaction = createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "42000000",
    fee: "7",
    nonce: 1,
    memo: "network integration test",
  });
  const peerUrl = `${network.nodes[1].url}/transactions?gossip=0`;
  const transactionBody = JSON.stringify(transaction);
  const peerHeaders = createPeerAuthHeaders({
    chainId: network.genesis.chainId,
    key: nodes[0].key,
    recipient: nodes[1].key.address,
    method: "POST",
    url: peerUrl,
    body: transactionBody,
  });
  const peerAcceptedResponse = await fetch(peerUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...peerHeaders },
    body: transactionBody,
  });
  assert.equal(peerAcceptedResponse.status, 202);
  const replayedResponse = await fetch(peerUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...peerHeaders },
    body: transactionBody,
  });
  assert.equal(replayedResponse.status, 401);
  assert.match((await replayedResponse.json()).error, /already received/);
  const relayedResponse = await fetch(`${network.nodes[2].url}/transactions?gossip=0`, {
    method: "POST",
    headers: { "content-type": "application/json", ...peerHeaders },
    body: transactionBody,
  });
  assert.equal(relayedResponse.status, 401);
  assert.match((await relayedResponse.json()).error, /signature is invalid/);

  for (const internalPath of ["/proposals", "/proposals/recover", "/blocks"]) {
    const unauthenticated = await fetch(`${network.nodes[1].url}${internalPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthenticated.status, 401);
  }
  const unauthenticatedGossip = await fetch(`${network.nodes[2].url}/transactions?gossip=0`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: transactionBody,
  });
  assert.equal(unauthenticatedGossip.status, 401);

  const response = await fetch(`${network.nodes[0].url}/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction),
  });
  if (response.status === 202) {
    const accepted = await response.json();
    assert.equal(accepted.status, "pending");
    assert.equal(accepted.final, false);
  } else {
    assert.equal(response.status, 400);
    await response.json();
    assert.equal(nodes[0].transactionReceipt(transaction.id).status, "committed");
  }

  await waitFor(
    () => nodes.every((node) => node.storage.state.balances[recipient.address] === "42000000"),
    "transaction replication",
  );
  assert.ok(nodes.every((node) => node.storage.chain.some((block) => block.transactions.some(({ id }) => id === transaction.id))));
  assert.ok(nodes.every((node) => node.storage.state.burnedFees === "7"));
  const transferHeight = nodes[0].status().height;
  await delay(network.genesis.blockTimeMs * 3);
  assert.ok(
    nodes.every((node) => node.status().height === transferHeight),
    "an idle finalized chain should remain at the same height",
  );

  const receiptResponse = await fetch(`${network.nodes[2].url}/transactions/${transaction.id}`);
  assert.equal(receiptResponse.status, 200);
  const receipt = await receiptResponse.json();
  assert.equal(receipt.status, "committed");
  assert.equal(receipt.final, true);
  assert.equal(receipt.transactionId, transaction.id);
  assert.ok(receipt.height >= 1);
  assert.match(receipt.blockHash, /^[0-9a-f]{64}$/);

  const overviewResponse = await fetch(`${network.nodes[1].url}/overview`, {
    headers: { origin: "http://127.0.0.1:3100" },
  });
  assert.equal(overviewResponse.headers.get("access-control-allow-origin"), "http://127.0.0.1:3100");
  const overview = await overviewResponse.json();
  assert.equal(overview.totalTransactions, 1);
  assert.equal(overview.totalSupply, "999999999993");
  assert.equal(overview.burnedFees, "7");
  assert.equal(overview.validatorSet.length, 3);

  const recentResponse = await fetch(`${network.nodes[1].url}/transactions?limit=10&address=${recipient.address}`);
  const recent = await recentResponse.json();
  assert.equal(recent.transactions.length, 1);
  assert.equal(recent.transactions[0].transactionId, transaction.id);

  const blockResponse = await fetch(`${network.nodes[1].url}/blocks/${receipt.height}`);
  const blockResult = await blockResponse.json();
  assert.equal(blockResult.block.hash, receipt.blockHash);

  const remoteOriginResponse = await fetch(`${network.nodes[1].url}/overview`, {
    headers: { origin: "https://example.com" },
  });
  assert.equal(remoteOriginResponse.headers.get("access-control-allow-origin"), null);

  const recordContents = "NOVA record integration fixture";
  const record = createRecord({
    chainId: network.genesis.chainId,
    key: faucet,
    contentHash: sha256(recordContents),
    contentSize: Buffer.byteLength(recordContents),
    title: "Integration proof",
    category: "test-document",
    note: "The source text stays outside the chain",
    fee: "3",
    nonce: 2,
  });
  const recordResponse = await fetch(`${network.nodes[0].url}/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
  });
  assert.equal(recordResponse.status, 202);
  await waitFor(
    () => nodes.every((node) => node.transactionReceipt(record.id).final),
    "record replication",
  );

  const recordsResponse = await fetch(
    `${network.nodes[2].url}/records?hash=${record.contentHash}&owner=${faucet.address}&category=test-document`,
  );
  assert.equal(recordsResponse.status, 200);
  const recordsResult = await recordsResponse.json();
  assert.equal(recordsResult.records.length, 1);
  assert.equal(recordsResult.records[0].transactionId, record.id);
  assert.equal(recordsResult.records[0].transaction.contentSize, Buffer.byteLength(recordContents));

  const recordReceiptResponse = await fetch(`${network.nodes[1].url}/records/${record.id}`);
  assert.equal(recordReceiptResponse.status, 200);
  const recordReceipt = await recordReceiptResponse.json();
  assert.equal(recordReceipt.final, true);
  assert.equal(recordReceipt.transaction.type, "record");

  const recordOverviewResponse = await fetch(`${network.nodes[1].url}/overview`);
  const recordOverview = await recordOverviewResponse.json();
  assert.equal(recordOverview.totalTransactions, 2);
  assert.equal(recordOverview.totalRecords, 1);
  assert.equal(recordOverview.burnedFees, "10");
  assert.equal(recordOverview.totalSupply, "999999999990");
});
